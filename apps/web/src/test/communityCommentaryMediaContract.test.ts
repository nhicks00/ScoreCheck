import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const commentaryClient = read("src/app/commentary/court/[courtNumber]/CommentaryCourtClient.tsx");
const commentaryAudioClient = read("src/app/commentary/court/[courtNumber]/CommentaryAudioClient.tsx");
const commentaryPage = read("src/app/commentary/court/[courtNumber]/page.tsx");
const sessionClient = read("src/app/score/session/CommunityWitnessSessionClient.tsx");

describe("commentary community-media hard cut", () => {
  it("does not resolve or pass browser-visible MediaMTX sources", () => {
    expect(commentaryPage).not.toContain("@/lib/video");
    expect(commentaryPage).not.toContain("courtStreamSources");
    expect(commentaryPage).not.toContain("preview_stream_path");
    expect(commentaryClient).not.toContain("@/components/StreamPlayer");
    expect(commentaryClient).not.toContain("videoMode");
    expect(commentaryClient).not.toMatch(/sources\s*:/);
  });

  it("uses one brokered WHEP player for scoring qualification and commentary timing", () => {
    expect(commentaryClient).toContain("onPreviewTiming={updatePreviewTiming}");
    expect(sessionClient).toContain('sources={{ whepUrl: "/api/community/session/media/whep", hlsUrl: null }}');
    expect(sessionClient).toContain('mode="scoring"');
    expect(sessionClient).toContain("onTimingSample={onPreviewTiming}");
    expect(sessionClient).toContain("onScoringQualification={handleScoringQualification}");
  });

  it("captures action-time evidence for remote designated scorers while preserving the verified physical-court exemption", () => {
    expect(sessionClient).toContain("streamPlayerRef.current?.capturePlaybackEvidence({ baseRevision: snapshot.score.revision })");
    expect(sessionClient).toContain('snapshot.assignment.role === "DESIGNATED_SCORER"');
    expect(sessionClient).toContain('snapshot.assignment.trustTier !== "VERIFIED_COURTSIDE"');
    expect(sessionClient).not.toContain('"embedded" | "external"');
  });

  it("keeps the microphone meter graph running without audible local output", () => {
    expect(commentaryAudioClient).toContain("await startMicrophoneMeter(track, setLevel)");
    expect(commentaryAudioClient).toContain("silentSink.gain.value = 0");
    expect(commentaryAudioClient).toContain("analyser.connect(silentSink)");
    expect(commentaryAudioClient).toContain("silentSink.connect(context.destination)");
    expect(commentaryAudioClient).toContain("await context.resume()");
    expect(commentaryAudioClient).toContain('context.state !== "running"');
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
