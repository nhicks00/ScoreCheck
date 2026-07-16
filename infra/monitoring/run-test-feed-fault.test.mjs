import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SyntheticPublisher,
  TestFeedController,
  baselineReadyInstruction,
  createAudioChunk,
  createVideoFrame,
  faultReadyProblems,
  ffmpegCapabilityProblems,
  parseTestFeedArgs,
  publisherConfiguration,
  publishingBaselineProblems,
  startPreflightProblems
} from "./run-test-feed-fault.mjs";

describe("test-feed fault controller", () => {
  it("requires an explicit direct-publisher camera and supported scenario", () => {
    const parsed = parseTestFeedArgs(["--court", "4", "--scenario", "freeze", "--output", "/tmp/fault.jsonl"], {});
    assert.equal(parsed.courtNumber, 4);
    assert.equal(parsed.scenario, "freeze");
    assert.throws(() => parseTestFeedArgs(["--court", "1", "--scenario", "freeze", "--output", "/tmp/fault.jsonl"], {}), /Camera 2-5/);
    assert.throws(() => parseTestFeedArgs(["--court", "4", "--scenario", "unknown", "--output", "/tmp/fault.jsonl"], {}), /must be one of/);
    assert.throws(() => parseTestFeedArgs(["--court", "4", "--scenario", "freeze", "--output", "relative.jsonl"], {}), /absolute/);
  });

  it("refuses occupied paths, active events, existing gates, and dirty peers", () => {
    assert.deepEqual(startPreflightProblems(snapshot(), 4, NOW), []);
    assert.match(startPreflightProblems(snapshot({ raw: rawPath() }), 4, NOW).join(";"), /raw path is occupied/);
    assert.match(startPreflightProblems(snapshot({ event: { id: "event" } }), 4, NOW).join(";"), /tournament event is active/);
    assert.match(startPreflightProblems(snapshot({ gates: [gate("RAW_ONLY")] }), 4, NOW).join(";"), /already armed/);
    assert.match(startPreflightProblems(snapshot({ peerState: "CRITICAL" }), 4, NOW).join(";"), /peer Camera 3/);
  });

  it("requires the exact synthetic media profile before gate arming", () => {
    const healthy = snapshot({ raw: rawPath() });
    assert.deepEqual(publishingBaselineProblems(healthy, 4, "SRT", NOW), []);
    assert.match(publishingBaselineProblems(snapshot({ raw: rawPath({ sourceProtocol: "RTMP" }) }), 4, "SRT", NOW).join(";"), /protocol is not SRT/);
    assert.match(publishingBaselineProblems(snapshot({ raw: rawPath({ videoWidth: 1920 }) }), 4, "SRT", NOW).join(";"), /1280x720/);
  });

  it("distinguishes raw-only and content-analysis gate profiles", () => {
    const rawGateSnapshot = snapshot({
      raw: rawPath(),
      gates: [gate("RAW_ONLY")],
      expectation: gateExpectation("RAW_ONLY"),
      selectedState: "HEALTHY"
    });
    assert.deepEqual(faultReadyProblems(rawGateSnapshot, 4, "publisher-loss", NOW), []);
    assert.match(faultReadyProblems(rawGateSnapshot, 4, "freeze", NOW).join(";"), /PROGRAM_CONTENT/);

    const content = snapshot({
      raw: rawPath({ readerCount: 1 }),
      preview: branchPath("preview", { readerCount: 1 }),
      program: branchPath("program", { readerCount: 1 }),
      browser: browser(),
      gates: [gate("PROGRAM_CONTENT")],
      expectation: gateExpectation("PROGRAM_CONTENT"),
      selectedState: "HEALTHY"
    });
    assert.deepEqual(faultReadyProblems(content, 4, "freeze", NOW), []);
    assert.match(faultReadyProblems(snapshotWith(content, { program: branchPath("program", { readerCount: 2 }) }), 4, "freeze", NOW).join(";"), /exactly one active viewer/);
    assert.match(faultReadyProblems(snapshotWith(content, { browser: browser({ visual: { frozenDurationMs: 6_000 } }) }), 4, "freeze", NOW).join(";"), /visual analysis is not clean/);
  });

  it("requires the Program viewer before arming a content-analysis gate", () => {
    const contentInstruction = baselineReadyInstruction("freeze");
    assert.ok(contentInstruction.indexOf("Open exactly one protected Program viewer") < contentInstruction.indexOf("arm the PROGRAM_CONTENT gate"));
    assert.match(baselineReadyInstruction("publisher-loss"), /^Arm one RAW_ONLY gate/);
    assert.throws(() => baselineReadyInstruction("unknown"), /Unknown fault scenario/);
  });

  it("requires audible camera audio before injecting silence", () => {
    const content = snapshot({
      raw: rawPath({ readerCount: 1 }),
      preview: branchPath("preview", { readerCount: 1 }),
      program: branchPath("program", { readerCount: 1 }),
      browser: browser({ commentary: { secondsSinceCameraAudio: 8 } }),
      gates: [gate("PROGRAM_CONTENT")],
      expectation: gateExpectation("PROGRAM_CONTENT"),
      selectedState: "HEALTHY"
    });
    assert.match(faultReadyProblems(content, 4, "camera-silence", NOW).join(";"), /already silent/);
  });

  it("generates changing, frozen, black, audible, and silent media deterministically", () => {
    const normal0 = createVideoFrame("normal", 0, 16, 8);
    const normal1 = createVideoFrame("normal", 1, 16, 8);
    const freeze0 = createVideoFrame("freeze", 0, 16, 8);
    const freeze1 = createVideoFrame("freeze", 100, 16, 8);
    const black = createVideoFrame("black", 0, 16, 8);
    assert.notDeepEqual(normal0, normal1);
    assert.deepEqual(freeze0, freeze1);
    assert.ok(black.subarray(0, 16 * 8).every((value) => value === 16));
    assert.ok(black.subarray(16 * 8).every((value) => value === 128));
    assert.ok(createAudioChunk("normal", 0, 480).some((value) => value !== 0));
    assert.ok(createAudioChunk("silence", 0, 480).every((value) => value === 0));
  });

  it("builds direct argv publishers without a shell", () => {
    const rtmp = publisherConfiguration({ courtNumber: 2, host: "media.example.test", user: "publisher", password: "secret123" });
    assert.equal(rtmp.protocol, "RTMP");
    assert.match(rtmp.args.at(-1), /^rtmp:\/\//);
    assert.ok(rtmp.args.includes("libx264"));
    assert.ok(rtmp.args.includes("nal-hrd=cbr:force-cfr=1"));
    const srt = publisherConfiguration({ courtNumber: 4, host: "media.example.test", user: "publisher", password: "secret123" });
    assert.equal(srt.protocol, "SRT");
    assert.match(srt.args.at(-1), /^srt:\/\//);
    assert.match(srt.args.at(-1), /streamid=publish:court4_raw/);
    assert.throws(() => publisherConfiguration({ courtNumber: 4, host: "media.example.test;rm", user: "publisher", password: "secret123" }), /host name/);
  });

  it("fails capability preflight when the selected FFmpeg cannot publish the required protocol", () => {
    const encoders = " V..... libx264 H.264 encoder\n A..... aac AAC encoder\n";
    assert.deepEqual(ffmpegCapabilityProblems("Input:\n rtmp\n srt\n", encoders, "SRT"), []);
    assert.deepEqual(ffmpegCapabilityProblems("Input:\n rtmp\n", encoders, "SRT"), [
      "FFmpeg does not support the required SRT protocol"
    ]);
    assert.deepEqual(ffmpegCapabilityProblems("Input:\n srt\n", " A..... aac AAC encoder\n", "SRT"), [
      "FFmpeg does not provide the required libx264 encoder"
    ]);
  });

  it("reports an exited publisher only once per child generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scorecheck-test-feed-"));
    const executable = join(directory, "fail-publisher");
    await writeFile(executable, "#!/bin/sh\nexit 8\n");
    await chmod(executable, 0o755);
    const failures = [];
    const publisher = new SyntheticPublisher({
      ffmpegPath: executable,
      configuration: { args: [], secrets: [] },
      onUnexpectedExit: (error) => failures.push(error.message)
    });
    try {
      await publisher.start();
      await sleep(100);
      assert.equal(failures.length, 1);
      await publisher.start();
      await sleep(100);
      assert.equal(failures.length, 2);
    } finally {
      await publisher.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("permits only one containment restart across repeated publisher failures", async () => {
    const rows = [];
    const publisher = {
      configuration: { protocol: "SRT" },
      running: true,
      startCount: 0,
      stopCount: 0,
      setMode() {},
      async start() {
        this.startCount += 1;
        this.running = true;
      },
      async stop() {
        this.stopCount += 1;
        this.running = false;
      }
    };
    const controller = new TestFeedController(
      { courtNumber: 4, scenario: "publisher-loss" },
      {
        fetchSnapshot: async () => ({}),
        publisher,
        audit: { write: async (row) => rows.push(row) },
        sleep: async () => undefined
      }
    );
    controller.phase = "BASELINE_READY";

    await controller.publisherFailed(new Error("first failure"));
    assert.equal(publisher.startCount, 1);
    assert.equal(controller.publisherRestartAttempts, 1);
    assert.equal(rows.filter((row) => row.transition === "PUBLISHER_RESTART").length, 1);

    await controller.publisherFailed(new Error("second failure"));
    assert.equal(publisher.startCount, 1);
    assert.equal(publisher.stopCount, 1);
    assert.equal(rows.filter((row) => row.transition === "PUBLISHER_RESTART_LIMIT_REACHED").length, 1);
    assert.equal(controller.abortController.signal.aborted, true);
  });
});

const NOW = Date.parse("2026-07-15T06:00:00.000Z");

function snapshot(patch = {}) {
  const selected = court(4, {
    overallState: patch.selectedState ?? "EXPECTED_OFF",
    expectation: patch.expectation ?? offExpectation(),
    paths: Object.fromEntries([
      ["raw", patch.raw],
      ["preview", patch.preview],
      ["program", patch.program]
    ].filter(([, value]) => value)),
    browser: patch.browser ?? null,
    faultGate: patch.gates?.find((entry) => entry.courtNumber === 4) ?? null
  });
  return {
    generatedAt: new Date(NOW - 1_000).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 6, agentsFresh: 6 },
    event: patch.event ?? null,
    notifications: { state: "HEALTHY", pushover: { configured: true } },
    deadMan: { state: "HEALTHY", phoneChannel: { state: "HEALTHY" } },
    faultGates: patch.gates ?? [],
    incidents: patch.incidents ?? [],
    courts: [court(3, { overallState: patch.peerState ?? "EXPECTED_OFF" }), selected, court(5)]
  };
}

function snapshotWith(base, patch) {
  const selected = base.courts.find((entry) => entry.courtNumber === 4);
  return {
    ...base,
    courts: base.courts.map((entry) => entry.courtNumber === 4 ? {
      ...selected,
      paths: {
        ...selected.paths,
        ...(patch.program ? { program: patch.program } : {}),
        ...(patch.preview ? { preview: patch.preview } : {})
      },
      browser: patch.browser ?? selected.browser
    } : entry)
  };
}

function court(courtNumber, patch = {}) {
  return {
    courtNumber,
    overallState: patch.overallState ?? "EXPECTED_OFF",
    stages: [],
    paths: patch.paths ?? {},
    browser: patch.browser ?? null,
    expectation: patch.expectation ?? offExpectation(),
    faultGate: patch.faultGate ?? null
  };
}

function rawPath(patch = {}) {
  return {
    ready: true,
    readySince: "2026-07-15T05:59:00.000Z",
    inboundBitrateBps: 2_650_000,
    readerCount: 0,
    frameErrors: 0,
    sourceProtocol: "SRT",
    sourceMode: "PUSH",
    videoCodec: "H264",
    videoWidth: 1280,
    videoHeight: 720,
    audioCodec: "AAC",
    audioSampleRateHz: 48_000,
    audioChannelCount: 2,
    ...patch
  };
}

function branchPath(branch, patch = {}) {
  return {
    branch,
    ready: true,
    readySince: "2026-07-15T05:59:10.000Z",
    inboundBitrateBps: 2_500_000,
    readerCount: 1,
    frameErrors: 0,
    ...patch
  };
}

function browser(patch = {}) {
  return {
    sampledAt: "2026-07-15T05:59:59.000Z",
    receivedAt: "2026-07-15T05:59:59.000Z",
    pageLoadedAt: "2026-07-15T05:59:00.000Z",
    video: {
      state: "playing",
      connectionState: "connected",
      framesPerSecond: 30,
      packetsLost: 0,
      reconnectCount: 0,
      reloadCount: 0,
      ...(patch.video ?? {})
    },
    visual: {
      sampledAt: "2026-07-15T05:59:59.000Z",
      frozenDurationMs: 0,
      blackDurationMs: 0,
      ...(patch.visual ?? {})
    },
    commentary: {
      cameraTrackPresent: true,
      secondsSinceCameraAudio: 0,
      ...(patch.commentary ?? {})
    }
  };
}

function gate(profile) {
  return {
    courtNumber: 4,
    profile,
    actor: "test",
    reason: "isolated test feed",
    armedAt: "2026-07-15T05:59:00.000Z",
    expiresAt: "2026-07-15T06:15:00.000Z"
  };
}

function gateExpectation(profile) {
  return {
    coveragePhase: profile === "PROGRAM_CONTENT" ? "LIVE_MATCH" : "WARMUP",
    mediaExpectation: "REQUIRED",
    broadcastExpectation: "OFF",
    commentaryExpectation: "NONE",
    scoringExpectation: "NONE",
    overrideExpiresAt: "2026-07-15T06:15:00.000Z"
  };
}

function offExpectation() {
  return {
    coveragePhase: "OFF",
    mediaExpectation: "OFF",
    broadcastExpectation: "OFF",
    commentaryExpectation: "NONE",
    scoringExpectation: "NONE",
    overrideExpiresAt: null
  };
}
