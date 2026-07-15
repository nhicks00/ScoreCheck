#!/usr/bin/env node

const SCHEMA_VERSION = 1;
const SLOTS = ["ingest", "commentary"];
const CONFIRMATION = "CREATE:ENDPOINT-ANCHORS";

export class EndpointAnchorManager {
  constructor({ cloud, store, now = () => new Date() }) {
    this.cloud = cloud;
    this.store = store;
    this.now = now;
  }

  async create({ region }, confirmation) {
    if (confirmation !== CONFIRMATION) throw new Error(`endpoint anchor creation requires exact confirmation ${CONFIRMATION}`);
    validateRegion(region);
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!state) {
        const account = await this.cloud.getAccount();
        if (account.status !== "active") throw new Error(`DigitalOcean account is ${account.status}, not active`);
        state = {
          schemaVersion: SCHEMA_VERSION,
          provider: "digitalocean",
          region,
          reservedIpv4: {},
          status: "creating",
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
          timeline: []
        };
        await this.store.save(state);
      }
      validatePartialState(state, region);

      for (const slot of SLOTS) {
        if (state.reservedIpv4[slot]) {
          await this.#assertAddress(state.reservedIpv4[slot], region, slot);
          continue;
        }
        const address = await this.cloud.createReservedIpv4(region);
        if (address.region !== region || address.dropletId !== null) throw new Error(`new ${slot} endpoint anchor has an unexpected region or assignment`);
        state.reservedIpv4[slot] = address.ip;
        state.timeline.push({ at: this.now().toISOString(), event: "anchor-created", slot, ip: address.ip });
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
      }

      if (new Set(Object.values(state.reservedIpv4)).size !== SLOTS.length) throw new Error("endpoint anchor IPv4 values are duplicated");
      state.status = "ready";
      state.readyAt = this.now().toISOString();
      state.updatedAt = state.readyAt;
      await this.store.save(state);
      return state;
    });
  }

  async verify({ region }) {
    validateRegion(region);
    const state = await this.store.load();
    validateReadyState(state, region);
    const addresses = {};
    for (const slot of SLOTS) addresses[slot] = await this.#assertAddress(state.reservedIpv4[slot], region, slot);
    return {
      status: "PASS",
      provider: "digitalocean",
      region,
      checkedAt: this.now().toISOString(),
      slots: Object.fromEntries(SLOTS.map((slot) => [slot, { ip: addresses[slot].ip, assignedDropletId: addresses[slot].dropletId }]))
    };
  }

  async #assertAddress(ip, region, slot) {
    const address = await this.cloud.getReservedIpv4(ip);
    if (address.region !== region) throw new Error(`${slot} endpoint anchor moved outside ${region}`);
    if (address.ip !== ip) throw new Error(`${slot} endpoint anchor identity changed`);
    return address;
  }
}

export function validateReadyAnchorState(value, region) {
  validateReadyState(value, region);
  return value;
}

function validatePartialState(value, region) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.provider !== "digitalocean") throw new Error("endpoint anchor state is invalid");
  if (value.region !== region) throw new Error("endpoint anchor state belongs to a different region");
  if (!value.reservedIpv4 || typeof value.reservedIpv4 !== "object" || Array.isArray(value.reservedIpv4)) throw new Error("endpoint anchor address map is invalid");
  if (Object.keys(value.reservedIpv4).some((slot) => !SLOTS.includes(slot))) throw new Error("endpoint anchor state contains an unknown slot");
  if (!Object.values(value.reservedIpv4).every(isIpv4)) throw new Error("endpoint anchor state contains an invalid IPv4 address");
}

function validateReadyState(value, region) {
  validatePartialState(value, region);
  if (value.status !== "ready") throw new Error("endpoint anchors are not ready");
  if (JSON.stringify(Object.keys(value.reservedIpv4).sort()) !== JSON.stringify([...SLOTS].sort())) throw new Error("endpoint anchor slots are incomplete");
  if (new Set(Object.values(value.reservedIpv4)).size !== SLOTS.length) throw new Error("endpoint anchor IPv4 values are duplicated");
}

function validateRegion(region) {
  if (typeof region !== "string" || !/^[a-z0-9-]{2,20}$/.test(region)) throw new Error("endpoint anchor region is invalid");
}

function isIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

export const ENDPOINT_ANCHOR_CONFIRMATION = CONFIRMATION;
