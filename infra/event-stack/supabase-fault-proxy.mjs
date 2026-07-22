import http from "node:http";
import https from "node:https";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const READ_ONLY_REST_PATHS = new Set(["/rest/v1/events", "/rest/v1/courts", "/rest/v1/overlay_states"]);

export class SupabaseFaultProxy {
  constructor({ upstream, generationId, pathPrefix = "/", host = "127.0.0.1", port = 0, requestTimeoutMs = 30_000, now = () => new Date() }) {
    this.upstream = validateUpstream(upstream);
    this.generationId = validateGeneration(generationId);
    this.pathPrefix = validatePathPrefix(pathPrefix, this.generationId);
    if (!isLoopback(host)) throw new Error("Supabase fault proxy must listen on loopback");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Supabase fault proxy port is invalid");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) throw new Error("Supabase fault proxy timeout is invalid");
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = now;
    this.server = null;
    this.status = "STOPPED";
    this.startedAt = null;
    this.faultedAt = null;
    this.restoredAt = null;
    this.closedAt = null;
    this.httpRequestsForwarded = 0;
    this.webSocketsForwarded = 0;
    this.requestsRejectedDuringFault = 0;
    this.upstreamErrors = 0;
    this.faultCount = 0;
    this.restoreCount = 0;
    this.inflightHttp = new Set();
    this.pendingUpgrades = new Map();
    this.activeWebSockets = new Set();
  }

  async start() {
    if (this.server) throw new Error("Supabase fault proxy is already started");
    const server = http.createServer((req, res) => this.#handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.status = "HEALTHY";
    this.startedAt = timestamp(this.now);
    return this.snapshot();
  }

  fault(confirmation) {
    this.#requireRunning();
    requireConfirmation(confirmation, `FAULT-SUPABASE:${this.generationId}`);
    if (this.status === "FAULTED") return this.snapshot();
    this.status = "FAULTED";
    this.faultedAt = timestamp(this.now);
    this.faultCount += 1;
    for (const request of this.inflightHttp) request.destroy(new Error("isolated Supabase fault injected"));
    for (const [request, socket] of this.pendingUpgrades) {
      request.destroy(new Error("isolated Supabase fault injected"));
      socket.destroy();
    }
    for (const pair of this.activeWebSockets) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    return this.snapshot();
  }

  restore(confirmation) {
    this.#requireRunning();
    requireConfirmation(confirmation, `RESTORE-SUPABASE:${this.generationId}`);
    if (this.status === "HEALTHY") return this.snapshot();
    this.status = "HEALTHY";
    this.restoredAt = timestamp(this.now);
    this.restoreCount += 1;
    return this.snapshot();
  }

  async close() {
    if (!this.server) return this.snapshot();
    for (const request of this.inflightHttp) request.destroy();
    for (const [request, socket] of this.pendingUpgrades) {
      request.destroy();
      socket.destroy();
    }
    for (const pair of this.activeWebSockets) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.status = "STOPPED";
    this.closedAt = timestamp(this.now);
    return this.snapshot();
  }

  origin() {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Supabase fault proxy is not listening");
    const hostname = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${hostname}:${address.port}`;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      generationId: this.generationId,
      status: this.status,
      upstream: {
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: effectivePort(this.upstream)
      },
      origin: this.server ? this.origin() : null,
      pathPrefix: this.pathPrefix,
      startedAt: this.startedAt,
      faultedAt: this.faultedAt,
      restoredAt: this.restoredAt,
      closedAt: this.closedAt,
      counters: {
        httpRequestsForwarded: this.httpRequestsForwarded,
        webSocketsForwarded: this.webSocketsForwarded,
        requestsRejectedDuringFault: this.requestsRejectedDuringFault,
        upstreamErrors: this.upstreamErrors,
        faultCount: this.faultCount,
        restoreCount: this.restoreCount,
        activeHttpRequests: this.inflightHttp.size,
        pendingWebSocketUpgrades: this.pendingUpgrades.size,
        activeWebSockets: this.activeWebSockets.size
      }
    };
  }

  #requireRunning() {
    if (!this.server || !new Set(["HEALTHY", "FAULTED"]).has(this.status)) throw new Error("Supabase fault proxy is not running");
  }

  #handleHttp(req, res) {
    const target = upstreamRequestTarget(req.url, this.pathPrefix);
    if (target === "INVALID") return rejectBadTarget(res);
    if (target === null) return rejectWrongPrefix(res);
    if (target !== "/__healthz" && !allowedRestTarget(target)) return rejectWrongPrefix(res);
    if (!READ_ONLY_HTTP_METHODS.has(String(req.method).toUpperCase())) return rejectMethod(res);
    if (target === "/__healthz") return writeHealth(res, this.status);
    if (this.status === "FAULTED") {
      this.requestsRejectedDuringFault += 1;
      return rejectFaulted(res);
    }
    if (this.status !== "HEALTHY") return rejectUnavailable(res);

    const transport = this.upstream.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: effectivePort(this.upstream),
      method: req.method,
      path: target,
      headers: forwardedHeaders(req.headers, this.upstream.host, false),
      timeout: this.requestTimeoutMs
    }, (upstreamResponse) => {
      const cleanup = () => this.inflightHttp.delete(request);
      upstreamResponse.once("end", cleanup);
      upstreamResponse.once("close", cleanup);
      const headers = responseHeaders(upstreamResponse.headers, false);
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
      upstreamResponse.pipe(res);
    });
    this.httpRequestsForwarded += 1;
    this.inflightHttp.add(request);
    request.once("timeout", () => request.destroy(new Error("Supabase upstream request timed out")));
    request.once("error", (error) => {
      this.inflightHttp.delete(request);
      this.upstreamErrors += 1;
      writeProxyError(res, error);
    });
    req.once("aborted", () => request.destroy());
    req.pipe(request);
  }

  #handleUpgrade(req, socket, head) {
    const target = upstreamRequestTarget(req.url, this.pathPrefix);
    if (target === "INVALID") return rejectSocket(socket, 400, "Bad Request");
    if (target === null || target === "/__healthz") return rejectSocket(socket, 404, "Not Found");
    if (!exactPathOrQuery(target, "/realtime/v1/websocket")) return rejectSocket(socket, 404, "Not Found");
    if (String(req.method).toUpperCase() !== "GET") return rejectSocket(socket, 405, "Read-only proxy");
    if (this.status === "FAULTED") {
      this.requestsRejectedDuringFault += 1;
      return rejectSocket(socket, 503, "Isolated Supabase dependency unavailable");
    }
    if (this.status !== "HEALTHY") return rejectSocket(socket, 503, "Supabase fault proxy unavailable");

    const transport = this.upstream.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: effectivePort(this.upstream),
      method: req.method,
      path: target,
      headers: forwardedHeaders(req.headers, this.upstream.host, true),
      timeout: this.requestTimeoutMs
    });
    this.pendingUpgrades.set(request, socket);
    request.once("timeout", () => request.destroy(new Error("Supabase upstream WebSocket timed out")));
    request.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      this.pendingUpgrades.delete(request);
      if (this.status !== "HEALTHY") {
        upstreamSocket.destroy();
        socket.destroy();
        return;
      }
      writeUpgradeResponse(socket, upstreamResponse);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      const pair = { client: socket, upstream: upstreamSocket };
      this.activeWebSockets.add(pair);
      this.webSocketsForwarded += 1;
      const cleanup = () => this.activeWebSockets.delete(pair);
      socket.once("close", cleanup);
      upstreamSocket.once("close", cleanup);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    request.once("response", (upstreamResponse) => {
      this.pendingUpgrades.delete(request);
      writeRawResponse(socket, upstreamResponse);
    });
    request.once("error", (error) => {
      this.pendingUpgrades.delete(request);
      this.upstreamErrors += 1;
      if (!socket.destroyed) rejectSocket(socket, 502, publicErrorCode(error));
    });
    socket.once("close", () => request.destroy());
    request.end();
  }
}

function validateUpstream(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Supabase fault proxy upstream is invalid");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Supabase fault proxy upstream must be an origin without credentials");
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) throw new Error("plaintext Supabase fault proxy upstream must be loopback");
  return parsed;
}

function validateGeneration(value) {
  if (typeof value !== "string" || !GENERATION.test(value)) throw new Error("Supabase fault proxy generation is invalid");
  return value;
}

function validatePathPrefix(value, generationId) {
  if (value === "/") return value;
  const expected = `/_scorecheck-supabase-fault/${generationId}/`;
  if (value !== expected) throw new Error(`Supabase fault proxy path prefix must be exactly ${expected}`);
  return value;
}

function validRequestTarget(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\r\n]/u.test(value);
}

function upstreamRequestTarget(value, pathPrefix) {
  if (!validRequestTarget(value)) return "INVALID";
  if (pathPrefix === "/") return value;
  if (!value.startsWith(pathPrefix)) return null;
  return `/${value.slice(pathPrefix.length)}`;
}

function allowedRestTarget(value) {
  for (const path of READ_ONLY_REST_PATHS) if (exactPathOrQuery(value, path)) return true;
  return false;
}

function exactPathOrQuery(value, path) {
  return value === path || value.startsWith(`${path}?`);
}

function forwardedHeaders(headers, host, preserveUpgrade) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    const requiredUpgradeHeader = preserveUpgrade && (normalized === "connection" || normalized === "upgrade");
    if (normalized === "host" || (HOP_BY_HOP_HEADERS.has(normalized) && !requiredUpgradeHeader) || normalized.startsWith("proxy-")) continue;
    if (value !== undefined) result[name] = value;
  }
  result.host = host;
  if (preserveUpgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

function responseHeaders(headers, preserveUpgrade) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if ((!preserveUpgrade && HOP_BY_HOP_HEADERS.has(name.toLowerCase())) || value === undefined) continue;
    result[name] = value;
  }
  return result;
}

function writeUpgradeResponse(socket, response) {
  socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`);
  for (let index = 0; index < response.rawHeaders.length; index += 2) socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
  socket.write("\r\n");
}

function writeRawResponse(socket, response) {
  socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\n`);
  for (const [name, value] of Object.entries(responseHeaders(response.headers, false))) {
    for (const entry of Array.isArray(value) ? value : [value]) socket.write(`${name}: ${entry}\r\n`);
  }
  socket.write("Connection: close\r\n\r\n");
  response.pipe(socket);
}

function rejectBadTarget(res) {
  res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
  res.end('{"error":"invalid request target"}');
}

function rejectWrongPrefix(res) {
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end('{"error":"not found"}');
}

function rejectMethod(res) {
  res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store", allow: "GET, HEAD, OPTIONS" });
  res.end('{"error":"read-only proxy"}');
}

function writeHealth(res, status) {
  const healthy = status === "HEALTHY";
  const body = JSON.stringify({ status });
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function rejectFaulted(res) {
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "1" });
  res.end('{"error":"isolated Supabase dependency unavailable"}');
}

function rejectUnavailable(res) {
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
  res.end('{"error":"Supabase fault proxy unavailable"}');
}

function rejectSocket(socket, status, message) {
  if (!socket.writable) return socket.destroy();
  const body = `${message}\n`;
  const reason = status === 400 ? "Bad Request" : status === 404 ? "Not Found" : status === 405 ? "Method Not Allowed" : status === 502 ? "Bad Gateway" : "Service Unavailable";
  const allow = status === 405 ? "Allow: GET\r\n" : "";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n${allow}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function writeProxyError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy(error);
  const body = JSON.stringify({ error: publicErrorCode(error) });
  res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function publicErrorCode(error) {
  if (error?.message === "isolated Supabase fault injected") return "isolated-upstream-interrupted";
  if (error?.code === "ETIMEDOUT") return "upstream-timeout";
  return "upstream-unavailable";
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function effectivePort(url) {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isLoopback(value) {
  return new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(value);
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Supabase fault proxy clock is invalid");
  return date.toISOString();
}
