import { isIP } from "node:net";

const ACCEPTED = /^Accepted ([A-Za-z0-9-]+) for ([A-Za-z0-9._-]+) from ([0-9A-Fa-f:.]+) port [0-9]+ ssh2(?:: (.+))?$/u;
const SESSION = /^Starting session: (command|shell(?: on [^ ]+)?|subsystem [^ ]+) for ([A-Za-z0-9._-]+) from ([0-9A-Fa-f:.]+) port [0-9]+/u;

export function sshSessionAuditCommand(startedAt, endedAt) {
  const startSeconds = journalEpoch(startedAt, "SSH audit start");
  const endSeconds = journalEpoch(endedAt, "SSH audit end");
  if (endSeconds <= startSeconds) throw new Error("SSH audit window must end after it starts");
  return "journalctl --quiet --unit=ssh.service --since=@" + startSeconds
    + " --until=@" + endSeconds
    + " --no-pager --output=json --grep='^(Accepted|Starting session:)'";
}

export function evaluateSshSessionAudit({
  host,
  startedAt,
  endedAt,
  stdout,
  adminAddresses,
  bastionAddresses = []
}) {
  if (typeof host !== "string" || !host) throw new Error("SSH audit host is required");
  const admins = normalizedAddresses(adminAddresses, "admin");
  const bastions = normalizedAddresses(bastionAddresses, "bastion");
  const allowed = new Set([...admins, ...bastions]);
  const sources = new Map();
  const problems = [];
  let malformedRecords = 0;
  let acceptedKeys = 0;
  let interactiveShells = 0;
  let commandSessions = 0;
  let subsystemSessions = 0;

  for (const line of String(stdout ?? "").split(/\r?\n/u).filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedRecords += 1;
      continue;
    }
    const message = typeof record.MESSAGE === "string" ? record.MESSAGE : "";
    const observedAt = journalTimestamp(record.__REALTIME_TIMESTAMP);
    const accepted = ACCEPTED.exec(message);
    if (accepted) {
      const [, method, user, rawSource, keyIdentity = null] = accepted;
      const source = rawSource.toLowerCase();
      const summary = sourceSummary(sources, source);
      summary.accepted += 1;
      summary.firstAt = earlier(summary.firstAt, observedAt);
      summary.lastAt = later(summary.lastAt, observedAt);
      summary.methods.add(method);
      if (keyIdentity) summary.keyIdentities.add(keyIdentity.slice(0, 200));
      acceptedKeys += 1;
      if (method !== "publickey") problems.push(host + " accepted disallowed SSH method " + method);
      if (user !== "root") problems.push(host + " accepted unexpected SSH user " + user);
      if (!allowed.has(source)) problems.push(host + " accepted SSH from unapproved source " + source);
      continue;
    }
    const session = SESSION.exec(message);
    if (session) {
      const [, kind, user, rawSource] = session;
      const source = rawSource.toLowerCase();
      const summary = sourceSummary(sources, source);
      summary.firstAt = earlier(summary.firstAt, observedAt);
      summary.lastAt = later(summary.lastAt, observedAt);
      if (kind.startsWith("shell")) {
        summary.interactiveShells += 1;
        interactiveShells += 1;
        if (!admins.has(source)) problems.push(host + " opened an interactive SSH shell from non-admin source " + source);
      } else if (kind === "command") {
        summary.commandSessions += 1;
        commandSessions += 1;
      } else {
        summary.subsystemSessions += 1;
        subsystemSessions += 1;
      }
      if (user !== "root") problems.push(host + " started an unexpected SSH session for " + user);
      if (!allowed.has(source)) problems.push(host + " started SSH from unapproved source " + source);
      continue;
    }
    malformedRecords += 1;
  }

  if (malformedRecords > 0) problems.push(host + " SSH audit contained " + malformedRecords + " malformed journal record(s)");
  if (acceptedKeys === 0) problems.push(host + " SSH audit contained no accepted-key records");
  const inventory = [...sources.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([address, value]) => ({
    address,
    approvedAs: admins.has(address) ? "admin" : bastions.has(address) ? "bastion" : "unapproved",
    accepted: value.accepted,
    commandSessions: value.commandSessions,
    interactiveShells: value.interactiveShells,
    subsystemSessions: value.subsystemSessions,
    methods: [...value.methods].sort(),
    keyIdentities: [...value.keyIdentities].sort(),
    firstAt: value.firstAt,
    lastAt: value.lastAt
  }));
  return {
    schemaVersion: 1,
    status: problems.length ? "unhealthy" : "healthy",
    host,
    startedAt,
    endedAt,
    acceptedKeys,
    commandSessions,
    interactiveShells,
    subsystemSessions,
    sources: inventory,
    problems: [...new Set(problems)]
  };
}

function sourceSummary(sources, address) {
  if (!sources.has(address)) {
    sources.set(address, {
      accepted: 0,
      commandSessions: 0,
      interactiveShells: 0,
      subsystemSessions: 0,
      methods: new Set(),
      keyIdentities: new Set(),
      firstAt: null,
      lastAt: null
    });
  }
  return sources.get(address);
}

function normalizedAddresses(value, label) {
  if (!Array.isArray(value)) throw new Error("SSH audit " + label + " addresses must be an array");
  const output = new Set();
  for (const address of value) {
    if (typeof address !== "string" || isIP(address) === 0) throw new Error("SSH audit " + label + " address is invalid");
    output.add(address.toLowerCase());
  }
  return output;
}

function journalEpoch(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(label + " is invalid");
  return Math.floor(milliseconds / 1_000);
}

function journalTimestamp(value) {
  const microseconds = Number(value);
  if (!Number.isSafeInteger(microseconds) || microseconds < 1) return null;
  return new Date(Math.floor(microseconds / 1_000)).toISOString();
}

function earlier(current, candidate) {
  if (candidate === null) return current;
  return current === null || candidate < current ? candidate : current;
}

function later(current, candidate) {
  if (candidate === null) return current;
  return current === null || candidate > current ? candidate : current;
}
