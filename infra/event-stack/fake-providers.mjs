export class FakeDigitalOceanProvider {
  constructor({ dropletLimit = 12, region = "sfo2", reservedIpv4 = { ingest: "192.0.2.10", commentary: "192.0.2.11" } } = {}) {
    this.account = { status: "active", dropletLimit };
    this.region = region;
    this.droplets = new Map();
    this.reserved = new Map(Object.values(reservedIpv4).map((ip) => [ip, { ip, region, dropletId: null, locked: false }]));
    this.nextId = 1000;
    this.createCalls = 0;
    this.deleteCalls = [];
    this.assignCalls = [];
    this.failCreateAt = null;
    this.ambiguousCreateAt = null;
  }

  async getAccount() {
    return structuredClone(this.account);
  }

  async findDropletsByName(name) {
    return [...this.droplets.values()].filter((entry) => entry.name === name).map(clone);
  }

  async listAllDroplets() {
    return [...this.droplets.values()].map(clone);
  }

  async listDropletsByEvent(event) {
    const tag = `scorecheck-event:${event}`;
    return [...this.droplets.values()].filter((entry) => entry.tags.includes(tag)).map(clone);
  }

  async createDroplet(request) {
    this.createCalls += 1;
    if (this.failCreateAt === this.createCalls) throw new Error("injected definite create failure");
    const id = String(this.nextId++);
    const index = this.droplets.size + 20;
    const droplet = {
      id,
      name: request.name,
      status: "active",
      region: request.region,
      size: request.size,
      image: request.image,
      publicIpv4: `198.51.100.${index}`,
      privateIpv4: `10.20.0.${index}`,
      tags: [...request.tags],
      createdAt: new Date(0).toISOString()
    };
    this.droplets.set(id, droplet);
    if (this.ambiguousCreateAt === this.createCalls) throw new Error("injected ambiguous create result");
    return clone(droplet);
  }

  async getDroplet(id) {
    const value = this.droplets.get(String(id));
    if (!value) {
      const error = new Error(`Droplet ${id} not found`);
      error.status = 404;
      throw error;
    }
    return clone(value);
  }

  async waitDropletActive(id) {
    return this.getDroplet(id);
  }

  async deleteDroplet(id) {
    const key = String(id);
    if (!this.droplets.has(key)) throw new Error(`Droplet ${id} not found`);
    for (const address of this.reserved.values()) {
      if (address.dropletId === key) address.dropletId = null;
    }
    this.droplets.delete(key);
    this.deleteCalls.push(key);
  }

  async waitDropletAbsent(id) {
    if (this.droplets.has(String(id))) throw new Error(`Droplet ${id} still exists`);
    return true;
  }

  async getReservedIpv4(ip) {
    const address = this.reserved.get(ip);
    if (!address) throw new Error(`reserved IPv4 ${ip} not found`);
    return clone(address);
  }

  async createReservedIpv4(region = this.region) {
    const ip = `192.0.2.${this.reserved.size + 20}`;
    const address = { ip, region, dropletId: null, locked: false };
    this.reserved.set(ip, address);
    return clone(address);
  }

  async deleteReservedIpv4(ip) {
    const address = this.reserved.get(ip);
    if (!address) throw new Error(`reserved IPv4 ${ip} not found`);
    if (address.dropletId !== null) throw new Error(`reserved IPv4 ${ip} is assigned`);
    this.reserved.delete(ip);
  }

  async assignReservedIpv4(ip, dropletId) {
    const address = this.reserved.get(ip);
    if (!address) throw new Error(`reserved IPv4 ${ip} not found`);
    if (!this.droplets.has(String(dropletId))) throw new Error(`Droplet ${dropletId} not found`);
    address.dropletId = String(dropletId);
    this.assignCalls.push({ ip, dropletId: String(dropletId) });
    return { status: "completed" };
  }

  async waitReservedIpv4Assignment(ip, dropletId) {
    const address = await this.getReservedIpv4(ip);
    if (address.dropletId !== String(dropletId)) throw new Error("reserved IPv4 assignment mismatch");
    return address;
  }

  replaceDropletId(name) {
    const current = [...this.droplets.values()].find((entry) => entry.name === name);
    if (!current) throw new Error(`${name} does not exist`);
    this.droplets.delete(current.id);
    const replacement = { ...current, id: String(this.nextId++) };
    this.droplets.set(replacement.id, replacement);
    return replacement;
  }
}

export class FakeDnsProvider {
  constructor(initial = {}) {
    this.records = new Map(Object.entries(initial).map(([hostname, value], index) => [hostname, { id: `dns-${index + 1}`, value, ttl: 300 }]));
    this.nextId = this.records.size + 1;
    this.failHostname = null;
    this.ambiguousHostname = null;
    this.upserts = [];
    this.restores = [];
  }

  async inspectHostname({ hostname }) {
    const current = this.records.get(hostname);
    return current ? [{ ...clone(current), name: hostname, type: "A" }] : [];
  }

  async upsertARecord({ hostname, value, ttl, previousChange }) {
    if (hostname === this.failHostname) throw new Error(`injected DNS failure for ${hostname}`);
    const current = this.records.get(hostname) ?? null;
    let change = previousChange;
    if (!change) {
      change = current
        ? { action: current.value === value && current.ttl === ttl ? "unchanged" : "updated", recordId: current.id, previous: clone(current) }
        : { action: "created", recordId: `dns-${this.nextId++}`, previous: null };
    } else if (change.action === "created" && !change.recordId) {
      change = { ...change, recordId: current?.id ?? `dns-${this.nextId++}` };
    }
    this.records.set(hostname, { id: change.recordId, value, ttl });
    this.upserts.push({ hostname, value, ttl });
    if (hostname === this.ambiguousHostname) {
      this.ambiguousHostname = null;
      throw new Error(`injected ambiguous DNS response for ${hostname}`);
    }
    return clone(change);
  }

  async verifyARecord({ hostname, value }) {
    return this.records.get(hostname)?.value === value;
  }

  async restoreRecord({ hostname, change }) {
    if (change.action === "created") this.records.delete(hostname);
    else if (change.action === "updated") this.records.set(hostname, clone(change.previous));
    this.restores.push(hostname);
  }
}

export class FakeStackDeployer {
  constructor() {
    this.deployCalls = [];
    this.failName = null;
    this.stackHealthy = true;
  }

  async deploy({ spec }) {
    this.deployCalls.push(spec.name);
    if (spec.name === this.failName) return { healthy: false };
    return { healthy: true, revision: "fake-revision", evidence: { role: spec.role } };
  }

  async verifyStack({ state }) {
    return {
      healthy: this.stackHealthy,
      evidence: {
        activeDroplets: Object.values(state.droplets).filter((entry) => entry.status === "active").length,
        healthyDeployments: Object.values(state.deployments).filter((entry) => entry.status === "healthy").length
      }
    };
  }
}

export class FakeNotifier {
  constructor() {
    this.messages = [];
    this.failNext = 0;
  }

  async send(value) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("injected notification failure");
    }
    this.messages.push(clone(value));
  }
}

function clone(value) {
  return structuredClone(value);
}
