import { describe, expect, it } from "vitest";
import { configureAuthenticatedHlsRequest, inheritMediaAuthorization, whepResourceUrl } from "../lib/mediaAuthorization";

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

  it("allows MediaMTX to retain one cross-origin HLS session cookie", () => {
    const calls: unknown[][] = [];
    const xhr = {
      withCredentials: false,
      open: (...args: unknown[]) => calls.push(args)
    } as unknown as XMLHttpRequest;

    configureAuthenticatedHlsRequest(
      xhr,
      "segment-42.mp4",
      "https://media.example.com/court1_program/index.m3u8?user=event_reader&pass=secret"
    );

    expect(calls).toEqual([[
      "GET",
      "https://media.example.com/court1_program/segment-42.mp4?user=event_reader&pass=secret",
      true
    ]]);
    expect(xhr.withCredentials).toBe(true);
  });
});
