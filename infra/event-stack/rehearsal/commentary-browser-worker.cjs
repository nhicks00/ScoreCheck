#!/usr/bin/env node

const { chmod, readFile, rename, writeFile } = require("node:fs/promises");
const process = require("node:process");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const playwright = require(options.playwright);
  if (options.preflight) {
    const executable = playwright.chromium.executablePath();
    await require("node:fs/promises").access(executable);
    process.stdout.write("playwright chromium ready\n");
    return;
  }

  const config = JSON.parse(await readFile(options.config, "utf8"));
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${config.audioFixturePath}`
    ]
  });
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(`page error: ${String(error.message).slice(0, 300)}\n`));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) process.stderr.write(`browser ${message.type()}: ${message.text().slice(0, 300)}\n`);
  });

  const login = await page.request.post(`${config.origin}/api/commentary/login`, {
    form: { passcode: config.commentatorPasscode },
    maxRedirects: 0
  });
  if (login.status() !== 303) throw new Error(`commentary login returned HTTP ${login.status()}`);
  const setCookie = login.headers()["set-cookie"] ?? "";
  const cookieMatch = /^scorecheck_commentary=([^;]+)/.exec(setCookie);
  if (!cookieMatch) throw new Error("commentary login did not return its session cookie");
  await context.addCookies([{
    name: "scorecheck_commentary",
    value: cookieMatch[1],
    url: config.origin,
    httpOnly: true,
    secure: true,
    sameSite: "Lax"
  }]);

  await page.goto(config.pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Join live audio" }).click({ timeout: 60_000 });
  await page.locator("[data-preview-state]").filter({ hasText: "Preview live" }).waitFor({ timeout: 60_000 });
  await page.locator(".commentary-audio-panel .status").filter({ hasText: "Live" }).waitFor({ timeout: 60_000 });
  await page.locator("video").evaluate(async (video) => {
    const started = performance.now();
    while ((video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime <= 0) && performance.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime <= 0) throw new Error("rehearsal preview did not render");
  });
  await writeJsonAtomic(config.readyPath, {
    schemaVersion: 1,
    court: config.court,
    marker: config.marker,
    readyAt: new Date().toISOString()
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  await new Promise(() => {});
}

function parseArgs(args) {
  const result = { preflight: false, marker: null, config: null, playwright: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--preflight") result.preflight = true;
    else if (["--marker", "--config", "--playwright"].includes(value)) result[value.slice(2)] = args[++index];
    else throw new Error(`unsupported commentary browser option ${value}`);
  }
  if (!result.playwright || (!result.preflight && (!result.marker || !result.config))) throw new Error("commentary browser arguments are incomplete");
  return result;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

main().catch((error) => {
  process.stderr.write(`commentary browser failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
