import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SupabaseFaultProxy } from "./supabase-fault-proxy.mjs";

const generationId = "generation-supabase-12345678";

test("forwards Supabase HTTP without retaining request secrets or targets", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { "content-type": "application/json", etag: 'W/"overlay-1"' });
    res.end(JSON.stringify({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers.apikey,
      body: Buffer.concat(chunks).toString("utf8")
    }));
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => closeServer(upstream));
  const proxy = new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId });
  await proxy.start();
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.origin()}/rest/v1/overlay_states?court_number=eq.1`, {
    method: "POST",
    headers: {
      authorization: "Bearer service-role-secret",
      apikey: "anonymous-key-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({ score: "21-19" })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), 'W/"overlay-1"');
  assert.deepEqual(await response.json(), {
    method: "POST",
    path: "/rest/v1/overlay_states?court_number=eq.1",
    authorization: "Bearer service-role-secret",
    apiKey: "anonymous-key-secret",
    body: '{"score":"21-19"}'
  });

  const evidence = JSON.stringify(proxy.snapshot());
  assert.doesNotMatch(evidence, /service-role-secret|anonymous-key-secret|overlay_states|court_number|21-19/u);
  assert.equal(proxy.snapshot().counters.httpRequestsForwarded, 1);
  assert.equal(proxy.snapshot().counters.activeHttpRequests, 0);
});

test("fault drains HTTP and Realtime together, rejects new work, and restores idempotently", async (t) => {
  const heldResponses = new Set();
  const upstream = http.createServer((req, res) => {
    if (req.url === "/slow") {
      heldResponses.add(res);
      res.once("close", () => heldResponses.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"healthy":true}');
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => {
    for (const response of heldResponses) response.destroy();
    return closeServer(upstream);
  });
  const proxy = new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId });
  await proxy.start();
  t.after(() => proxy.close());

  const slow = fetch(`${proxy.origin()}/slow`);
  await waitFor(() => proxy.snapshot().counters.activeHttpRequests === 1);
  const websocket = await openUpgrade(proxy.origin(), "/realtime/v1/websocket?apikey=browser-secret");
  assert.equal(proxy.snapshot().counters.activeWebSockets, 1);
  const websocketClosed = once(websocket, "close");

  assert.throws(() => proxy.fault("yes"), /confirmation must be exactly/u);
  const faulted = proxy.fault(`FAULT-SUPABASE:${generationId}`);
  assert.equal(faulted.status, "FAULTED");
  assert.equal(faulted.counters.faultCount, 1);
  await websocketClosed;
  const interrupted = await slow;
  assert.equal(interrupted.status, 502);
  assert.deepEqual(await interrupted.json(), { error: "isolated-upstream-interrupted" });

  const rejectedHttp = await fetch(`${proxy.origin()}/rest/v1/overlay_states`);
  assert.equal(rejectedHttp.status, 503);
  const rejectedUpgrade = await openRejectedUpgrade(proxy.origin(), "/realtime/v1/websocket");
  assert.match(rejectedUpgrade, /^HTTP\/1\.1 503 /u);
  assert.equal(proxy.snapshot().counters.requestsRejectedDuringFault, 2);
  assert.equal(proxy.fault(`FAULT-SUPABASE:${generationId}`).counters.faultCount, 1);

  assert.throws(() => proxy.restore("restore"), /confirmation must be exactly/u);
  const restored = proxy.restore(`RESTORE-SUPABASE:${generationId}`);
  assert.equal(restored.status, "HEALTHY");
  assert.equal(restored.counters.restoreCount, 1);
  const recoveredResponse = await fetch(`${proxy.origin()}/rest/v1/overlay_states`);
  assert.equal(recoveredResponse.status, 200);
  assert.equal(proxy.restore(`RESTORE-SUPABASE:${generationId}`).counters.restoreCount, 1);
  await proxy.close();
  for (const response of heldResponses) response.destroy();
  await closeServer(upstream);
});

test("rejects an open proxy target and unsafe listener or upstream contracts", async (t) => {
  const upstream = http.createServer((_req, res) => res.end("unexpected"));
  const upstreamOrigin = await listen(upstream);
  t.after(() => closeServer(upstream));
  const proxy = new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId });
  await proxy.start();
  t.after(() => proxy.close());

  const response = await rawRequest(proxy.origin(), "GET https://example.com/rest/v1/private HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 400 /u);
  assert.equal(proxy.snapshot().counters.httpRequestsForwarded, 0);
  assert.throws(() => new SupabaseFaultProxy({ upstream: "http://example.com", generationId }), /plaintext.*loopback/u);
  assert.throws(() => new SupabaseFaultProxy({ upstream: "https://user:secret@example.supabase.co", generationId }), /without credentials/u);
  assert.throws(() => new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId: "short" }), /generation is invalid/u);
  assert.throws(() => new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId, host: "0.0.0.0" }), /listen on loopback/u);
  assert.throws(() => new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId, pathPrefix: "/wrong/" }), /path prefix must be exactly/u);
});

test("generation path strips only its exact prefix and exposes bounded health", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => closeServer(upstream));
  const pathPrefix = `/_scorecheck-supabase-fault/${generationId}/`;
  const proxy = new SupabaseFaultProxy({ upstream: upstreamOrigin, generationId, pathPrefix });
  await proxy.start();
  t.after(() => proxy.close());

  const health = await fetch(`${proxy.origin()}${pathPrefix}__healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "HEALTHY" });
  const forwarded = await fetch(`${proxy.origin()}${pathPrefix}rest/v1/overlay_states?court=eq.1`);
  assert.equal(forwarded.status, 200);
  assert.deepEqual(seen, ["/rest/v1/overlay_states?court=eq.1"]);
  assert.equal((await fetch(`${proxy.origin()}/rest/v1/overlay_states`)).status, 404);

  proxy.fault(`FAULT-SUPABASE:${generationId}`);
  const faultedHealth = await fetch(`${proxy.origin()}${pathPrefix}__healthz`);
  assert.equal(faultedHealth.status, 503);
  assert.deepEqual(await faultedHealth.json(), { status: "FAULTED" });
  assert.equal(proxy.snapshot().counters.requestsRejectedDuringFault, 0);
});

async function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.testSockets = sockets;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  for (const socket of server.testSockets ?? []) socket.destroy();
  server.closeAllConnections?.();
  await closed;
}

async function openUpgrade(origin, path) {
  const socket = await connectedSocket(origin);
  socket.write(upgradeRequest(path));
  const response = await readUntil(socket, "\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 101 /u);
  return socket;
}

async function openRejectedUpgrade(origin, path) {
  const socket = await connectedSocket(origin);
  socket.write(upgradeRequest(path));
  return readUntil(socket, "\r\n\r\n");
}

async function rawRequest(origin, request) {
  const socket = await connectedSocket(origin);
  socket.write(request);
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}

async function connectedSocket(origin) {
  const url = new URL(origin);
  const socket = net.connect(Number(url.port), url.hostname);
  await once(socket, "connect");
  return socket;
}

function upgradeRequest(path) {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n`;
}

async function readUntil(socket, marker) {
  let value = "";
  while (!value.includes(marker)) {
    const [chunk] = await once(socket, "data");
    value += chunk.toString("utf8");
  }
  return value;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("condition was not observed");
}
