# S3 storage with MinIO (optional)

By default Thinkflow keeps its files (reports and the originals of the Library) on disk
(`STORAGE_DRIVER=local`, `DATA_DIR/objects`). What goes to the bucket and what does not is described
in [docs/storage.md](../../docs/storage.md). This Compose profile adds a local MinIO so you can use
`STORAGE_DRIVER=s3`. Without the profile, `docker compose up` is unchanged.

## Images

MinIO Inc. stopped publishing official images (Docker Hub/Quay) and archived the repository. We use
the free Chainguard images, **pinned by digest** in `docker-compose.yml`:

| Service      | Image                                                                                                 | Notes                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minio`      | `cgr.dev/chainguard/minio@sha256:db3f583f…a28fd`                                                      | distroless with bash; runs as uid 65532 (hence the named volume `minio-data`); no default command (compose sets `server /data --console-address :9001`) |
| `minio-init` | `cgr.dev/chainguard/minio-client:latest-dev@sha256:d28f884b…960be` (digest of the `latest-dev` index) | the variant without `-dev` has no shell; `-dev` is required by `init.sh`                                                                                |

To update: run `docker buildx imagetools inspect cgr.dev/chainguard/minio:latest` and replace the
digest, or set `MINIO_IMAGE` / `MC_IMAGE` in `.env`. Since MinIO Community no longer gets fixes from
the original project, follow Chainguard's updates. S3-compatible alternatives (the code only uses
`@aws-sdk/client-s3`): RustFS, Garage, SeaweedFS.

## Usage

Production / full compose (requires Docker Compose 2.20 or newer, because of
`depends_on.required: false`):

```
# .env
COMPOSE_PROFILES=minio
STORAGE_DRIVER=s3
MINIO_ROOT_PASSWORD=<long password>
S3_SECRET_ACCESS_KEY=<long secret of the application user>
docker compose up -d --build
```

Development (app on the host, MinIO in Docker):

```
docker compose --profile minio up -d --wait minio
docker compose --profile minio run --rm minio-init
STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=thinkflow \
  S3_ACCESS_KEY_ID=thinkflow S3_SECRET_ACCESS_KEY=<secret> pnpm dev
```

`pnpm dev` reads the root `.env` (`--env-file-if-exists`); variables already set in the shell take
precedence.

## What `minio-init` does (idempotent)

`init.sh` waits for MinIO to be ready, creates the private bucket (`S3_BUCKET`), removes anonymous
access, creates the `thinkflow-rw` policy from `thinkflow-policy.json` (only `ListBucket`,
`GetBucketLocation`, `Get/Put/DeleteObject` on the bucket, no `CreateBucket`) and creates/updates the
`S3_ACCESS_KEY_ID` user. It can be run again at any time (it also re-applies the password). The
application never uses the root user; the init refuses an `S3_ACCESS_KEY_ID` equal to
`MINIO_ROOT_USER`.

Alternative without the init: create the bucket with `S3_CREATE_BUCKET=true` (the application then
needs the `CreateBucket` permission, which the minimal policy does not grant).

## Production

- Stop publishing ports 9000/9001 (or bind them to 127.0.0.1 only); consider `MINIO_BROWSER=off`.
- Use TLS (`S3_ENDPOINT=https://…`); for a private CA, set `NODE_EXTRA_CA_CERTS` in the Thinkflow
  container.
- Rotation: create a new user/key with the same policy, update `S3_ACCESS_KEY_ID` /
  `S3_SECRET_ACCESS_KEY` (or the `_FILE` variants), run `docker compose up -d thinkflow`, then remove
  the old key.
- Backup: the SQLite database and `secret.key` are still required; the bucket can be copied with
  `mc mirror`.

## Migrating from local disk to MinIO

Already using `STORAGE_DRIVER=local`? After configuring S3 and running `minio-init`:

```
pnpm --filter @thinkflow/server storage:migrate --dry-run   # shows what will be copied
pnpm --filter @thinkflow/server storage:migrate             # copies (idempotent)
# in the container: docker compose exec thinkflow node dist/storage-migrate.js
```

It copies `DATA_DIR/objects` (or `STORAGE_LOCAL_DIR`) to the bucket with the same keys, without
deleting the source, and moves the old uploads from `DATA_DIR/library`. Check the application, and
only then delete the local folder.

## Contract test against a real MinIO

```
RUN_MINIO_TESTS=1 S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=thinkflow \
S3_TEST_ACCESS_KEY_ID=thinkflow S3_TEST_SECRET_ACCESS_KEY=<secret> \
  pnpm --filter @thinkflow/server exec vitest run tests/storage/s3-object-store.contract.test.ts
```

There is also the manual `minio-integration` job (workflow_dispatch) in `.github/workflows/ci.yml`.

## Tear down

`docker compose --profile minio down` keeps the data; `down -v` deletes the `minio-data` volume.
