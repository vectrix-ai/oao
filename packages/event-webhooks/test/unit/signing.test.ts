import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  generateWebhookSecret,
  parseWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
} from "../../src/index.js";

// Test vector from the Standard Webhooks reference implementations.
const vector = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  webhookId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

test("signatures match the Standard Webhooks reference vector", () => {
  assert.equal(signWebhook(vector, [vector.secret]), vector.signature);
  assert.equal(
    verifyWebhookSignature({
      ...vector,
      signatureHeader: vector.signature,
      now: vector.timestamp,
    }),
    true,
  );
});

test("rotation signs with every active secret and either one verifies", () => {
  const current = generateWebhookSecret();
  const previous = generateWebhookSecret();
  const input = { webhookId: "batch-1", timestamp: 1_800_000_000, body: "{}" };
  const header = signWebhook(input, [current, previous]);
  assert.equal(header.split(" ").length, 2);
  for (const secret of [current, previous])
    assert.equal(
      verifyWebhookSignature({
        ...input,
        signatureHeader: header,
        secret,
        now: input.timestamp,
      }),
      true,
    );
});

test("verification rejects tampering, stale timestamps, and unknown versions", () => {
  const secret = generateWebhookSecret();
  const input = { webhookId: "batch-2", timestamp: 1_800_000_000, body: "{}" };
  const header = signWebhook(input, [secret]);
  const verify = (
    overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>,
  ) =>
    verifyWebhookSignature({
      ...input,
      signatureHeader: header,
      secret,
      now: input.timestamp,
      ...overrides,
    });
  assert.equal(verify({ body: '{"changed":true}' }), false);
  assert.equal(verify({ webhookId: "batch-3" }), false);
  assert.equal(verify({ now: input.timestamp + 301 }), false);
  assert.equal(verify({ secret: generateWebhookSecret() }), false);
  assert.equal(
    verify({ signatureHeader: header.replace("v1,", "v2,") }),
    false,
  );
  assert.equal(verify({ signatureHeader: "v1,AAAA" }), false);
});

test("generated secrets are canonical and malformed secrets are rejected", () => {
  const secret = generateWebhookSecret();
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/u);
  assert.equal(parseWebhookSecret(secret).length, 32);
  assert.throws(() => parseWebhookSecret(secret.slice(6)));
  assert.throws(() => parseWebhookSecret("whsec_c2hvcnQ="));
  const key = parseWebhookSecret(secret);
  assert.equal(createHmac("sha256", key).update("x").digest("hex").length, 64);
});
