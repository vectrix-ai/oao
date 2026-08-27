# OAO

OAO is an open, self-hostable managed-agent platform built around Flue and PostgreSQL.

The first implementation target is a fully functional local environment. Runtime execution uses a project-scoped OpenRouter or OpenAI connection. Daytona is required only for agents that enable a sandbox; deterministic provider doubles are confined to automated tests.

## Workspace

- `@oao/contracts`: public Valibot schemas and wire types
- `@oao/domain`: branded IDs, authorization, run/admission rules, provider ports, and redaction
- `@oao/db-postgres`: executable migrations, RLS tenant transactions, typed repositories, ledgers, and audit/event storage
- `@oao/events`: atomic append contracts, resumable cursors, and wake-only notification boundaries
- `@oao/testkit`: deterministic identities, clocks, providers, and crash barriers
- `@oao/cli`: dependency preflight and resumable guided local onboarding
- `infra/compose`: local PostgreSQL 17, the owned-process development launcher,
  and disposable fresh-database verification harnesses

The implemented local profile runs:

- React/Vite management and debugging console
- Hono REST/SSE API
- Flue runtime worker
- PostgreSQL canonical/control/read-model storage and wake queue
- Configurable development or WorkOS identity plus real project-scoped model
  providers, with optional Daytona sandboxes

See [docs/architecture.md](docs/architecture.md) for boundaries and implementation order.

## Quickstart

Node.js 22.19 or newer and pnpm 10.27 are required.

```sh
git clone https://github.com/vectrix-ai/oao.git
cd oao
pnpm oao doctor
pnpm oao setup
```

`doctor` checks the operating system, repository, Node and pnpm versions, Docker
CLI and daemon, writable workspace, disk space, and required ports before setup
changes anything. `setup` installs the pinned workspace dependencies, prepares
PostgreSQL, creates a secure local encryption key when needed, starts the stack,
and guides you through connecting OpenRouter or OpenAI, creating a model preset,
publishing a sandbox-disabled starter agent, and running its first session.
Provider API keys are sent to OAO's write-only credential endpoint and are not
written to `.env` or the setup-state file.

Run `pnpm oao setup` again after an interruption; completed resources are reused.
Use `pnpm oao status` to inspect the local stack and `pnpm oao open` to open the
console. See the [guided quickstart](docs/getting-started/quickstart.mdx) for the
full flow and troubleshooting.

## Manual development

```sh
pnpm install
cp .env.example .env
# Set OAO_CREDENTIAL_ENCRYPTION_KEY, then add a model connection in the console.
pnpm dev:local
```

`dev:local` requires a running Docker-compatible daemon. It does not start
Docker Desktop or Colima. The command starts PostgreSQL if necessary, builds the
workspace packages needed by the source watchers, applies migrations, seeds the
development tenant when `AUTH_PROVIDER=development`, and launches the API on
port 3000, runtime worker on 8788, and console on 8080. Set
`AUTH_PROVIDER=workos` with the required WorkOS values to disable deterministic
development login. Open <http://127.0.0.1:8080>. Ctrl-C stops every child and
stops the PostgreSQL container only when this invocation started it.

### Local authentication

The local launcher selects one authentication provider at process startup.
Change `.env`, stop the current `pnpm dev:local` process, and start it again
after switching modes.

To enable WorkOS AuthKit and disable the deterministic development user:

```dotenv
AUTH_PROVIDER=workos
NODE_ENV=development
APP_ORIGIN=http://127.0.0.1:8080
API_KEY_PEPPER=generate-a-random-secret
WORKOS_API_KEY=sk_test_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=at-least-32-random-characters
WORKOS_WEBHOOK_SECRET=whsec_...
WORKOS_CALLBACK_URL=http://127.0.0.1:8080/v1/auth/callback
```

Register the exact callback and `http://127.0.0.1:8080` sign-out URI in the
WorkOS Staging application. A WorkOS identity must also be explicitly linked to
an existing OAO organization, project, principal, and membership using the
`provision:workos` command documented in
[`apps/api/README.md`](apps/api/README.md).

To disable WorkOS and restore credential-free development authentication:

```dotenv
AUTH_PROVIDER=development
NODE_ENV=development
```

WorkOS variables may remain in the ignored local `.env`; the API does not read
them while the development provider is selected. Never commit `.env` or real
provider credentials.

There is no runnable fake model or sandbox profile. `.env.example` documents
the platform encryption key used for encrypted project-scoped credentials. A
model connection is required to run an agent. Daytona is required only when an
agent enables a sandbox, and S3-compatible storage is required only for run
files and workspace backups.

## Verification

```sh
pnpm check
pnpm test:postgres:fresh
pnpm test:stack:fresh
```

The fresh-PostgreSQL command runs the database and runtime integration/race
suites. The fresh-stack command additionally starts the real API and runtime
processes and verifies that the runnable stack fails closed when no real model
provider is configured. Both commands use a PostgreSQL container on a random
host port and always remove it. See
[infra/compose/README.md](infra/compose/README.md) for lifecycle details.

See [apps/api/README.md](apps/api/README.md) for the runnable API commands,
development/Vite proxy setup, exact authentication environment contract, WorkOS
callback/webhook URLs, and operator identity provisioning.

## Railway deployment

The minimal hosted topology is one public service that serves the compiled
console and API from the same origin, one private runtime worker, and Railway
PostgreSQL. The web service opts into static console hosting with
`OAO_SERVE_CONSOLE=true`. See the
[Railway deployment guide](docs/getting-started/railway.mdx) for commands,
variables, first-identity provisioning, and verification.

## Documentation

The Mintlify source lives in [`docs`](docs). From that directory, run
`mint dev --port 3333` to preview it alongside the local OAO API, or use
`mint validate`, `mint broken-links`, and `mint a11y` before publishing. Start at
[`docs/index.mdx`](docs/index.mdx) for the local setup, agent configuration,
model preset, API, SSE, and codebase-integration guides.
