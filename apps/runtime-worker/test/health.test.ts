import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("runtime worker exposes health endpoints without a fake demo command", async () => {
  const source = await readFile(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/healthz/u);
  assert.match(source, /\/readyz/u);
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.ok(manifest.scripts.start);
  assert.equal(manifest.scripts.demo, undefined);
});
