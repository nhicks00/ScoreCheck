import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const [dockerfile, compose, dockerignore, patch, hlsPatch] = await Promise.all([
  readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("./docker-compose.yml", import.meta.url), "utf8"),
  readFile(new URL("./.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("./patches/gortmplib-avkans-adts-aac.patch", import.meta.url), "utf8"),
  readFile(new URL("./patches/mediamtx-hls-partial-session-close.patch", import.meta.url), "utf8")
]);

test("builds the MediaMTX compatibility image from pinned and tested upstream revisions", () => {
  assert.ok(directory.endsWith("/infra/mediamtx/"));
  assert.match(dockerfile, /golang:1\.26-alpine3\.24@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /c9c2ddd362aa155e0c8e35b6713f7ebdd731f7aa/u);
  assert.match(dockerfile, /7eb5d30075ae68a36c07c3f1231af04a0e49f804/u);
  assert.match(dockerfile, /git -C \/src\/gortmplib apply --check/u);
  assert.match(dockerfile, /git -C \/src\/mediamtx apply --check/u);
  assert.match(dockerfile, /go test \.\/\.\.\./u);
  assert.match(dockerfile, /go generate \.\/\.\.\./u);
  assert.match(dockerfile, /go test \.\/internal\/servers\/hls \.\/internal\/servers\/rtmp/u);
  assert.match(compose, /image: scorecheck\/mediamtx:1\.19\.2-avkans-adts2/u);
  assert.match(compose, /build:\n\s+context: \.\n\s+dockerfile: Dockerfile/u);
});

test("closes an HLS CDN session safely when another request replaces it during initialization", () => {
  assert.match(hlsPatch, /if s\.reader != nil/u);
  assert.match(hlsPatch, /if s\.onUnreadHook != nil/u);
  assert.match(hlsPatch, /TestSessionCloseWhileInitializationIsIncomplete/u);
  assert.match(hlsPatch, /require\.NotPanics/u);
});

test("admits only the captured codec-15 plus single-ADTS compatibility signature", () => {
  assert.match(patch, /m\.Codec == 15 && raw\.Body\[0\] == 0xff/u);
  assert.match(patch, /packets\.Unmarshal\(raw\.Body\[1:\]\)/u);
  assert.match(patch, /err == nil && len\(packets\) == 1/u);
  assert.match(patch, /AACType = AudioAACTypeAU/u);
  assert.match(patch, /require\.EqualError\(t, err, "unsupported audio codec: 15"\)/u);
});

test("excludes runtime configuration and secrets from the image build context", () => {
  assert.equal(dockerignore, "*\n!Dockerfile\n!patches/\n!patches/gortmplib-avkans-adts-aac.patch\n!patches/mediamtx-hls-partial-session-close.patch\n");
});
