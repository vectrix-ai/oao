# OAO

OAO is an open, self-hostable managed-agent platform built around Flue and PostgreSQL.

The first implementation target is a fully functional local environment. Railway, OpenRouter, Daytona, WorkOS, S3-compatible storage, and OTLP are adapters for later hosted operation; none is required to run the default local test suite.

## Planned local services

- React/Vite management and debugging console
- Hono REST/SSE API
- Flue runtime worker
- PostgreSQL canonical/control/read-model storage and wake queue
- MinIO-compatible artifact development service
- OpenTelemetry Collector development service
- Deterministic fake model, sandbox, and identity adapters

See [docs/architecture.md](docs/architecture.md) for boundaries and implementation order.
