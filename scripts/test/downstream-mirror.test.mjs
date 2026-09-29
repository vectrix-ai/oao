import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../downstream-mirror.sh", import.meta.url),
);

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "downstream-mirror-"));
  roots.push(root);
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = Dev\n\temail = dev@example.com\n");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const upstream = join(root, "upstream");
  const downstream = join(root, "downstream.git");
  git(root, "init", "-q", "-b", "main", upstream);
  git(root, "init", "-q", "--bare", downstream);
  const commit = (message) => {
    git(upstream, "commit", "-q", "--allow-empty", "-m", message);
    return git(upstream, "rev-parse", "HEAD");
  };
  return {
    commit,
    mirrored: () => git(downstream, "rev-parse", "refs/heads/upstream-main"),
    mirror(sha) {
      const result = spawnSync("bash", [SCRIPT], {
        cwd: upstream,
        encoding: "utf8",
        env: { ...env, MIRROR_COMMIT: sha, DOWNSTREAM_URL: downstream },
      });
      assert.equal(result.status, 0, result.stderr);
    },
    pushStray() {
      const stray = join(root, "stray");
      git(root, "init", "-q", "-b", "main", stray);
      git(stray, "commit", "-q", "--allow-empty", "-m", "test push");
      git(stray, "push", "-q", "--force", downstream, "main:upstream-main");
    },
  };
}

test("mirrors main commits as they advance", () => {
  const fixture = createFixture();
  const first = fixture.commit("first");
  fixture.mirror(first);
  const second = fixture.commit("second");

  fixture.mirror(second);

  assert.equal(fixture.mirrored(), second);
});

test("a rerun of an older commit does not rewind the mirror", () => {
  const fixture = createFixture();
  const first = fixture.commit("first");
  const second = fixture.commit("second");
  fixture.mirror(second);

  fixture.mirror(first);

  assert.equal(fixture.mirrored(), second);
});

test("replaces commits that are not main's history", () => {
  const fixture = createFixture();
  const first = fixture.commit("first");
  fixture.pushStray();

  fixture.mirror(first);

  assert.equal(fixture.mirrored(), first);
});
