/**
 * Webhook security tests
 *
 * Tests for timing-safe HMAC verification, fail-closed behavior,
 * and delivery deduplication.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createHmac } from "crypto";
import {
  verifySignature,
  cleanupExpiredDeliveries,
  handleRequest,
  _testing,
} from "../webhook/handler.js";

const TEST_SECRET = "test-webhook-secret-1234";

/** Generate a valid HMAC signature for a payload */
function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** Build a minimal POST request that looks like a GitHub webhook */
function makeWebhookRequest(
  body: string,
  options: {
    signature?: string;
    event?: string;
    deliveryId?: string;
  } = {},
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Event": options.event ?? "ping",
    "X-Hub-Signature-256": options.signature ?? "",
  });
  if (options.deliveryId) {
    headers.set("X-GitHub-Delivery", options.deliveryId);
  }
  return new Request("http://localhost:3000/", {
    method: "POST",
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
describe("verifySignature", () => {
  const payload = '{"action":"ping"}';

  test("valid signature passes verification", () => {
    const sig = signPayload(payload, TEST_SECRET);
    expect(verifySignature(payload, sig, TEST_SECRET)).toBe(true);
  });

  test("invalid signature is rejected", () => {
    const sig = signPayload(payload, "wrong-secret");
    expect(verifySignature(payload, sig, TEST_SECRET)).toBe(false);
  });

  test("empty secret fails closed (returns false)", () => {
    const sig = signPayload(payload, TEST_SECRET);
    expect(verifySignature(payload, sig, "")).toBe(false);
  });

  test("undefined secret fails closed (returns false)", () => {
    const sig = signPayload(payload, TEST_SECRET);
    // Pass undefined explicitly — should fall back to WEBHOOK_SECRET env,
    // which is empty in the test environment
    expect(verifySignature(payload, sig, undefined)).toBe(false);
  });

  test("correct length but wrong content is rejected (timing-safe)", () => {
    // Produce a signature string of the correct length but different content
    const validSig = signPayload(payload, TEST_SECRET);
    // Flip the last hex character
    const lastChar = validSig[validSig.length - 1];
    const flipped = lastChar === "0" ? "1" : "0";
    const wrongSig = validSig.slice(0, -1) + flipped;

    expect(wrongSig.length).toBe(validSig.length);
    expect(verifySignature(payload, wrongSig, TEST_SECRET)).toBe(false);
  });

  test("mismatched buffer lengths return false (not throw)", () => {
    // A very short signature — different length than expected HMAC
    expect(verifySignature(payload, "sha256=abc", TEST_SECRET)).toBe(false);
    // An empty signature
    expect(verifySignature(payload, "", TEST_SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery deduplication
// ---------------------------------------------------------------------------
describe("webhook delivery deduplication", () => {
  const body = '{"action":"ping"}';

  beforeEach(() => {
    // Clear the dedup map between tests
    _testing.seenDeliveries.clear();
    // Ensure the env secret is set so signature verification passes
    process.env.GITHUB_APP_SECRET = TEST_SECRET;
  });

  test("duplicate delivery ID is rejected with already_processed", async () => {
    const sig = signPayload(body, TEST_SECRET);
    const deliveryId = "dup-test-1234";

    // First request should succeed
    const req1 = makeWebhookRequest(body, { signature: sig, deliveryId });
    const res1 = await handleRequest(req1);
    expect(res1.status).toBe(200);
    const text1 = await res1.text();
    expect(text1).toBe("OK");

    // Second request with same delivery ID should be deduped
    const req2 = makeWebhookRequest(body, { signature: sig, deliveryId });
    const res2 = await handleRequest(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2).toEqual({ status: "already_processed" });
  });

  test("new delivery ID is accepted", async () => {
    const sig = signPayload(body, TEST_SECRET);

    const req = makeWebhookRequest(body, {
      signature: sig,
      deliveryId: "new-delivery-5678",
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("expired entries are cleaned up after TTL", () => {
    const now = Date.now();

    // Insert an old entry (older than DEDUP_TTL_MS)
    _testing.seenDeliveries.set("old-entry", now - _testing.DEDUP_TTL_MS - 1);
    // Insert a fresh entry
    _testing.seenDeliveries.set("fresh-entry", now);

    expect(_testing.seenDeliveries.size).toBe(2);

    cleanupExpiredDeliveries();

    expect(_testing.seenDeliveries.has("old-entry")).toBe(false);
    expect(_testing.seenDeliveries.has("fresh-entry")).toBe(true);
    expect(_testing.seenDeliveries.size).toBe(1);
  });
});
