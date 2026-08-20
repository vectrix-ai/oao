import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 16_384;

export interface ProviderCredentialContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly providerType: "openrouter" | "openai" | "daytona" | "s3";
  readonly keyVersion: number;
}

export interface EncryptedProviderCredential {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
  readonly fingerprint: string;
}

function aad(context: ProviderCredentialContext): Buffer {
  const fields = [
    context.organizationId,
    context.projectId,
    context.providerId,
    context.providerType,
    String(context.keyVersion),
  ];
  return Buffer.from(
    fields.map((value) => `${value.length}:${value}`).join("|"),
  );
}

export function parseCredentialEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (
    key.length !== KEY_BYTES ||
    key.toString("base64").replace(/=+$/u, "") !==
      value.trim().replace(/=+$/u, "")
  )
    throw new TypeError(
      "OAO_CREDENTIAL_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key",
    );
  return key;
}

export class ProviderCredentialCipher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES)
      throw new TypeError(
        "Provider credential encryption key must be 32 bytes",
      );
    this.#key = Buffer.from(key);
  }

  static fromBase64(value: string): ProviderCredentialCipher {
    return new ProviderCredentialCipher(parseCredentialEncryptionKey(value));
  }

  encrypt(
    apiKey: string,
    context: ProviderCredentialContext,
  ): EncryptedProviderCredential {
    if (apiKey.length < 8 || Buffer.byteLength(apiKey) > MAX_CREDENTIAL_BYTES)
      throw new TypeError(
        "Provider credential must contain between 8 and 16384 bytes",
      );
    if (!Number.isInteger(context.keyVersion) || context.keyVersion < 1)
      throw new TypeError("Credential key version must be a positive integer");
    const nonce = randomBytes(NONCE_BYTES);
    const plaintext = Buffer.from(apiKey, "utf8");
    try {
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        ciphertext,
        nonce,
        tag: cipher.getAuthTag(),
        keyVersion: context.keyVersion,
        fingerprint: createHash("sha256").update(plaintext).digest("hex"),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(
    encrypted: Pick<
      EncryptedProviderCredential,
      "ciphertext" | "nonce" | "tag" | "keyVersion"
    >,
    context: Omit<ProviderCredentialContext, "keyVersion">,
  ): string {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        encrypted.nonce,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(aad({ ...context, keyVersion: encrypted.keyVersion }));
      decipher.setAuthTag(encrypted.tag);
      const plaintext = Buffer.concat([
        decipher.update(encrypted.ciphertext),
        decipher.final(),
      ]);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error("Provider credential could not be decrypted");
    }
  }
}
