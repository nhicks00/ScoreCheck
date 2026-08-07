import assert from "node:assert/strict";
import test from "node:test";

import { renderPrometheusConfig } from "./render-config.mjs";

test("renders a relayed SNMP target with its non-default UDP port", () => {
  const rendered = renderPrometheusConfig("", "monitor-token", "10.120.0.3:1161");
  assert.match(rendered, /targets: \["10\.120\.0\.3:1161"\]/u);
});

test("rejects an invalid relayed SNMP port", () => {
  assert.throws(
    () => renderPrometheusConfig("", "monitor-token", "10.120.0.3:65536"),
    /optional valid port/u
  );
});
