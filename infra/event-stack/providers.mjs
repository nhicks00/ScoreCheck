#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { firewallPayload, networkContractProblems, validateNetworkContract } from "./network-contract.mjs";

const DEFAULT_DO_API = "https://api.digitalocean.com/v2";
const DEFAULT_VERCEL_API = "https://api.vercel.com";

export class DigitalOceanProvider {
  constructor({ token, sshKeys, cloudInitPaths, apiBase = DEFAULT_DO_API, fetchImpl = globalThis.fetch, pollIntervalMs = 5_000, timeoutMs = 15 * 60_000 }) {
    if (!token) throw new Error("DIGITALOCEAN_TOKEN is required");
    if (!Array.isArray(sshKeys)) throw new Error("DigitalOcean SSH keys must be an array");
    this.token = token;
    this.sshKeys = sshKeys;
    this.cloudInitPaths = cloudInitPaths;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
  }

  async getAccount() {
    const payload = await this.#request("GET", "/account");
    return {
      uuid: payload.account?.uuid == null ? null : String(payload.account.uuid),
      status: String(payload.account?.status ?? "unknown"),
      dropletLimit: Number(payload.account?.droplet_limit)
    };
  }

  async findDropletsByName(name) {
    return (await this.#listCollection("/droplets", "droplets")).map(normalizeDroplet).filter((entry) => entry.name === name);
  }

  async listAllDroplets() {
    return (await this.#listCollection("/droplets", "droplets")).map(normalizeDroplet);
  }

  async listDropletsByTag(tag) {
    return (await this.#listCollection(`/droplets?tag_name=${encodeURIComponent(tag)}`, "droplets")).map(normalizeDroplet);
  }

  async listDropletsByEvent(event) {
    const tag = encodeURIComponent(`scorecheck-event:${event}`);
    return (await this.#listCollection(`/droplets?tag_name=${tag}`, "droplets")).map(normalizeDroplet);
  }

  async listVpcs() {
    return (await this.#listCollection("/vpcs", "vpcs")).map(normalizeVpc);
  }

  async listFirewalls() {
    return (await this.#listCollection("/firewalls", "firewalls")).map(normalizeFirewall);
  }

  async verifyNetworkContract(contractInput) {
    const contract = validateNetworkContract(contractInput);
    const [vpcs, firewalls] = await Promise.all([this.listVpcs(), this.listFirewalls()]);
    const inventory = { vpcs, firewalls };
    const problems = networkContractProblems(contract, inventory);
    return { healthy: problems.length === 0, problems, inventory };
  }

  async applyNetworkContract(contractInput) {
    const contract = validateNetworkContract(contractInput);
    const vpcs = await this.listVpcs();
    const vpc = vpcs.find((entry) => entry.uuid === contract.vpcUuid);
    if (!vpc) throw new Error("the pinned DigitalOcean VPC is missing; refusing firewall changes");
    if (vpc.region !== contract.region || vpc.ipRange !== contract.vpcCidr) {
      throw new Error("the pinned DigitalOcean VPC identity drifted; refusing firewall changes");
    }

    const firewalls = await this.listFirewalls();
    for (const desired of contract.firewalls) {
      const matches = firewalls.filter((entry) => entry.name === desired.name);
      if (matches.length > 1) throw new Error(`firewall ${desired.name} is duplicated; refusing changes`);
      const payload = firewallPayload(desired);
      if (matches.length === 0) {
        await this.#request("POST", "/firewalls", payload, [200, 201, 202]);
        continue;
      }
      if (!firewallMatchesPayload(matches[0], payload)) {
        await this.#request("PUT", `/firewalls/${encodeURIComponent(matches[0].id)}`, payload, [200, 202]);
      }
    }

    return this.#wait(async () => {
      const verification = await this.verifyNetworkContract(contract);
      return verification.healthy ? verification : null;
    }, "DigitalOcean network contract did not converge after apply");
  }

  async createDroplet(request) {
    if (this.sshKeys.length === 0) throw new Error("at least one DigitalOcean SSH key id or fingerprint is required to create a Droplet");
    const path = this.cloudInitPaths[request.userDataProfile];
    if (!path) throw new Error(`cloud-init path is missing for profile ${request.userDataProfile}`);
    const userData = await readFile(path, "utf8");
    if (sha256(userData) !== request.userDataSha256) throw new Error(`${request.userDataProfile} cloud-init bytes do not match the event manifest`);
    const payload = await this.#request("POST", "/droplets", {
      name: request.name,
      region: request.region,
      ...(request.vpcUuid ? { vpc_uuid: request.vpcUuid } : {}),
      size: request.size,
      image: numericOrString(request.image),
      ssh_keys: this.sshKeys.map(numericOrString),
      backups: false,
      ipv6: false,
      monitoring: false,
      tags: request.tags,
      user_data: userData
    });
    if (!payload.droplet?.id) throw new Error(`DigitalOcean did not return an id for ${request.name}`);
    return normalizeDroplet(payload.droplet);
  }

  async getDroplet(id) {
    const payload = await this.#request("GET", `/droplets/${encodeURIComponent(id)}`);
    return normalizeDroplet(payload.droplet);
  }

  async waitDropletActive(id) {
    return this.#wait(async () => {
      const droplet = await this.getDroplet(id);
      return droplet.status === "active" && droplet.publicIpv4 ? droplet : null;
    }, `Droplet ${id} did not become active with a public IPv4`);
  }

  async waitDropletStatus(id, status) {
    return this.#wait(async () => {
      const droplet = await this.getDroplet(id);
      return droplet.status === status ? droplet : null;
    }, `Droplet ${id} did not reach status ${status}`);
  }

  async deleteDroplet(id) {
    await this.#request("DELETE", `/droplets/${encodeURIComponent(id)}`, undefined, [204]);
  }

  async waitDropletAbsent(id) {
    return this.#wait(async () => {
      try {
        await this.getDroplet(id);
        return null;
      } catch (error) {
        return error?.status === 404 ? true : Promise.reject(error);
      }
    }, `Droplet ${id} still exists after deletion`);
  }

  async getReservedIpv4(ip) {
    const payload = await this.#request("GET", `/reserved_ips/${encodeURIComponent(ip)}`);
    return normalizeReservedIpv4(payload.reserved_ip);
  }

  async listReservedIpv4s() {
    return (await this.#listCollection("/reserved_ips", "reserved_ips")).map(normalizeReservedIpv4);
  }

  async createReservedIpv4(region) {
    const payload = await this.#request("POST", "/reserved_ips", { region });
    return normalizeReservedIpv4(payload.reserved_ip);
  }

  async createReservedIpv4ForDroplet(dropletId) {
    const payload = await this.#request("POST", "/reserved_ips", { droplet_id: Number(dropletId) });
    return normalizeReservedIpv4(payload.reserved_ip);
  }

  async deleteReservedIpv4(ip) {
    await this.#request("DELETE", `/reserved_ips/${encodeURIComponent(ip)}`, undefined, [204]);
  }

  async waitReservedIpv4Absent(ip) {
    return this.#wait(async () => {
      try {
        await this.getReservedIpv4(ip);
        return null;
      } catch (error) {
        return error?.status === 404 ? true : Promise.reject(error);
      }
    }, `reserved IPv4 ${ip} still exists after deletion`);
  }

  async assignReservedIpv4(ip, dropletId) {
    const payload = await this.#request("POST", `/reserved_ips/${encodeURIComponent(ip)}/actions`, {
      type: "assign",
      droplet_id: Number(dropletId)
    });
    return payload.action;
  }

  async unassignReservedIpv4(ip) {
    const payload = await this.#request("POST", `/reserved_ips/${encodeURIComponent(ip)}/actions`, { type: "unassign" });
    return payload.action;
  }

  async waitReservedIpv4Assignment(ip, dropletId) {
    return this.#wait(async () => {
      const address = await this.getReservedIpv4(ip);
      return String(address.dropletId) === String(dropletId) && !address.locked ? address : null;
    }, `reserved IPv4 ${ip} was not assigned to Droplet ${dropletId}`);
  }

  async waitReservedIpv4Unassigned(ip) {
    return this.#wait(async () => {
      const address = await this.getReservedIpv4(ip);
      return address.dropletId === null && !address.locked ? address : null;
    }, `reserved IPv4 ${ip} was not unassigned`);
  }

  async findSnapshotsByName(name) {
    const images = await this.#listCollection("/images?private=true&type=snapshot", "images");
    return images
      .filter((entry) => entry.name === name)
      .map((entry) => ({ id: String(entry.id), name: String(entry.name), regions: entry.regions ?? [] }));
  }

  async powerOffDroplet(id) {
    const payload = await this.#request("POST", `/droplets/${encodeURIComponent(id)}/actions`, { type: "power_off" });
    await this.waitAction(payload.action.id);
  }

  async powerOnDroplet(id) {
    const payload = await this.#request("POST", `/droplets/${encodeURIComponent(id)}/actions`, { type: "power_on" });
    await this.waitAction(payload.action.id);
  }

  async resizeDroplet(id, size) {
    const payload = await this.#request("POST", `/droplets/${encodeURIComponent(id)}/actions`, { type: "resize", size, disk: false });
    await this.waitAction(payload.action.id);
  }

  async snapshotDroplet(id, name) {
    const payload = await this.#request("POST", `/droplets/${encodeURIComponent(id)}/actions`, { type: "snapshot", name });
    await this.waitAction(payload.action.id);
    return this.#wait(async () => {
      const matches = await this.findSnapshotsByName(name);
      if (matches.length > 1) throw new Error(`expected one snapshot named ${name}, found ${matches.length}`);
      return matches[0] ?? null;
    }, `snapshot ${name} did not become visible after action ${payload.action.id}`);
  }

  async deleteImage(id) {
    await this.#request("DELETE", `/images/${encodeURIComponent(id)}`, undefined, [204]);
  }

  async ensureTag(name) {
    const response = await this.fetchImpl(`${this.apiBase}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (response.status === 201) return;
    if (response.status !== 422) throw new Error(`DigitalOcean tag creation failed with HTTP ${response.status}`);
    await this.#request("GET", `/tags/${encodeURIComponent(name)}`);
  }

  async deleteTag(name) {
    await this.#request("DELETE", `/tags/${encodeURIComponent(name)}`, undefined, [204]);
  }

  async tagExists(name) {
    try {
      await this.#request("GET", `/tags/${encodeURIComponent(name)}`);
      return true;
    } catch (error) {
      if (error?.status === 404) return false;
      throw error;
    }
  }

  async waitAction(id) {
    return this.#wait(async () => {
      const payload = await this.#request("GET", `/actions/${encodeURIComponent(id)}`);
      if (payload.action?.status === "errored") throw new Error(`DigitalOcean action ${id} failed`);
      return payload.action?.status === "completed" ? payload.action : null;
    }, `DigitalOcean action ${id} timed out`);
  }

  async #listCollection(path, key) {
    const separator = path.includes("?") ? "&" : "?";
    const first = await this.#request("GET", `${path}${separator}page=1&per_page=200`);
    if (!Array.isArray(first[key])) throw new Error(`DigitalOcean response is missing ${key}`);
    const total = Number(first.meta?.total ?? first[key].length);
    if (!Number.isInteger(total) || total < first[key].length) throw new Error(`DigitalOcean ${key} metadata is invalid`);
    if (first[key].length === total) return first[key];
    const values = [...first[key]];
    for (let page = 2; values.length < total; page += 1) {
      const payload = await this.#request("GET", `${path}${separator}page=${page}&per_page=200`);
      if (!Array.isArray(payload[key]) || payload[key].length === 0) throw new Error(`DigitalOcean ${key} pagination ended early`);
      values.push(...payload[key]);
    }
    if (values.length !== total) throw new Error(`DigitalOcean ${key} response was incomplete`);
    return values;
  }

  async #wait(probe, timeoutMessage) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const value = await probe();
      if (value) return value;
      await delay(this.pollIntervalMs);
    }
    throw new Error(timeoutMessage);
  }

  async #request(method, path, body = undefined, expected = method === "POST" ? [200, 201, 202] : [200]) {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!expected.includes(response.status)) {
      const error = new Error(`DigitalOcean ${method} ${path.split("?")[0]} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }
}

export class VercelDnsProvider {
  constructor({ token, apiBase = DEFAULT_VERCEL_API, teamId = null, fetchImpl = globalThis.fetch, resolver = resolve4, pollIntervalMs = 2_000, timeoutMs = 120_000 }) {
    if (!token) throw new Error("VERCEL_TOKEN is required for event DNS changes");
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.teamId = teamId;
    this.fetchImpl = fetchImpl;
    this.resolver = resolver;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
  }

  async upsertARecord({ zone, hostname, value, ttl, previousChange }) {
    const name = relativeRecordName(zone, hostname);
    const records = await this.#records(zone);
    const conflicts = records.filter((entry) => entry.name === name || entry.name === hostname);
    if (conflicts.length > 1) throw new Error(`DNS ${hostname} has ${conflicts.length} conflicting records`);
    if (previousChange) return this.#applyPreparedChange({ zone, hostname, name, value, ttl, conflicts, change: previousChange });
    if (conflicts.length === 0) {
      const created = await this.#request("POST", `/v2/domains/${encodeURIComponent(zone)}/records`, { name, type: "A", value, ttl }, [200, 201]);
      const record = normalizeVercelRecord(created);
      return { action: "created", recordId: record.id, previous: null };
    }
    const current = normalizeVercelRecord(conflicts[0]);
    if (current.type !== "A") throw new Error(`DNS ${hostname} is ${current.type}, not A`);
    if (previousChange && previousChange.recordId !== current.id) throw new Error(`DNS ${hostname} record identity changed`);
    if (current.value === value && Number(current.ttl) === Number(ttl)) {
      return previousChange ?? { action: "unchanged", recordId: current.id, previous: current };
    }
    await this.#request("PATCH", `/v1/domains/records/${encodeURIComponent(current.id)}`, { name, type: "A", value, ttl }, [200]);
    return previousChange ?? { action: "updated", recordId: current.id, previous: current };
  }

  async #applyPreparedChange({ zone, hostname, name, value, ttl, conflicts, change }) {
    if (!change || !new Set(["created", "updated", "unchanged"]).has(change.action)) {
      throw new Error(`DNS ${hostname} has invalid lifecycle change evidence`);
    }
    const current = conflicts.length === 1 ? normalizeVercelRecord(conflicts[0]) : null;
    const isTarget = current?.type === "A" && current.value === value && Number(current.ttl) === Number(ttl);
    if (change.action === "created") {
      if (current) {
        if (!isTarget || (change.recordId && change.recordId !== current.id)) throw new Error(`DNS ${hostname} changed outside lifecycle control`);
        return { action: "created", recordId: current.id, previous: null };
      }
      const created = normalizeVercelRecord(await this.#request("POST", `/v2/domains/${encodeURIComponent(zone)}/records`, {
        name,
        type: "A",
        value,
        ttl
      }, [200, 201]));
      return { action: "created", recordId: created.id, previous: null };
    }
    if (!current || current.id !== change.recordId || !change.previous) throw new Error(`DNS ${hostname} changed outside lifecycle control`);
    const previous = normalizeVercelRecord(change.previous);
    if (previous.id !== current.id) throw new Error(`DNS ${hostname} restoration identity changed`);
    if (change.action === "unchanged") {
      if (!isTarget || previous.value !== value || Number(previous.ttl) !== Number(ttl)) throw new Error(`DNS ${hostname} changed outside lifecycle control`);
      return change;
    }
    const isPrevious = current.type === previous.type && current.value === previous.value && Number(current.ttl) === Number(previous.ttl);
    if (!isTarget && !isPrevious) throw new Error(`DNS ${hostname} changed outside lifecycle control`);
    if (!isTarget) {
      await this.#request("PATCH", `/v1/domains/records/${encodeURIComponent(current.id)}`, { name, type: "A", value, ttl }, [200]);
    }
    return change;
  }

  async inspectHostname({ zone, hostname }) {
    const name = relativeRecordName(zone, hostname);
    return (await this.#records(zone))
      .map(normalizeVercelRecord)
      .filter((entry) => entry.name === name || entry.name === hostname);
  }

  async waitHostnameAbsent({ zone, hostname }) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      if ((await this.inspectHostname({ zone, hostname })).length === 0) return true;
      await delay(this.pollIntervalMs);
    }
    return false;
  }

  async verifyARecord({ zone, hostname, value }) {
    const name = relativeRecordName(zone, hostname);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const records = (await this.#records(zone)).map(normalizeVercelRecord);
      const exact = records.filter((entry) => (entry.name === name || entry.name === hostname) && entry.type === "A" && entry.value === value);
      let resolved = [];
      try {
        resolved = await this.resolver(hostname);
      } catch {}
      if (exact.length === 1 && resolved.includes(value)) return true;
      await delay(this.pollIntervalMs);
    }
    return false;
  }

  async restoreRecord({ zone, hostname, change }) {
    if (!change || change.action === "unchanged") return;
    if (change.action === "created") {
      await this.#request("DELETE", `/v2/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(change.recordId)}`, undefined, [200, 204, 404]);
      return;
    }
    if (change.action !== "updated" || !change.previous) throw new Error(`DNS ${hostname} has invalid restoration evidence`);
    const previous = change.previous;
    await this.#request("PATCH", `/v1/domains/records/${encodeURIComponent(change.recordId)}`, {
      name: relativeRecordName(zone, hostname),
      type: previous.type,
      value: previous.value,
      ttl: previous.ttl
    }, [200]);
  }

  async #records(zone) {
    const records = [];
    const cursors = new Set();
    let until = null;

    while (true) {
      const query = new URLSearchParams({ limit: "100" });
      if (until !== null) query.set("until", until);
      const payload = await this.#request("GET", `/v4/domains/${encodeURIComponent(zone)}/records?${query}`);
      const page = payload?.records ?? payload;
      if (!Array.isArray(page)) throw new Error("Vercel DNS response is missing records");
      records.push(...page);

      const pagination = Array.isArray(payload) ? null : payload?.pagination;
      if (pagination == null) break;
      if (typeof pagination !== "object" || !Object.hasOwn(pagination, "next")) {
        throw new Error("Vercel DNS pagination is invalid");
      }
      if (pagination.next === null) break;
      if (!["string", "number"].includes(typeof pagination.next) || String(pagination.next).length === 0) {
        throw new Error("Vercel DNS pagination cursor is invalid");
      }
      until = String(pagination.next);
      if (cursors.has(until)) throw new Error("Vercel DNS pagination cursor repeated");
      cursors.add(until);
    }

    const recordIds = records.map((entry) => normalizeVercelRecord(entry).id);
    if (new Set(recordIds).size !== recordIds.length) throw new Error("Vercel DNS returned duplicate record ids");
    return records;
  }

  async #request(method, path, body = undefined, expected = method === "POST" ? [200, 201] : [200]) {
    const teamSeparator = path.includes("?") ? "&" : "?";
    const url = `${this.apiBase}${path}${this.teamId ? `${teamSeparator}teamId=${encodeURIComponent(this.teamId)}` : ""}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!expected.includes(response.status)) throw new Error(`Vercel DNS ${method} failed with HTTP ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }
}

export class PushoverNotifier {
  constructor({ appToken, userKey, fetchImpl = globalThis.fetch }) {
    if (!appToken || !userKey) throw new Error("Pushover credentials are required");
    this.appToken = appToken;
    this.userKey = userKey;
    this.fetchImpl = fetchImpl;
  }

  async send({ title, message, priority = 0 }) {
    const body = new URLSearchParams({ token: this.appToken, user: this.userKey, title, message, priority: String(priority) });
    const response = await this.fetchImpl("https://api.pushover.net/1/messages.json", { method: "POST", body });
    if (!response.ok) throw new Error(`Pushover lifecycle notification failed with HTTP ${response.status}`);
  }
}

function normalizeVpc(value) {
  if (!value?.id && !value?.uuid) throw new Error("DigitalOcean VPC response has no UUID");
  return {
    uuid: String(value.id ?? value.uuid),
    name: String(value.name ?? ""),
    region: String(value.region?.slug ?? value.region ?? ""),
    ipRange: String(value.ip_range ?? value.ipRange ?? "")
  };
}

function normalizeFirewall(value) {
  if (!value?.id) throw new Error("DigitalOcean firewall response has no id");
  return {
    id: String(value.id),
    name: String(value.name ?? ""),
    status: String(value.status ?? "unknown"),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    dropletIds: Array.isArray(value.droplet_ids ?? value.dropletIds)
      ? (value.droplet_ids ?? value.dropletIds).map(String)
      : [],
    inboundRules: normalizeFirewallRules(value.inbound_rules ?? value.inboundRules, "sources"),
    outboundRules: normalizeFirewallRules(value.outbound_rules ?? value.outboundRules, "destinations")
  };
}

function normalizeFirewallRules(value, peerKey) {
  if (!Array.isArray(value)) return [];
  return value.map((rule) => ({
    protocol: String(rule.protocol ?? ""),
    ports: String(rule.ports ?? ""),
    [peerKey]: normalizeFirewallPeers(rule[peerKey])
  }));
}

function normalizeFirewallPeers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entries]) => [
    key,
    Array.isArray(entries) ? [...new Set(entries.map(String))].sort() : []
  ]));
}

function firewallMatchesPayload(actual, desired) {
  const candidate = {
    name: actual.name,
    inbound_rules: canonicalFirewallRules(actual.inboundRules, "sources"),
    outbound_rules: canonicalFirewallRules(actual.outboundRules, "destinations"),
    tags: [...actual.tags].sort(),
    droplet_ids: [...actual.dropletIds].sort()
  };
  const expected = {
    ...desired,
    inbound_rules: canonicalFirewallRules(desired.inbound_rules, "sources"),
    outbound_rules: canonicalFirewallRules(desired.outbound_rules, "destinations"),
    tags: [...desired.tags].sort(),
    droplet_ids: [...desired.droplet_ids].map(String).sort()
  };
  return isDeepStrictEqual(candidate, expected);
}

function canonicalFirewallRules(value, peerKey) {
  return (value ?? []).map((rule) => ({
    protocol: String(rule.protocol),
    ports: String(rule.ports),
    [peerKey]: normalizeFirewallPeers(rule[peerKey])
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeDroplet(value) {
  if (!value || !Number.isSafeInteger(value.id)) throw new Error("DigitalOcean Droplet response has no valid id");
  return {
    id: String(value.id),
    name: String(value.name ?? ""),
    status: String(value.status ?? "unknown"),
    region: String(value.region?.slug ?? value.region ?? ""),
    vpcUuid: value.vpc_uuid == null ? null : String(value.vpc_uuid),
    size: String(value.size_slug ?? value.size?.slug ?? value.size ?? ""),
    image: String(value.image?.slug ?? value.image?.id ?? value.image ?? ""),
    publicIpv4: value.publicIpv4 ?? firstIpv4(value.networks?.v4, "public"),
    privateIpv4: value.privateIpv4 ?? firstIpv4(value.networks?.v4, "private"),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    createdAt: value.created_at ?? value.createdAt ?? null
  };
}

function normalizeReservedIpv4(value) {
  if (!value?.ip) throw new Error("DigitalOcean reserved IPv4 response is invalid");
  return {
    ip: String(value.ip),
    region: String(value.region?.slug ?? value.region ?? ""),
    dropletId: value.droplet?.id == null ? null : String(value.droplet.id),
    locked: value.locked === true
  };
}

function normalizeVercelRecord(value) {
  const record = value?.record ?? value;
  const id = record?.id ?? record?.uid;
  if (!id) throw new Error("Vercel DNS record is missing its id");
  return {
    id: String(id),
    name: String(record.name ?? ""),
    type: String(record.recordType ?? record.type ?? ""),
    value: String(record.value ?? ""),
    ttl: Number(record.ttl ?? 60)
  };
}

function firstIpv4(values, type) {
  return Array.isArray(values) ? values.find((entry) => entry.type === type)?.ip_address ?? null : null;
}

function relativeRecordName(zone, hostname) {
  if (hostname === zone) return "";
  const suffix = `.${zone}`;
  if (!hostname.endsWith(suffix)) throw new Error(`${hostname} is outside DNS zone ${zone}`);
  return hostname.slice(0, -suffix.length);
}

function numericOrString(value) {
  const string = String(value);
  return /^\d+$/.test(string) ? Number(string) : string;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
