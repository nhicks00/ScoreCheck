import { describe, expect, it } from "vitest";
import { inheritMediaAuthorization, whepResourceUrl } from "../lib/mediaAuthorization";

describe("derived media authorization", () => {
  it("carries scoped credentials to same-origin HLS playlists and segments", () => {
    const source = "https://media.example.com/court1_program/index.m3u8?user=event_reader&pass=secret";
    expect(inheritMediaAuthorization("segment-42.mp4", source)).toBe(
      "https://media.example.com/court1_program/segment-42.mp4?user=event_reader&pass=secret"
    );
    expect(inheritMediaAuthorization(
      "https://other.example.com/segment-42.mp4",
      source
    )).toBe("https://other.example.com/segment-42.mp4");
  });

  it("carries scoped credentials to an opaque WHEP session resource", () => {
    const offer = "https://media.example.com/court1_program/whep?user=event_reader&pass=secret";
    expect(whepResourceUrl("/court1_program/whep/session-1", offer)).toBe(
      "https://media.example.com/court1_program/whep/session-1?user=event_reader&pass=secret"
    );
  });
});
