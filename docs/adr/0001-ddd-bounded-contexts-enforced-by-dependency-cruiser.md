# 0001. DDD bounded contexts enforced by dependency-cruiser

## Status

Accepted

## Context

Thinkflow grew from a small router into a workspace with many areas: routing, chat, library,
reports, test recording, prototypes, privacy and more. Each has its own vocabulary, storage and
external systems (providers, Postgres, Chromium, S3, Microsoft Graph). Without boundaries, a
single-process server like this tends to turn into a web of imports where an HTTP route reaches
into a database adapter, and where domain rules (cooldown, SQL guard, PII detection) cannot be
tested without booting a framework.

## Decision

The server is split into **bounded contexts** under `apps/server/src/contexts/<context>`, each in
four layers: `domain` (pure model and ports), `application` (use cases that depend on domain and
ports only), `infrastructure` (adapters: SQLite, HTTP clients, SDKs) and `interface` (Fastify
routes). Shared, context-free code lives in `shared/kernel` (pure) and `shared/infrastructure`.
`apps/server/src/app.ts` is the single composition root that wires adapters into use cases.

The rules are not a convention: they are encoded in `.dependency-cruiser.cjs` and run by
`pnpm depcruise` in CI. Notably, `domain` and `application` cannot import frameworks, adapters or
routes; only the storage adapters may import the S3 SDK; and circular dependencies fail the build.

## Consequences

- Domain logic is unit-tested with plain objects and fakes; adapters are tested separately and
  integration tests boot the app in memory.
- Adding a dependency to the wrong layer fails CI, which keeps reviews about behavior.
- There is some ceremony (ports, mappers, a composition root of about a thousand lines) that is
  paid even for small features.
- Contexts still collaborate in-process (for example the router calls the privacy firewall), so
  they are modules, not services; cross-context imports are allowed between `application` layers
  and kept explicit.
