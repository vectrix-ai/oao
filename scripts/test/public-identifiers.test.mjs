import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { findPrivateIdentifiers } from "../check-public-identifiers.mjs";

const denied = new Set([
  createHash("sha256").update("acme-internal").digest("hex"),
]);

test("flags denied tokens by digest, case-insensitively", () => {
  assert.deepEqual(
    findPrivateIdentifiers("ok\nimage in ACME-internal/registry", denied),
    [{ line: 2, reason: "private deployment name" }],
  );
});

test("finds a denied repository name inside owner/name references", () => {
  assert.deepEqual(
    findPrivateIdentifiers("see github.com/acme/acme-internal.git", denied),
    [{ line: 1, reason: "private deployment name" }],
  );
});

test("matches whole tokens only", () => {
  assert.deepEqual(
    findPrivateIdentifiers("acme-internal-docs and acme_internal", denied),
    [],
  );
});

test("flags cloud identifiers outside placeholder projects", () => {
  // Assembled at runtime so the repository scan does not flag this fixture.
  const project = ["acme", "prod"].join("-");
  const text = [
    `release@${project}.iam.gserviceaccount.com`,
    `europe-west1-docker.pkg.dev/${project}/oao/oao`,
    "worker@project.iam.gserviceaccount.com",
    "europe-west1-docker.pkg.dev/example-project/oao/oao",
    "<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/oao",
  ].join("\n");
  assert.deepEqual(findPrivateIdentifiers(text, new Set()), [
    { line: 1, reason: "Google service account outside a placeholder project" },
    {
      line: 2,
      reason: "Artifact Registry repository outside a placeholder project",
    },
  ]);
});
