import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "./notifications.js";

describe("notification provider validation", () => {
  it("accepts only the exact Twilio callback signature", () => {
    const token = "test-auth-token";
    const url = "https://monitor.example.test/v1/provider/twilio/status";
    const params = { MessageStatus: "delivered", MessageSid: "SM0123456789" };
    const material = url + Object.keys(params).sort().map((key) => `${key}${params[key as keyof typeof params]}`).join("");
    const signature = crypto.createHmac("sha1", token).update(material).digest("base64");
    expect(validateTwilioSignature(token, url, params, signature)).toBe(true);
    expect(validateTwilioSignature(token, url, { ...params, MessageStatus: "failed" }, signature)).toBe(false);
    expect(validateTwilioSignature(token, url, params, "invalid")).toBe(false);
  });
});
