import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertNetworkContractDeployable, validateAdminSshCidrs } from "./network-contract.mjs";
import { parseRenderAdminSshArgs, renderAdminSshNetwork } from "./render-admin-ssh-network.mjs";

const templatePath = fileURLToPath(new URL("./network-contract.json", import.meta.url));

test("renders one protected admin CIDR plus bastion-only service SSH", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-admin-ssh-"));
  await chmod(root, 0o700);
  const adminCidrs = join(root, "admin.json");
  const output = join(root, "network.json");
  await writeFile(adminCidrs, JSON.stringify({ schemaVersion: 1, addresses: ["1.1.1.1/32"] }), { mode: 0o600 });
  const result = await renderAdminSshNetwork({
    template: templatePath,
    adminCidrs,
    output
  });
  assert.equal(result.adminSourceCount, 1);
  const contract = assertNetworkContractDeployable(JSON.parse(await readFile(output, "utf8")));
  for (const firewall of contract.firewalls) {
    const ssh = firewall.inboundRules.filter((rule) => rule.protocol === "tcp" && rule.ports === "22");
    assert.deepEqual(ssh.find((rule) => rule.sources.addresses).sources.addresses, ["1.1.1.1/32"]);
    assert.equal(ssh.some((rule) => rule.sources.addresses?.includes("0.0.0.0/0")), false);
    assert.equal(ssh.some((rule) => rule.sources.tags?.includes("bvm-observability")), firewall.targetTag !== "bvm-observability");
  }
});

test("rejects global, private, documentation, duplicate, and non-host admin sources", async () => {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  for (const address of ["0.0.0.0/0", "10.0.0.1/32", "203.0.113.42/32", "1.1.1.0/24", "::1/128", "2001:db8::1/128"]) {
    assert.throws(
      () => assertNetworkContractDeployable({
        ...template,
        firewalls: template.firewalls.map((firewall) => ({
          ...firewall,
          inboundRules: firewall.inboundRules.map((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses
            ? { ...rule, sources: { addresses: [address] } }
            : rule)
        }))
      }),
      /SSH|public operator host|host CIDR|globally/u
    );
  }
  assert.throws(
    () => validateAdminSshCidrs({
      schemaVersion: 1,
      addresses: ["2001:4860:4860::8888/128", "2001:4860:4860::8888/128"]
    }),
    /unique/u
  );
});

test("requires normalized protected inputs and an unused protected output", async () => {
  assert.throws(() => parseRenderAdminSshArgs(["render", "--admin-cidrs", "relative", "--output", "/tmp/out"]), /absolute path/u);
  const root = await mkdtemp(join(tmpdir(), "scorecheck-admin-ssh-permissions-"));
  await chmod(root, 0o700);
  const cidrs = join(root, "cidrs.json");
  await writeFile(cidrs, JSON.stringify({ schemaVersion: 1, addresses: ["1.1.1.1/32"] }), { mode: 0o644 });
  await assert.rejects(() => renderAdminSshNetwork({ template: templatePath, adminCidrs: cidrs, output: join(root, "out.json") }), /protected file/u);
  await chmod(cidrs, 0o600);
  const output = join(root, "out.json");
  await writeFile(output, "existing\n", { mode: 0o600 });
  await assert.rejects(() => renderAdminSshNetwork({ template: templatePath, adminCidrs: cidrs, output }), /EEXIST/u);
  await assert.rejects(() => renderAdminSshNetwork({ template: templatePath, adminCidrs: cidrs, output: "relative.json" }), /normalized absolute path/u);
});
