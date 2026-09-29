# Contributing to OAO

Thank you for helping improve OAO. The project is in early beta, so focused,
well-tested changes and clear reports are especially valuable.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) in every project space.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Open an issue before substantial features, architecture changes, breaking
  changes, or broad refactors so scope and direction can be agreed first.
- Use the GitHub issue forms and provide a minimal reproduction when reporting
  a bug.
- Never put credentials, authorization headers, customer or personal data,
  private prompts or transcripts, provider responses, or other sensitive
  material in an issue, pull request, test fixture, log, trace, screenshot, or
  SSE example.
- Do not report security vulnerabilities in a public issue. Use GitHub's private
  vulnerability reporting flow when it is available for this repository.

GitHub Issues are a best-effort community channel. OAO does not currently make
response-time or support-level commitments.

## Development environment

OAO is a TypeScript ESM monorepo built with Turbo. It requires Node.js 22.19.0
or newer and the exact pnpm version declared in `package.json` (currently
10.27.0). Docker or another Docker-compatible runtime is required for the
disposable integration harnesses and the local stack.

```sh
corepack enable
corepack prepare pnpm@10.27.0 --activate
pnpm install --frozen-lockfile
```

The workspace is divided into `apps/*`, `packages/*`, `infra/compose`, and the
Mintlify site in `docs/`. Read the repository's `AGENTS.md` before changing code.
Its package ownership, tenant-isolation, provider-boundary, credential-safety,
and public-API rules are architectural requirements, not optional style advice.

For interactive local development, follow the
[local development guide](docs/getting-started/local-development.mdx). Do not
run integration tests against the persistent local development database; it can
contain real local data.

## Make a focused change

- Keep domain packages independent from framework and provider implementation
  types. Integrations belong behind the ports in `@oao/domain` and in their
  dedicated adapter packages.
- Repeat organization and project identity in tenant-owned database keys and
  foreign keys, and use the RLS transaction helpers for tenant queries.
- Treat provider credentials as write-only. They must be encrypted at rest and
  may only be returned as a fingerprint and version. Redact secrets and
  authorization values from logs, traces, list views, and SSE events.
- Add or update tests with every behavior change. Prefer deterministic test
  doubles in automated tests; do not add a fake model or sandbox runtime mode.
- Update the relevant Mintlify pages for every feature addition, behavior
  change, or removal. Document setup, examples, API and event contracts,
  limitations, and navigation in the same pull request.

### Public API changes are vertical slices

A public API change is complete only when the same change updates:

1. schemas and wire types in `packages/contracts`;
2. the endpoint in `apps/api`;
3. SDK routes, client behavior, and types in `packages/sdk-js`;
4. console API types plus both `http.ts` and `demo.ts`, and the affected page;
5. tests in every affected package; and
6. `docs/reference/http-api.mdx` and any related guides.

## Validate your change

Run checks proportional to the change while developing. Turbo supports scoped
validation:

```sh
pnpm turbo run typecheck test --filter <package>
```

Before requesting review, run the relevant lint, typecheck, test, and build
tasks. The complete workspace check is:

```sh
pnpm check
```

Use the disposable database and full-stack harnesses for affected integration
paths. Both create isolated PostgreSQL resources and clean them up:

```sh
pnpm test:postgres:fresh
pnpm test:stack:fresh
```

Database-backed integration suites require `DATABASE_URL` and otherwise skip
silently, so a skipped direct integration run is not proof that the path works.
Use the fresh harnesses instead of pointing tests at the persistent development
database.

For console behavior, run its unit tests and, when the browser path or
accessibility is affected, its Playwright suite:

```sh
pnpm --filter @oao/console test
pnpm --filter @oao/console test:browser
```

For documentation changes, install the current Mintlify CLI as described in
[`docs/README.md`](docs/README.md), then run the following from `docs/`:

```sh
mint validate
mint broken-links
mint a11y
```

Also run `pnpm format:check` and `git diff --check`. If a required check cannot
run locally, state exactly what was not run and why in the pull request.

## Pull requests

- Keep a pull request focused and link the issue it addresses.
- Use a Conventional Commit-style title such as `fix: ...`, `feat: ...`, or
  `docs: ...`; include a known issue or ticket identifier.
- Describe the problem, the chosen approach, user-visible and API effects,
  privacy or migration implications, and the validation performed.
- Include documentation and migration or rollback guidance in the same pull
  request when applicable.
- Mark the pull request ready for review only when it is reviewable and the
  relevant checks pass. Maintainers may request automated and human review and
  will decide when the change is ready to merge.
- Do not commit generated secrets or local `.env` files.

## Keep private identifiers out

This repository is public. Use placeholders such as `<PROJECT_ID>`,
`example-project`, or `worker@project.iam.gserviceaccount.com` for cloud
projects, registries, service accounts, and repositories in code, docs, tests,
and fixtures. The **Public identifiers** workflow fails when a tracked file
names a known private deployment, or a Google service account or Artifact
Registry path outside a placeholder project. Its denied names are stored as
SHA-256 digests in `scripts/check-public-identifiers.mjs`; add a digest there
rather than the name itself.

## Downstream distributions

A private distribution of OAO, such as a deployment with its own delivery
workflows, tracks this repository by merging it. Build shared behavior here
first and let it reach the distribution through a sync; never push a
distribution's branches to this repository.

Every push to `main` is mirrored to the distribution's `upstream-main` branch.
That push runs the **Upstream sync** workflow in the distribution, which opens
or refreshes an `upstream-sync` pull request merging the new commits into the
configured base branch. CI starts on the pull request, which lists the
upstream commits and any conflicting files.

- Merge sync pull requests with **Create a merge commit**. Squash and rebase
  merges drop the upstream ancestry, so the next sync would replay the same
  changes.
- Resolve conflicts on the `upstream-sync` branch by merging, as the pull
  request describes. Later syncs keep manual commits and merge new upstream
  commits on top instead of rebuilding the branch.
- Keep the distribution's migrations identical to upstream. The migrator
  rejects an applied migration whose contents changed, so fix an applied
  migration with a new one rather than editing it.

Connecting a distribution needs two write deploy keys on the distribution
repository and these settings:

| Repository   | Setting                              | Value                                                                                  |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------- |
| OAO          | `DOWNSTREAM_REPOSITORY` secret       | `owner/name` of the distribution                                                       |
| OAO          | `DOWNSTREAM_DEPLOY_KEY` secret       | Private key of the first deploy key                                                    |
| Distribution | `UPSTREAM_SYNC_BASE_BRANCH` variable | Branch the sync pull request targets                                                   |
| Distribution | `UPSTREAM_SYNC_DEPLOY_KEY` secret    | Private key of the second deploy key, stored in the `upstream-sync` environment        |
| Distribution | `UPSTREAM_REPOSITORY` variable       | Optional; defaults to `vectrix-ai/oao`                                                 |
| Distribution | `DELIVERY_RUNS_CI` variable          | `true` when its delivery workflow calls CI on every push, so CI skips its own push run |
| Distribution | Actions may create pull requests     | Enabled in the repository's Actions settings                                           |

Deploy keys push as themselves, so their pushes start workflows and may
change workflow files. Protect the distribution's deployment branches with
required pull requests so the keys can only push `upstream-main` and
`upstream-sync`. **Run workflow** on **Upstream sync** retries a sync against
upstream `main` once the workflow is on the distribution's default branch.

A push to `upstream-main` runs this repository's copy of **Upstream sync**
inside the distribution, so the distribution trusts whatever reaches upstream
`main`, as its CI already does once the sync pull request opens. Limit the
`upstream-sync` environment's deployment branches to `upstream-main` and the
default branch so pull request CI and other branches cannot read the sync key.

## Contribution license

OAO is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution, you agree that it may be distributed under that license and
confirm that you have the right to submit it.
