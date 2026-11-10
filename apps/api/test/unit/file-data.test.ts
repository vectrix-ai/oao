import assert from "node:assert/strict";
import test from "node:test";
import { DEVELOPMENT_PRINCIPAL, DevelopmentAuthAdapter } from "@oao/auth-core";
import type { PgPool } from "@oao/db-postgres";
import { createApiApp } from "../../src/app.js";
import { HttpApiError } from "../../src/errors.js";
import { decodeCanonicalBase64 } from "../../src/http.js";
import type { RuntimeCommandPort } from "../../src/runtime-commands.js";
import { PostgresApiStore } from "../../src/store.js";

const MIB = 1024 * 1024;
const MAX_RUN_FILE_BYTES = 10 * MIB;
const MAX_SKILL_FILE_BYTES = 5 * MIB;
const projectPath = `/v1/projects/${DEVELOPMENT_PRINCIPAL.projectId}`;

// Every request below is rejected before the API opens a transaction, so the
// pool and the runtime command port must never be reached.
const unusedPool = {
  query: async () => {
    throw new Error("the database is not expected in this unit test");
  },
} as unknown as PgPool;
const unusedRuntimeCommands: RuntimeCommandPort = {
  enqueue: async () => {
    throw new Error("runtime commands are not expected in this unit test");
  },
};

function app() {
  return createApiApp({
    store: new PostgresApiStore(unusedPool, "unit-test-api-key-pepper"),
    auth: new DevelopmentAuthAdapter(),
    runtimeCommands: unusedRuntimeCommands,
  });
}

function jsonRequest(
  method: "POST" | "PUT",
  body: Readonly<Record<string, unknown>>,
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": `file-data-${Math.random()}`,
    },
    body: JSON.stringify(body),
  };
}

/** The status and error envelope of a response, without its request ID. */
async function errorOf(
  response: Response,
): Promise<{ status: number; code: string; message: string }> {
  const { error } = (await response.json()) as {
    error: { code: string; message: string };
  };
  return { status: response.status, code: error.code, message: error.message };
}

/** A PDF-like payload of the given size, filled so it is not trivially uniform. */
function pdfBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1)
    bytes[index] = (index * 31 + 7) & 0xff;
  bytes.write("%PDF-1.7\n", 0, "latin1");
  return bytes;
}

test("canonical base64 decoding accepts every padding length", () => {
  for (const text of ["", "a", "ab", "abc", "abcd"]) {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    assert.equal(
      decodeCanonicalBase64(encoded, "bad").toString("utf8"),
      text,
      encoded,
    );
  }
});

test("canonical base64 decoding rejects input Buffer would silently repair", () => {
  for (const encoded of [
    "YQ", // missing padding
    "YQ=", // short padding
    "YQ===", // extra padding
    "YR==", // non-zero padding bits
    "YWJj\nZA==", // embedded newline
    "YW Jj", // embedded space
    "-_-_", // URL-safe alphabet
    "YQ==YQ==", // padding in the middle
    "YWJj!", // character outside the alphabet
  ])
    assert.throws(
      () => decodeCanonicalBase64(encoded, "File data must be canonical"),
      (error: unknown) =>
        error instanceof HttpApiError &&
        error.code === "bad_request" &&
        error.message === "File data must be canonical",
      JSON.stringify(encoded),
    );
});

test("canonical base64 decoding handles a file at the run-file size limit", () => {
  const bytes = pdfBytes(MAX_RUN_FILE_BYTES);
  const decoded = decodeCanonicalBase64(bytes.toString("base64"), "bad");
  assert.ok(decoded.equals(bytes));
});

test("session creation accepts a run file at the 10 MiB limit", async () => {
  // The title is checked after the files, so a title error proves that the
  // 10 MiB file passed validation instead of failing with a server error.
  const response = await app().request(
    `${projectPath}/sessions`,
    jsonRequest("POST", {
      agentId: "00000000-0000-4000-8000-000000000010",
      title: 42,
      files: [
        {
          name: "large-order.pdf",
          contentType: "application/pdf",
          dataBase64: pdfBytes(MAX_RUN_FILE_BYTES).toString("base64"),
        },
      ],
    }),
  );
  assert.deepEqual(await errorOf(response), {
    status: 400,
    code: "bad_request",
    message: "title must be a non-empty string of at most 500 characters",
  });
});

test("session creation rejects large run files that are too big or not canonical", async () => {
  const oversized = await app().request(
    `${projectPath}/sessions`,
    jsonRequest("POST", {
      agentId: "00000000-0000-4000-8000-000000000010",
      files: [
        {
          name: "too-large.pdf",
          contentType: "application/pdf",
          dataBase64: pdfBytes(MAX_RUN_FILE_BYTES + 1).toString("base64"),
        },
      ],
    }),
  );
  assert.deepEqual(await errorOf(oversized), {
    status: 400,
    code: "bad_request",
    message: `Each file must contain from 1 through ${MAX_RUN_FILE_BYTES} bytes`,
  });

  const encoded = pdfBytes(MAX_RUN_FILE_BYTES - 3).toString("base64");
  const wrapped = await app().request(
    `${projectPath}/sessions`,
    jsonRequest("POST", {
      agentId: "00000000-0000-4000-8000-000000000010",
      files: [
        {
          name: "wrapped.pdf",
          contentType: "application/pdf",
          // A MIME-style line break, which Buffer would decode without complaint.
          dataBase64: `${encoded.slice(0, 76)}\n${encoded.slice(76)}`,
        },
      ],
    }),
  );
  assert.deepEqual(await errorOf(wrapped), {
    status: 400,
    code: "bad_request",
    message: "File data must be canonical base64",
  });
});

test("Skill creation accepts a resource at the 5 MiB limit", async () => {
  // displayName is checked after the files, so its error proves the resource
  // passed validation.
  const response = await app().request(
    `${projectPath}/skills`,
    jsonRequest("POST", {
      name: "large-reference",
      description: "Carries a large reference file.",
      instructions: "Read the reference before answering.",
      displayName: 42,
      files: [
        {
          path: "references/catalog.pdf",
          contentType: "application/pdf",
          dataBase64: pdfBytes(MAX_SKILL_FILE_BYTES).toString("base64"),
        },
      ],
    }),
  );
  assert.deepEqual(await errorOf(response), {
    status: 400,
    code: "bad_request",
    message: "displayName must be a non-empty string of at most 200 characters",
  });
});

test("Skill draft file upload accepts Markdown at the 5 MiB limit", async () => {
  // The UTF-8 check runs after decoding, so its error proves the 5 MiB file
  // decoded instead of failing with a server error.
  const markdown = Buffer.alloc(MAX_SKILL_FILE_BYTES, "#");
  markdown[markdown.length - 1] = 0;
  const response = await app().request(
    `${projectPath}/skill-drafts/00000000-0000-4000-8000-000000000020/files`,
    jsonRequest("PUT", {
      path: "references/large.md",
      contentType: "text/markdown",
      dataBase64: markdown.toString("base64"),
    }),
  );
  assert.deepEqual(await errorOf(response), {
    status: 400,
    code: "bad_request",
    message: "Skill draft Markdown must be valid UTF-8 without NUL characters",
  });
});
