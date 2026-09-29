import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../upstream-sync.sh", import.meta.url));
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

// Emulates the one pull request the sync script manages and records calls.
const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const command = args.slice(0, 2).join(" ");
state.calls.push(command);
if (command === "pr list") {
  if (state.pr) console.log(state.pr.number);
} else if (command === "pr create") {
  state.pr = {
    number: 7,
    title: option("--title"),
    body: readFileSync(option("--body-file"), "utf8"),
    headAtCreation: execFileSync(
      "git",
      ["rev-parse", "refs/heads/" + option("--head")],
      { cwd: process.env.FAKE_GH_REMOTE, encoding: "utf8" },
    ).trim(),
  };
} else if (command === "pr edit") {
  state.pr.title = option("--title");
  if (args.includes("--body-file"))
    state.pr.body = readFileSync(option("--body-file"), "utf8");
} else if (command === "pr comment") {
  state.comments.push(option("--body"));
} else if (command === "pr close") {
  state.closed = {
    number: state.pr.number,
    deletedBranch: args.includes("--delete-branch"),
    comment: option("--comment"),
  };
  state.pr = null;
} else {
  console.error("unexpected gh " + args.join(" "));
  process.exit(1);
}
writeFileSync(statePath, JSON.stringify(state));
`;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "upstream-sync-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const remote = join(root, "downstream.git");
  const checkout = join(root, "checkout");
  const state = join(root, "gh.json");
  const bin = join(root, "bin");
  const gitConfig = join(root, "gitconfig");
  writeFileSync(
    gitConfig,
    "[user]\n\tname = Upstream Dev\n\temail = dev@example.com\n",
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const commit = (cwd, message, files) => {
    for (const [path, content] of Object.entries(files))
      writeFileSync(join(cwd, path), content);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const packageJson = (version) =>
    `{\n  "name": "oao",\n  "version": "${version}",\n  "private": true\n}\n`;

  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(state, JSON.stringify({ calls: [], comments: [], pr: null }));

  git(root, "init", "-q", "-b", "main", upstream);
  const initial = commit(upstream, "feat: initial", {
    "package.json": packageJson("1.0.0"),
    "shared.txt": "one\n",
  });
  git(root, "init", "-q", "--bare", "-b", "dev", remote);
  git(upstream, "push", "-q", remote, "main:dev");
  git(root, "clone", "-q", remote, checkout);
  commit(checkout, "feat: downstream delivery", { "deploy.txt": "private\n" });
  git(checkout, "push", "-q", "origin", "dev");

  return {
    initial,
    git,
    remote,
    checkout,
    ghState: () => JSON.parse(readFileSync(state, "utf8")),
    /** Closes the pull request without merging, keeping its branch. */
    closePullRequest() {
      const current = JSON.parse(readFileSync(state, "utf8"));
      writeFileSync(state, JSON.stringify({ ...current, pr: null }));
    },
    syncBranch: () => git(remote, "rev-parse", "refs/heads/upstream-sync"),
    parents: (ref) => git(remote, "rev-list", "--parents", "-n", "1", ref),
    /** Commits upstream and makes the commit available to the checkout. */
    upstreamCommit(message, files) {
      const sha = commit(upstream, message, files);
      git(checkout, "fetch", "-q", upstream, "main");
      return sha;
    },
    /** Commits directly to the downstream base branch. */
    downstreamCommit(message, files) {
      git(checkout, "switch", "-q", "dev");
      git(checkout, "pull", "-q", "origin", "dev");
      const sha = commit(checkout, message, files);
      git(checkout, "push", "-q", "origin", "dev");
      return sha;
    },
    packageJson,
    sync(commitSha) {
      const result = spawnSync("bash", [SCRIPT], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_GH_STATE: state,
          FAKE_GH_REMOTE: remote,
          UPSTREAM_REPOSITORY: "acme/oao",
          UPSTREAM_SYNC_BASE_BRANCH: "dev",
          UPSTREAM_SYNC_COMMIT: commitSha,
          UPSTREAM_SYNC_PUSH_URL: remote,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return result;
    },
  };
}

test("opens a merge pull request whose creation precedes the CI-triggering push", () => {
  const fixture = createFixture();
  const dev = fixture.git(fixture.remote, "rev-parse", "refs/heads/dev");
  const upstream = fixture.upstreamCommit("fix: bound retries (#12)", {
    "package.json": fixture.packageJson("1.1.0"),
    "shared.txt": "two\n",
  });

  fixture.sync(upstream);

  const { pr, calls } = fixture.ghState();
  const head = fixture.syncBranch();
  assert.deepEqual(calls, ["pr list", "pr create"]);
  assert.equal(pr.headAtCreation, upstream);
  assert.equal(
    pr.title,
    `chore: sync upstream OAO v1.1.0 (${upstream.slice(0, 7)})`,
  );
  assert.match(pr.body, /Create a merge commit/);
  assert.match(pr.body, /- [0-9a-f]{7} fix: bound retries \(acme\/oao#12\)/);
  assert.equal(fixture.parents(head), `${head} ${dev} ${upstream}`);
  assert.equal(
    fixture.git(fixture.remote, "log", "-1", "--format=%ce", head),
    BOT_EMAIL,
  );
  assert.equal(
    fixture.git(fixture.remote, "show", `${head}:deploy.txt`),
    "private",
  );
  assert.equal(
    fixture.git(fixture.remote, "show", `${head}:shared.txt`),
    "two",
  );
});

test("does nothing when the base branch already contains upstream", () => {
  const fixture = createFixture();

  fixture.sync(fixture.initial);

  assert.deepEqual(fixture.ghState().calls, ["pr list"]);
});

test("opens conflicting syncs on the upstream commit and lists the files", () => {
  const fixture = createFixture();
  fixture.downstreamCommit("fix: downstream wording", {
    "shared.txt": "downstream\n",
  });
  const upstream = fixture.upstreamCommit("fix: upstream wording", {
    "shared.txt": "upstream\n",
  });

  fixture.sync(upstream);

  const { pr } = fixture.ghState();
  assert.equal(fixture.syncBranch(), upstream);
  assert.match(pr.body, /### Conflicts/);
  assert.match(pr.body, /- `shared\.txt`/);
  assert.match(pr.body, new RegExp(`git merge ${upstream}`));
});

test("rebuilds a bot-owned pull request when upstream advances", () => {
  const fixture = createFixture();
  fixture.sync(
    fixture.upstreamCommit("feat: first", { "first.txt": "first\n" }),
  );
  const dev = fixture.git(fixture.remote, "rev-parse", "refs/heads/dev");
  const second = fixture.upstreamCommit("feat: second", {
    "second.txt": "second\n",
  });

  fixture.sync(second);

  const { pr, calls } = fixture.ghState();
  const head = fixture.syncBranch();
  assert.deepEqual(calls.slice(2), ["pr list", "pr edit"]);
  assert.equal(fixture.parents(head), `${head} ${dev} ${second}`);
  assert.equal(
    pr.title,
    `chore: sync upstream OAO v1.0.0 (${second.slice(0, 7)})`,
  );
});

/** Opens a conflicting sync and resolves it on its branch as a maintainer. */
function resolveConflictManually(fixture) {
  fixture.downstreamCommit("fix: downstream wording", {
    "shared.txt": "downstream\n",
  });
  const conflicting = fixture.upstreamCommit("fix: upstream wording", {
    "shared.txt": "upstream\n",
  });
  fixture.sync(conflicting);
  const { git, checkout } = fixture;
  git(checkout, "switch", "-q", "-C", "upstream-sync", "origin/dev");
  assert.throws(() => git(checkout, "merge", "-q", conflicting));
  writeFileSync(join(checkout, "shared.txt"), "resolved\n");
  git(checkout, "add", "shared.txt");
  git(
    checkout,
    "-c",
    "user.email=maintainer@example.com",
    "commit",
    "-q",
    "--no-edit",
  );
  git(checkout, "push", "-q", "--force", "origin", "upstream-sync");
  return { conflicting, resolution: git(checkout, "rev-parse", "HEAD") };
}

test("keeps a manual conflict resolution and merges later upstream commits on top", () => {
  const fixture = createFixture();
  const { resolution } = resolveConflictManually(fixture);
  const later = fixture.upstreamCommit("feat: unrelated", {
    "later.txt": "later\n",
  });

  fixture.sync(later);

  const head = fixture.syncBranch();
  const { pr, comments } = fixture.ghState();
  assert.equal(fixture.parents(head), `${head} ${resolution} ${later}`);
  assert.equal(
    fixture.git(fixture.remote, "show", `${head}:shared.txt`),
    "resolved",
  );
  assert.match(comments.at(-1), /manually resolved branch/);
  assert.match(pr.title, new RegExp(later.slice(0, 7)));
  assert.match(pr.body, new RegExp(`acme/oao@${later.slice(0, 7)}`));
  assert.doesNotMatch(pr.body, /### Conflicts/);
});

test("reports conflicts with a manual resolution without rewriting it", () => {
  const fixture = createFixture();
  const { resolution } = resolveConflictManually(fixture);
  const later = fixture.upstreamCommit("fix: reword again", {
    "shared.txt": "upstream again\n",
  });

  fixture.sync(later);

  const { pr, comments } = fixture.ghState();
  assert.equal(fixture.syncBranch(), resolution);
  assert.match(pr.body, /- `shared\.txt`/);
  assert.match(pr.body, /git switch -C upstream-sync origin\/upstream-sync/);
  assert.match(comments.at(-1), /conflicts with the manual resolution/);
});

test("reopens from a closed pull request's manual resolution instead of replacing it", () => {
  const fixture = createFixture();
  const { resolution } = resolveConflictManually(fixture);
  fixture.closePullRequest();
  const later = fixture.upstreamCommit("feat: unrelated", {
    "later.txt": "later\n",
  });

  fixture.sync(later);

  const { pr } = fixture.ghState();
  const head = fixture.syncBranch();
  assert.equal(pr.headAtCreation, resolution);
  assert.equal(fixture.parents(head), `${head} ${resolution} ${later}`);
});

test("closes the pull request once the base branch contains upstream", () => {
  const fixture = createFixture();
  const upstream = fixture.upstreamCommit("feat: first", {
    "first.txt": "first\n",
  });
  fixture.sync(upstream);
  fixture.git(fixture.checkout, "fetch", "-q", "origin");
  fixture.git(fixture.checkout, "switch", "-q", "dev");
  fixture.git(
    fixture.checkout,
    "merge",
    "-q",
    "--ff-only",
    "origin/upstream-sync",
  );
  fixture.git(fixture.checkout, "push", "-q", "origin", "dev");

  fixture.sync(upstream);

  assert.equal(fixture.ghState().closed.deletedBranch, true);
});

test("keeps a closed pull request's branch when it holds manual commits", () => {
  const fixture = createFixture();
  const { conflicting, resolution } = resolveConflictManually(fixture);
  const { git, checkout } = fixture;
  git(checkout, "switch", "-q", "dev");
  assert.throws(() => git(checkout, "merge", "-q", conflicting));
  writeFileSync(join(checkout, "shared.txt"), "merged on dev\n");
  git(checkout, "commit", "-q", "-a", "--no-edit");
  git(checkout, "push", "-q", "origin", "dev");

  fixture.sync(conflicting);

  const { closed } = fixture.ghState();
  assert.equal(closed.deletedBranch, false);
  assert.match(closed.comment, /Kept `upstream-sync`/);
  assert.equal(fixture.syncBranch(), resolution);
});
