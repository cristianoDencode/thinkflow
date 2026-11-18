# Contributing to Thinkflow

Thanks for your interest. Thinkflow is a pnpm monorepo (TypeScript) with a Fastify server, a React
dashboard and a shared contracts package. This guide covers what you need to build, test and
propose a change. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

The application UI is in Brazilian Portuguese; code, comments, documentation and commit messages
are in English (existing Portuguese strings in the UI and tests are intentional).

## Prerequisites

- Node.js **22.12 or newer** (CI and the Docker image use Node 24)
- pnpm **10** (`corepack enable` picks the version pinned in `package.json`)

Optional, only for the features that use them:

| Dependency                         | Needed for                                                 | How                                                                                      |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Chromium (Playwright)              | test recording, PDF/PNG rendering, Mermaid in reports, e2e | `pnpm --filter @thinkflow/web exec playwright install chromium`                          |
| MinIO / S3                         | `STORAGE_DRIVER=s3`                                        | `docker compose --profile minio up -d`, see [docs/storage.md](docs/storage.md)           |
| PostgreSQL                         | "Data with AI"                                             | any reachable Postgres, ideally with a read-only user                                    |
| Presidio sidecar                   | better detection of names and addresses                    | `docker compose --profile privacy up -d --build`, see [docs/privacy.md](docs/privacy.md) |
| `notebooklm-py` CLI (experimental) | NotebookLM library engine                                  | see [docs/library.md](docs/library.md)                                                   |

## Setup

```bash
git clone https://github.com/cristianoDencode/thinkflow.git
cd thinkflow
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` starts the API on `http://localhost:3737` and the dashboard (Vite) on
`http://localhost:5173`, which proxies `/api` and `/v1` to the API. All variables are documented in
[docs/configuration.md](docs/configuration.md); none is required for local development.

## Scripts

| Command                                           | What it does                                                  |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                                        | server (tsx watch) and dashboard (Vite)                       |
| `pnpm build` / `pnpm start`                       | production build / run the server serving the built dashboard |
| `pnpm test` / `pnpm test:coverage`                | unit and integration tests (Vitest) in every package          |
| `pnpm e2e`                                        | end-to-end tests (Playwright; run `pnpm build` first)         |
| `pnpm lint` / `pnpm format` / `pnpm format:check` | ESLint / Prettier (write) / Prettier (check only)             |
| `pnpm typecheck`                                  | TypeScript in every package                                   |
| `pnpm depcruise`                                  | architecture rules (see below)                                |
| `pnpm --filter @thinkflow/server db:generate`     | generate a Drizzle migration after editing `schema.ts`        |
| `pnpm --filter @thinkflow/server storage:migrate` | copy local files to S3 (`--dry-run` to preview)               |

## Tests

- **Server** (`apps/server/tests`): domain unit tests, adapter tests with fakes, and integration
  tests that boot the Fastify app in memory (`inject`) with a fake provider.
- **Web** (`apps/web/src/**/*.test.ts(x)`): Vitest with jsdom and Testing Library.
- **Shared** (`packages/shared`): schema and pure-function tests.
- **End to end** (`apps/web/e2e`): Playwright against the built server and a mock provider.

Some tests need real infrastructure and are skipped unless you opt in:

| Variable                                                                                                                                           | Enables                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `RUN_CHROMIUM_TESTS=1`                                                                                                                             | tests that launch a real headless Chromium       |
| `RUN_OCR_TESTS=1`                                                                                                                                  | smoke test of the real Tesseract OCR             |
| `RUN_MINIO_TESTS=1` + `S3_TEST_ENDPOINT`, `S3_TEST_BUCKET`, `S3_TEST_ACCESS_KEY_ID`, `S3_TEST_SECRET_ACCESS_KEY` (and optionally `S3_TEST_REGION`) | S3 contract test against a real MinIO            |
| `PG_TEST_URL=postgres://user:pass@host:5432/db`                                                                                                    | read-only gateway test against a real PostgreSQL |

Example: `RUN_CHROMIUM_TESTS=1 pnpm --filter @thinkflow/server test`.

New behavior needs a test. CI enforces coverage thresholds on the routing domain.

## Architecture rules

The server is split into bounded contexts under `apps/server/src/contexts/<context>`, each with
`domain`, `application`, `infrastructure` and `interface` layers. `pnpm depcruise` (rules in
[`.dependency-cruiser.cjs`](.dependency-cruiser.cjs)) fails the build when you break them:

- `domain` is pure: no imports from `application`, `infrastructure`, `interface` or `app.ts`, and no
  npm frameworks (only `@thinkflow/shared` and Node built-ins).
- `application` (use cases) talks to ports, never to adapters, HTTP or frameworks.
- The S3 SDK is imported only in `shared/infrastructure/storage`.
- `shared/kernel` has no dependencies outside itself; `shared/interface` never imports contexts.
- Adapters never import HTTP route modules, there are no circular dependencies, and production
  code never imports tests.
- `apps/server/src/app.ts` is the composition root and may import anything.

See [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/) before making structural
changes. When a file or database record must outlive the process, use the object store, not the
disk directly ([docs/storage.md](docs/storage.md)).

## Commits

Use `Type(scope): summary`, as in the project history, in the imperative and in English:

```text
Feat(prototypes): group and ungroup layers in free mode
Fix(routing): honor Retry-After on 429 from OpenRouter
Docs(privacy): explain the Presidio sidecar
```

Common types: `Feat`, `Fix`, `Docs`, `Test`, `Style`, `Refactor`, `Chore`. Keep commits focused;
squash noisy fixup commits before opening the pull request.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Branch from `main` and keep the change focused.
3. Make sure these pass locally:

   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck && pnpm depcruise && pnpm test
   ```

   Run `pnpm e2e` too when you touch flows covered by `apps/web/e2e`.

4. Add or update tests and the relevant page in `docs/`; add a line to `CHANGELOG.md` under
   "Unreleased".
5. Never commit secrets, real personal data or screenshots with real data. Test data must be
   fictitious.
6. Fill in the pull request template. CI (format, lint, typecheck, architecture, coverage, build,
   e2e, Docker image) must be green.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.
