import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommunityMediaOpenedResourceError,
  communityMediaBrokerConfig,
  communityMediaUpstreamConfig,
  communityWhepOfferUrl,
  normalizeCommunityPreviewPath,
  openUpstreamWhep,
  readBoundedSdp,
  releaseUpstreamWhepResource,
  validateCommunityRequestOrigin,
  type CommunityMediaBrokerConfig
} from "../lib/mediaBroker";

const config: CommunityMediaBrokerConfig = {
  baseUrl: new URL("https://edge.example.com/webrtc"),
  authorization: "Basic dXNlcjpwYXNz",
  maxPerCourt: 25,
  maxTotal: 100
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("community media broker", () => {
  it("allows only the undelayed preview path", () => {
    expect(normalizeCommunityPreviewPath(4, null)).toBe("court4_preview");
    expect(normalizeCommunityPreviewPath(4, "court4_preview")).toBe("court4_preview");
    expect(() => normalizeCommunityPreviewPath(4, "court7_preview")).toThrow(/not permitted/i);
    expect(() => normalizeCommunityPreviewPath(4, "court4_program")).toThrow(/not permitted/i);
    expect(() => normalizeCommunityPreviewPath(4, "court4_raw")).toThrow(/not permitted/i);
    expect(communityWhepOfferUrl(config, "court4_preview").toString())
      .toBe("https://edge.example.com/webrtc/court4_preview/whep");
  });

  it("requires exact same-origin signaling requests", () => {
    expect(validateCommunityRequestOrigin("https://score.example.com/api/media", "https://score.example.com")).toBe(true);
    expect(validateCommunityRequestOrigin("https://score.example.com/api/media", "https://evil.example.com")).toBe(false);
    expect(validateCommunityRequestOrigin("https://score.example.com/api/media", null)).toBe(false);
  });

  it("accepts bounded SDP and rejects other media types", async () => {
    await expect(readBoundedSdp(new Request("https://score.example.com", {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\n"
    }))).resolves.toBe("v=0\r\n");
    await expect(readBoundedSdp(new Request("https://score.example.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }))).rejects.toMatchObject({ status: 415 });
    await expect(readBoundedSdp(new Request("https://score.example.com", {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v".repeat(128 * 1024 + 1)
    }))).rejects.toMatchObject({ status: 413, code: "MEDIA_BODY_TOO_LARGE" });
  });

  it("keeps the edge credential, resource URL, and affinity cookie server-side", async () => {
    const fetchMock = vi.fn(async () => new Response("v=0\r\nanswer", {
      status: 201,
      headers: {
        location: "/webrtc/court4_preview/whep/session-1",
        "set-cookie": "SERVERID=edge-a; Path=/; Secure; HttpOnly"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await openUpstreamWhep({ config, previewPath: "court4_preview", offerSdp: "v=0\r\noffer" });

    expect(result).toEqual({
      answerSdp: "v=0\r\nanswer",
      upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
      upstreamAffinityCookie: "SERVERID=edge-a"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://edge.example.com/webrtc/court4_preview/whep"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ authorization: config.authorization })
      })
    );
  });

  it("rejects an upstream redirect or resource outside the admitted edge path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("v=0", {
      status: 201,
      headers: { location: "https://evil.example.com/court4_preview/whep/session-1" }
    })));
    await expect(openUpstreamWhep({ config, previewPath: "court4_preview", offerSdp: "v=0" }))
      .rejects.toMatchObject({ code: "MEDIA_UPSTREAM_INVALID" });
  });

  it.each([
    "/webrtc/court7_preview/whep/session-1",
    "/webrtc/court4_preview/whep/session-1/child",
    "/webrtc/court4_preview/whep/session-1?token=secret",
    "/webrtc/court4_preview/whep/session-1#fragment",
    "https://user:pass@edge.example.com/webrtc/court4_preview/whep/session-1"
  ])("rejects a Location that is not one opaque child of the offered court resource: %s", async (location) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("v=0", {
      status: 201,
      headers: { location }
    })));

    await expect(openUpstreamWhep({ config, previewPath: "court4_preview", offerSdp: "v=0" }))
      .rejects.toMatchObject({ code: "MEDIA_UPSTREAM_INVALID" });
  });

  it("stops reading an oversized upstream answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("v".repeat(128 * 1024 + 1), {
      status: 201,
      headers: { location: "/webrtc/court4_preview/whep/session-oversized" }
    })));
    await expect(openUpstreamWhep({ config, previewPath: "court4_preview", offerSdp: "v=0" }))
      .rejects.toMatchObject({ code: "MEDIA_UPSTREAM_INVALID" });
  });

  it("preserves validated cleanup metadata when a post-201 answer is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", {
      status: 201,
      headers: {
        location: "/webrtc/court4_preview/whep/session-empty",
        "set-cookie": "SERVERID=edge-a; Path=/; Secure; HttpOnly"
      }
    })));

    const error = await openUpstreamWhep({ config, previewPath: "court4_preview", offerSdp: "v=0" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommunityMediaOpenedResourceError);
    expect(error).toMatchObject({
      code: "MEDIA_UPSTREAM_INVALID",
      openedResource: {
        upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-empty",
        upstreamAffinityCookie: "SERVERID=edge-a"
      }
    });
  });

  it("rejects using the MediaMTX origin hostname as the community read edge", () => {
    vi.stubEnv("COMMUNITY_MEDIA_WHEP_BASE_URL", "https://origin.example.com/read-edge");
    vi.stubEnv("COMMUNITY_MEDIA_READ_USER", "reader");
    vi.stubEnv("COMMUNITY_MEDIA_READ_PASS", "secret");
    vi.stubEnv("MEDIAMTX_WHEP_BASE_URL", "https://origin.example.com:9443/webrtc");

    expect(() => communityMediaUpstreamConfig()).not.toThrow();
    expect(() => communityMediaBrokerConfig()).toThrow(/isolated/i);
  });

  it("keeps admission fail-closed unless both capacity limits are positive and coherent", () => {
    vi.stubEnv("COMMUNITY_MEDIA_WHEP_BASE_URL", "https://edge.example.com/webrtc");
    vi.stubEnv("COMMUNITY_MEDIA_READ_USER", "reader");
    vi.stubEnv("COMMUNITY_MEDIA_READ_PASS", "secret");
    vi.stubEnv("MEDIAMTX_WHEP_BASE_URL", "https://origin.example.com/webrtc");
    vi.stubEnv("COMMUNITY_MEDIA_MAX_PER_COURT", "0");
    vi.stubEnv("COMMUNITY_MEDIA_MAX_TOTAL", "100");
    expect(() => communityMediaBrokerConfig()).toThrow(/capacity/i);

    vi.stubEnv("COMMUNITY_MEDIA_MAX_PER_COURT", "101");
    expect(() => communityMediaBrokerConfig()).toThrow(/capacity/i);

    vi.stubEnv("COMMUNITY_MEDIA_MAX_PER_COURT", "25");
    expect(communityMediaBrokerConfig()).toMatchObject({ maxPerCourt: 25, maxTotal: 100 });
  });

  it("releases the exact validated WHEP resource with server-only affinity", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await releaseUpstreamWhepResource({
      config,
      upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
      upstreamAffinityCookie: "SERVERID=edge-a"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://edge.example.com/webrtc/court4_preview/whep/session-1",
      expect.objectContaining({
        method: "DELETE",
        redirect: "error",
        headers: {
          authorization: config.authorization,
          cookie: "SERVERID=edge-a"
        }
      })
    );
  });

  it.each([
    "https://edge.example.com/webrtc/court4_preview/whep/session-1?token=secret",
    "https://edge.example.com/webrtc/court4_preview/whep/session-1#fragment",
    "https://edge.example.com/webrtc/court4_preview/whep/session-1/child"
  ])("refuses unsafe persisted cleanup resource URLs: %s", async (upstreamResourceUrl) => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(releaseUpstreamWhepResource({
      config,
      upstreamResourceUrl,
      upstreamAffinityCookie: null
    })).rejects.toMatchObject({ code: "MEDIA_UPSTREAM_INVALID" });
  });
});
