import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = {
  name: "unicode-package",
  description: "Hash compatibility",
  instructions: "Read resources.",
  metadata: {
    ä: "accent",
    z: "last",
    I: "upper",
    ı: "dotless",
    tie: "plain",
    "t\u200die": "joined",
  },
  files: [
    "join.md",
    "jo\u200din.md",
    "scripts/import_contract.py",
    "scripts/import-audit.schema.json",
    "z.md",
    "ä.md",
  ].map((path) => ({
    path,
    contentType: "text/markdown",
    sizeBytes: 1,
    sha256: "a".repeat(64),
  })),
};

test("v2 hashes are locale independent and v1 en-US publications remain verifiable", () => {
  const module = fileURLToPath(
    new URL("../src/skill-package.ts", import.meta.url),
  );
  const source = `
    import { serializeSkillPackageForHash, serializeLegacySkillPackageForHash } from ${JSON.stringify(module)};
    const input = ${JSON.stringify(fixture)};
    function old(value) {
      if (Array.isArray(value)) return '[' + value.map(old).join(',') + ']';
      if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + old(v)).join(',') + '}';
      return JSON.stringify(value);
    }
    console.log(JSON.stringify({
      v2: serializeSkillPackageForHash(input), legacy: serializeLegacySkillPackageForHash(input),
      original: old({...input, schemaVersion: 1, files: [...input.files].sort((a,b) => a.path.localeCompare(b.path))}),
      reversed: serializeSkillPackageForHash({...input, metadata: Object.fromEntries(Object.entries(input.metadata).reverse()), files: [...input.files].reverse()})
    }));
  `;
  const results = ["en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"].map(
    (locale) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", source],
          {
            encoding: "utf8",
            env: { ...process.env, LANG: locale, LC_ALL: locale },
          },
        ),
      ) as { v2: string; legacy: string; original: string; reversed: string },
  );
  const first = results[0]!;
  assert.notEqual(
    first.original,
    results[1]!.original,
    "fixture must expose the old locale-dependent ordering",
  );
  for (const result of results) {
    assert.equal(result.v2, first.v2);
    assert.equal(result.reversed, first.v2);
    assert.equal(result.legacy, first.original);
  }
  assert.equal(JSON.parse(first.v2).schemaVersion, 2);
  assert.deepEqual(
    JSON.parse(first.v2).files.map((f: { path: string }) => f.path),
    [
      "join.md",
      "jo\u200din.md",
      "scripts/import-audit.schema.json",
      "scripts/import_contract.py",
      "z.md",
      "ä.md",
    ],
  );
});
