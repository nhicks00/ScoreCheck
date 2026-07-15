import assert from "node:assert/strict";
import test from "node:test";

import { parseNetworkManagerArgs } from "./manage-event-network.mjs";

test("network apply requires an explicit exact confirmation", () => {
  assert.throws(
    () => parseNetworkManagerArgs(["apply", "--credentials-env", "/tmp/provider.env"]),
    /confirmation must be exactly APPLY:EVENT-NETWORK/u
  );
  assert.throws(
    () => parseNetworkManagerArgs(["apply", "--credentials-env", "/tmp/provider.env", "--confirm", "yes"]),
    /confirmation must be exactly APPLY:EVENT-NETWORK/u
  );
  assert.equal(parseNetworkManagerArgs([
    "apply",
    "--credentials-env", "/tmp/provider.env",
    "--confirm", "APPLY:EVENT-NETWORK"
  ]).command, "apply");
});

test("network verify is read-only and rejects confirmations", () => {
  assert.equal(parseNetworkManagerArgs(["verify", "--credentials-env", "/tmp/provider.env"]).command, "verify");
  assert.throws(
    () => parseNetworkManagerArgs(["verify", "--credentials-env", "/tmp/provider.env", "--confirm", "anything"]),
    /does not accept --confirm/u
  );
});
