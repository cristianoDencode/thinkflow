# 0002. SQLite and a pluggable object store

## Status

Accepted

## Context

Thinkflow is a self-hosted tool for one person or one small team. It should run with
`pnpm install && pnpm dev` or one Docker container, without a database server. At the same time
it stores things of very different shapes: small relational metadata, a full-text index, and files
that can be large (screenshots, PDFs, uploaded documents, prototype assets) and that some
deployments want in S3 or MinIO.

## Decision

- **SQLite** (better-sqlite3, Drizzle ORM, generated migrations applied at startup) stores
  metadata, conversations, settings, usage, the FTS5 search index and encrypted credentials.
- Files go through an **`ObjectStore` port** defined in `shared/kernel`, with adapters for local
  disk (default), S3-compatible storage (MinIO, AWS) and memory (tests). The driver is chosen by
  `STORAGE_DRIVER`.
- Each module gets a **scoped view** of the store (`scopeObjectStore`) restricted to its own
  namespace (`reports`, `library`, `tests`, `prototypes`, ...), with keys built from generated ids,
  never user file names. New namespaces must be registered explicitly.
- The S3 SDK may only be imported by the storage adapters (enforced by dependency-cruiser).
- A migration CLI copies local objects to S3 idempotently; secrets and reproducible caches stay out
  of the bucket.

## Consequences

- Zero-ops default and trivial backups (one SQLite file, one folder, `secret.key`).
- One writer process: horizontal scaling and multi-user concurrency are out of scope.
- Moving files to S3 is a configuration change plus one command, and modules cannot read each
  other's keys by accident.
- Metadata and files can drift if one is restored without the other, so backups must cover both.
