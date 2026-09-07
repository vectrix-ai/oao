import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { DEVELOPMENT_PRINCIPAL } from "@oao/auth-core";
import { OAuth2Client } from "google-auth-library";
import {
  GoogleIapAssertionVerifier,
  IapAuthAdapter,
  type IapAssertionVerifier,
  type IapIdentity,
} from "../src/index.ts";

const identity: IapIdentity = {
  subject: "accounts.google.com:123456789",
  email: "developer@example.test",
};

function signedIapAssertion(input: {
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly audience: string;
}): string {
  const encoded = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encoded({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${encoded(
    {
      iss: "https://cloud.google.com/iap",
      aud: input.audience,
      sub: identity.subject,
      email: "Developer@Example.Test",
      iat: now,
      exp: now + 600,
    },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(input.privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

test("verifies Google-signed claims against the exact IAP audience", async () => {
  const audience =
    "/projects/123456789/locations/europe-west1/services/oao-api";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const client = new OAuth2Client();
  let keyFetches = 0;
  Object.defineProperty(client, "getIapPublicKeys", {
    value: async () => {
      keyFetches += 1;
      return {
        pubkeys: {
          "test-key": publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
      };
    },
  });
  const assertion = signedIapAssertion({ privateKey, audience });
  const verifier = new GoogleIapAssertionVerifier({
    expectedAudience: audience,
    client,
  });
  assert.deepEqual(await verifier.verify(assertion), identity);
  assert.deepEqual(await verifier.verify(assertion), identity);
  assert.equal(keyFetches, 1);
  assert.equal(
    await new GoogleIapAssertionVerifier({
      expectedAudience:
        "/projects/123456789/locations/europe-west1/services/other-service",
      client,
    }).verify(assertion),
    undefined,
  );
});

test("authenticates only a verified IAP assertion", async () => {
  const assertions: string[] = [];
  const verifier: IapAssertionVerifier = {
    async verify(assertion) {
      assertions.push(assertion);
      return assertion === "signed" ? identity : undefined;
    },
  };
  const adapter = new IapAuthAdapter({
    verifier,
    tenants: {
      async resolvePrincipal(resolved, request) {
        assert.deepEqual(resolved, identity);
        assert.equal(new URL(request?.url ?? "").pathname, "/v1/context");
        return DEVELOPMENT_PRINCIPAL;
      },
    },
  });

  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/v1/context", {
        headers: { "x-goog-iap-jwt-assertion": "signed" },
      }),
    ),
    DEVELOPMENT_PRINCIPAL,
  );
  assert.deepEqual(assertions, ["signed"]);
});

test("rejects unsigned identity headers and invalid assertions", async () => {
  let resolverCalls = 0;
  const adapter = new IapAuthAdapter({
    verifier: {
      async verify() {
        return undefined;
      },
    },
    tenants: {
      async resolvePrincipal() {
        resolverCalls += 1;
        return DEVELOPMENT_PRINCIPAL;
      },
    },
  });

  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/v1/context", {
        headers: {
          "x-goog-authenticated-user-email":
            "accounts.google.com:user@example.test",
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    await adapter.authenticate(
      new Request("https://app.test/v1/context", {
        headers: { "x-goog-iap-jwt-assertion": "invalid" },
      }),
    ),
    undefined,
  );
  assert.equal(resolverCalls, 0);
});
