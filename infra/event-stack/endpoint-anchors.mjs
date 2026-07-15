#!/usr/bin/env node

const SCHEMA_VERSION = 2;
const SLOTS = ["ingest", "commentary"];
const RETENTIONS = new Set(["persistent", "ephemeral"]);
const CONFIRMATIONS = Object.freeze({
  persistent: "CREATE:PERSISTENT-ENDPOINT-ANCHORS",
  ephemeral: "CREATE:REHEARSAL-ENDPOINT-ANCHORS"
});

export class EndpointAnchorManager {
  constructor({ cloud, store, now = () => new Date() }) {
    this.cloud = cloud;
    this.store = store;
    this.now = now;
  }

  async create({ region, retention }, confirmation) {
    validateRetention(retention);
    if (confirmation !== CONFIRMATIONS[retention]) {
      throw new Error(`endpoint anchor creation requires exact confirmation ${CONFIRMATIONS[retention]}`);
    }
    validateRegion(region);
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!state) {
        const account = await this.cloud.getAccount();
        if (account.status !== "active") throw new Error(`DigitalOcean account is ${account.status}, not active`);
        const baselineReservedIpv4s = retention === "persistent"
          ? (await this.cloud.listReservedIpv4s()).map((entry) => entry.ip).sort()
          : [];
        state = {
          schemaVersion: SCHEMA_VERSION,
          provider: "digitalocean",
          region,
          retention,
          reservedIpv4: {},
          baselineReservedIpv4s,
          pendingAllocation: null,
          status: "creating",
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
          timeline: []
        };
        await this.store.save(state);
      }
      validatePartialState(state, region, retention);

      for (const slot of slotsForRetention(retention)) {
        if (state.reservedIpv4[slot]) {
          await this.#assertAddress(state.reservedIpv4[slot], region, slot);
          continue;
        }
        const address = await this.#ensureAddress(state, region, slot);
        if (address.region !== region || address.dropletId !== null) throw new Error(`new ${slot} endpoint anchor has an unexpected region or assignment`);
        state.reservedIpv4[slot] = address.ip;
        state.pendingAllocation = null;
        state.timeline.push({ at: this.now().toISOString(), event: address.reconciled ? "anchor-reconciled" : "anchor-created", slot, ip: address.ip });
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
      }

      if (new Set(Object.values(state.reservedIpv4)).size !== slotsForRetention(retention).length) throw new Error("endpoint anchor IPv4 values are duplicated");
      state.status = "ready";
      state.readyAt = this.now().toISOString();
      state.updatedAt = state.readyAt;
      await this.store.save(state);
      return state;
    });
  }

  async verify({ region, retention }) {
    validateRegion(region);
    validateRetention(retention);
    const state = await this.store.load();
    validateReadyState(state, region, retention);
    const addresses = {};
    const slots = slotsForRetention(retention);
    for (const slot of slots) addresses[slot] = await this.#assertAddress(state.reservedIpv4[slot], region, slot);
    return {
      status: "PASS",
      provider: "digitalocean",
      region,
      retention,
      checkedAt: this.now().toISOString(),
      slots: Object.fromEntries(slots.map((slot) => [slot, { ip: addresses[slot].ip, assignedDropletId: addresses[slot].dropletId }]))
    };
  }

  async #assertAddress(ip, region, slot) {
    const address = await this.cloud.getReservedIpv4(ip);
    if (address.region !== region) throw new Error(`${slot} endpoint anchor moved outside ${region}`);
    if (address.ip !== ip) throw new Error(`${slot} endpoint anchor identity changed`);
    return address;
  }

  async #ensureAddress(state, region, slot) {
    if (state.pendingAllocation && state.pendingAllocation.slot !== slot) {
      throw new Error(`endpoint anchor allocation checkpoint belongs to ${state.pendingAllocation.slot}, not ${slot}`);
    }
    if (!state.pendingAllocation) {
      const before = (await this.cloud.listReservedIpv4s()).map((entry) => entry.ip).sort();
      const expected = [...new Set([...state.baselineReservedIpv4s, ...Object.values(state.reservedIpv4)])].sort();
      if (JSON.stringify(before) !== JSON.stringify(expected)) {
        throw new Error("Reserved IPv4 inventory changed outside the protected endpoint-anchor bootstrap");
      }
      state.pendingAllocation = { slot, before, preparedAt: this.now().toISOString() };
      state.timeline.push({ at: this.now().toISOString(), event: "anchor-allocation-prepared", slot, beforeCount: before.length });
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
    }
    const reconcile = async () => {
      const before = new Set(state.pendingAllocation.before);
      const candidates = (await this.cloud.listReservedIpv4s()).filter((entry) => !before.has(entry.ip));
      if (candidates.length === 0) return null;
      if (candidates.length !== 1) throw new Error(`cannot reconcile ${slot} endpoint anchor safely; found ${candidates.length} post-checkpoint addresses`);
      const candidate = candidates[0];
      if (candidate.region !== region || candidate.dropletId !== null) {
        throw new Error(`cannot reconcile ${slot} endpoint anchor because the inventory delta has unexpected identity`);
      }
      return { ...candidate, reconciled: true };
    };
    let address = await reconcile();
    if (address) return address;
    try {
      return { ...await this.cloud.createReservedIpv4(region), reconciled: false };
    } catch (error) {
      address = await reconcile();
      if (!address) throw error;
      return address;
    }
  }
}

export function validateReadyAnchorState(value, region, retention) {
  validateReadyState(value, region, retention);
  return value;
}

function validatePartialState(value, region, retention) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.provider !== "digitalocean") throw new Error("endpoint anchor state is invalid");
  if (value.region !== region) throw new Error("endpoint anchor state belongs to a different region");
  if (value.retention !== retention) throw new Error("endpoint anchor state has the wrong retention policy");
  if (!value.reservedIpv4 || typeof value.reservedIpv4 !== "object" || Array.isArray(value.reservedIpv4)) throw new Error("endpoint anchor address map is invalid");
  if (!Array.isArray(value.baselineReservedIpv4s) || !value.baselineReservedIpv4s.every(isIpv4) || new Set(value.baselineReservedIpv4s).size !== value.baselineReservedIpv4s.length) throw new Error("endpoint anchor baseline inventory is invalid");
  if (value.pendingAllocation !== null) {
    const pending = value.pendingAllocation;
    if (!pending || !SLOTS.includes(pending.slot) || !Array.isArray(pending.before) || !pending.before.every(isIpv4) || typeof pending.preparedAt !== "string") throw new Error("endpoint anchor allocation checkpoint is invalid");
  }
  if (Object.keys(value.reservedIpv4).some((slot) => !SLOTS.includes(slot))) throw new Error("endpoint anchor state contains an unknown slot");
  if (!Object.values(value.reservedIpv4).every(isIpv4)) throw new Error("endpoint anchor state contains an invalid IPv4 address");
}

function validateReadyState(value, region, retention) {
  validatePartialState(value, region, retention);
  if (value.status !== "ready") throw new Error("endpoint anchors are not ready");
  const slots = slotsForRetention(retention);
  if (JSON.stringify(Object.keys(value.reservedIpv4).sort()) !== JSON.stringify([...slots].sort())) throw new Error("endpoint anchor slots are incomplete");
  if (new Set(Object.values(value.reservedIpv4)).size !== slots.length) throw new Error("endpoint anchor IPv4 values are duplicated");
}

function slotsForRetention(retention) {
  return retention === "persistent" ? SLOTS : [];
}

function validateRegion(region) {
  if (typeof region !== "string" || !/^[a-z0-9-]{2,20}$/.test(region)) throw new Error("endpoint anchor region is invalid");
}

function validateRetention(retention) {
  if (!RETENTIONS.has(retention)) throw new Error("endpoint anchor retention must be persistent or ephemeral");
}

function isIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

export const ENDPOINT_ANCHOR_CONFIRMATIONS = CONFIRMATIONS;
