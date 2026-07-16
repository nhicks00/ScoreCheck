import assert from "node:assert/strict";
import test from "node:test";

import { parseNetworkManagerArgs } from "./manage-event-network.mjs";

test("network apply requires an explicit exact confirmation", () => {
  assert.throws(
    () => parseNetworkManagerArgs(["apply", "--credentials-env", "/tmp/provider.env"]),
    /--network-spec is required/u
  );
  assert.throws(
    () => parseNetworkManagerArgs(["apply", "--credentials-env", "/tmp/provider.env", "--network-spec", "/tmp/network.json", "--confirm", "yes"]),
    /confirmation must be exactly APPLY:EVENT-NETWORK/u
  );
  assert.equal(parseNetworkManagerArgs([
    "apply",
    "--credentials-env", "/tmp/provider.env",
    "--network-spec", "/tmp/network.json",
    "--confirm", "APPLY:EVENT-NETWORK"
  ]).command, "apply");
});

test("network verify requires an explicit contract and rejects confirmations", () => {
  assert.throws(() => parseNetworkManagerArgs(["verify", "--credentials-env", "/tmp/provider.env"]), /--network-spec is required/u);
  assert.equal(parseNetworkManagerArgs(["verify", "--credentials-env", "/tmp/provider.env", "--network-spec", "/tmp/network.json"]).command, "verify");
  assert.throws(
    () => parseNetworkManagerArgs(["verify", "--credentials-env", "/tmp/provider.env", "--network-spec", "/tmp/network.json", "--confirm", "anything"]),
    /does not accept --confirm/u
  );
});
