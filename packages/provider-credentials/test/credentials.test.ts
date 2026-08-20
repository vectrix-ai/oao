import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCredentialCipher } from "../src/index.js";

const context = {
  organizationId: "org-1",
  projectId: "project-1",
  providerId: "provider-1",
  providerType: "openrouter" as const,
  keyVersion: 1,
};

test("provider credentials round-trip without exposing plaintext metadata", () => {
  const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.encrypt("sk-provider-secret", context);
  assert.notEqual(encrypted.ciphertext.toString(), "sk-provider-secret");
  assert.equal(encrypted.nonce.length, 12);
  assert.equal(encrypted.tag.length, 16);
  assert.match(encrypted.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(cipher.decrypt(encrypted, context), "sk-provider-secret");
});

test("tenant and provider identity are authenticated as associated data", () => {
  const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 9));
  const encrypted = cipher.encrypt("sk-provider-secret", context);
  assert.throws(
    () =>
      cipher.decrypt(encrypted, {
        ...context,
        projectId: "another-project",
      }),
    /could not be decrypted/u,
  );
  assert.throws(
    () =>
      cipher.decrypt(encrypted, {
        ...context,
        providerType: "openai",
      }),
    /could not be decrypted/u,
  );
});

test("structured temporary credentials fit inside the encrypted provider envelope", () => {
  const cipher = new ProviderCredentialCipher(Buffer.alloc(32, 3));
  const structured = JSON.stringify({
    accessKeyId: "temporary-access-key",
    secretAccessKey: "temporary-secret-access-key",
    sessionToken: "t".repeat(8_192),
  });
  const encrypted = cipher.encrypt(structured, {
    ...context,
    providerType: "s3",
  });
  assert.equal(
    cipher.decrypt(encrypted, { ...context, providerType: "s3" }),
    structured,
  );
});
