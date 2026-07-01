import jwt from "jsonwebtoken";
import { getEnv } from "./env";

export function signIvsPlaybackToken(input: {
  channelArn: string;
  origin?: string;
  viewerId: string;
  privateKey?: string;
  expiresInSeconds: number;
}): string {
  const env = getEnv();
  const privateKey = normalizePem(input.privateKey ?? env.ivsPlaybackPrivateKey);
  if (!privateKey) {
    throw new Error("IVS playback signing key is not configured");
  }
  const payload = {
    "aws:channel-arn": input.channelArn,
    "aws:access-control-allow-origin": input.origin ?? env.publicSiteUrl,
    "aws:strict-origin-enforcement": true,
    "aws:viewer-id": input.viewerId.slice(0, 40),
    exp: Math.floor(Date.now() / 1000) + input.expiresInSeconds
  };
  return jwt.sign(payload, privateKey, { algorithm: "ES384" });
}

export function signedIvsPlaybackUrl(input: {
  playbackUrl: string;
  channelArn: string;
  origin?: string;
  viewerId: string;
  privateKey?: string;
  expiresInSeconds: number;
}) {
  const token = signIvsPlaybackToken(input);
  const separator = input.playbackUrl.includes("?") ? "&" : "?";
  return `${input.playbackUrl}${separator}token=${encodeURIComponent(token)}`;
}

function normalizePem(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}
