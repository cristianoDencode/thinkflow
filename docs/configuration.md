# Configuration

Thinkflow reads environment variables at startup. `pnpm dev` and `pnpm start` load the repository's
`.env` automatically (`--env-file-if-exists`); variables already set in the shell win. Copy
[`.env.example`](../.env.example) to start. Nothing is required: the defaults give a working local
installation. An invalid value stops the server with a message that names the variable (never its
value).

Most behavior (providers, combos, models, history, library, reports, privacy, OneDrive) is
configured in the dashboard and stored in SQLite, not in the environment.

## Server

| Variable               | Default     | Description                                                                                                                                                       |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `3737`      | HTTP port (1 to 65535)                                                                                                                                            |
| `HOST`                 | `127.0.0.1` | Bind address. Use `0.0.0.0` only in a container or trusted network (the Docker image does)                                                                        |
| `DATA_DIR`             | `./data`    | Folder with the SQLite database (`thinkflow.sqlite`), generated `secret.key` and local objects                                                                    |
| `THINKFLOW_SECRET`     | generated   | Secret from which the AES-256-GCM key for stored credentials is derived. If empty, a random one is written to `DATA_DIR/secret.key`. Keep it stable and backed up |
| `LOG_LEVEL`            | `info`      | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                                    |
| `COOKIE_SECURE`        | `false`     | Set `true` when served over HTTPS so the session cookie is `Secure`                                                                                               |
| `NODE_ENV`             | unset       | `production` turns off the pretty log transport (the Docker image sets it)                                                                                        |
| `WEB_DIR`              | auto        | Folder with the built dashboard (`index.html`). Default: `../web/dist`, then `./public`                                                                           |
| `MIGRATIONS_DIR`       | bundled     | Folder with the SQL migrations. Default: the one next to the server (the image sets `/app/drizzle`)                                                               |
| `PRIVACY_PRESIDIO_URL` | empty       | Default Presidio URL while the Settings field is empty; empty means native detectors only ([privacy.md](privacy.md))                                              |

## Storage

See [storage.md](storage.md) for the meaning of each.

| Variable                | Default                 | Description                                                                |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `STORAGE_DRIVER`        | `local`                 | `local` or `s3`                                                            |
| `STORAGE_LOCAL_DIR`     | `DATA_DIR/objects`      | Folder of the local driver                                                 |
| `STORAGE_PREFIX`        | empty                   | Key prefix, lowercase folders ending in `/` (for example `thinkflow/`)     |
| `STORAGE_MAX_OBJECT_MB` | `100`                   | Maximum size of one object, 1 to 1024                                      |
| `S3_ENDPOINT`           | AWS                     | `http(s)://host:port`; required for MinIO (`http://minio:9000` in Compose) |
| `S3_REGION`             | `us-east-1`             | Region                                                                     |
| `S3_BUCKET`             | none                    | Required with `s3`                                                         |
| `S3_ACCESS_KEY_ID`      | none                    | Required with `s3`; or `S3_ACCESS_KEY_ID_FILE` (not both)                  |
| `S3_SECRET_ACCESS_KEY`  | none                    | Required with `s3`; or `S3_SECRET_ACCESS_KEY_FILE` (not both)              |
| `S3_FORCE_PATH_STYLE`   | `true` with an endpoint | Path-style addressing (needed by MinIO)                                    |
| `S3_SSE`                | empty                   | Server-side encryption: empty, `AES256` or `aws:kms` (MinIO needs KMS/KES) |
| `S3_SSE_KMS_KEY_ID`     | none                    | Required when `S3_SSE=aws:kms`                                             |
| `S3_CREATE_BUCKET`      | `false`                 | Create the bucket at startup (the app user then needs `CreateBucket`)      |
| `S3_TIMEOUT_MS`         | `30000`                 | Request timeout, 100 to 600000                                             |
| `S3_CONNECT_TIMEOUT_MS` | `3000`                  | Connect timeout, 100 to 120000                                             |
| `S3_MAX_ATTEMPTS`       | `3`                     | Attempts per request, 1 to 10                                              |

## Docker Compose only

| Variable                                 | Description                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `COMPOSE_PROFILES`                       | `minio` and/or `privacy` to start the optional services                                          |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO root credentials, used only by `minio` and `minio-init` (password required, 8+ characters) |
| `MINIO_IMAGE`, `MC_IMAGE`                | Override the pinned MinIO and `mc` images                                                        |

`docker-compose.yml` forwards only a subset of the variables above to the container (secret, log
level, storage driver, prefix, max object size, the main `S3_*` settings and the Presidio URL). Add
others under `environment:` if you need them.

## Development and other

| Variable                   | Description                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `THINKFLOW_API`            | Used by the Vite dev server (`pnpm dev`, port 5173) as the proxy target for `/api` and `/v1`. Default `http://127.0.0.1:3737` |
| `CHROMIUM_NO_SANDBOX`      | `1` launches Chromium with `--no-sandbox`. It is already applied inside containers and when running as root                   |
| `PLAYWRIGHT_BROWSERS_PATH` | Where Playwright looks for browsers (the Docker image uses `/ms-playwright`)                                                  |
| `NODE_EXTRA_CA_CERTS`      | Standard Node variable for a private CA, for example for an S3 endpoint with a custom certificate                             |

Test-only flags (`RUN_CHROMIUM_TESTS`, `RUN_MINIO_TESTS`, `RUN_OCR_TESTS`, `PG_TEST_URL` and the
`S3_TEST_*` family) are described in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Docker build argument

`WITH_CHROMIUM=true` (`docker build --build-arg WITH_CHROMIUM=true .`) installs Chromium in the
image for PDF and PNG rendering and server-side Mermaid validation. It adds a few hundred MB.
