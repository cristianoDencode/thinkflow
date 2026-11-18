# Data with AI

An assistant for analysts that works on a **PostgreSQL** database and is **always read-only**.

## Setup

1. Open **Database** (user menu) and register the connection: host, port, database, user,
   password (encrypted in SQLite like provider keys), SSL, visible schemas, maximum time and
   maximum rows. Use **Test**. Prefer a read-only database user (the screen shows the SQL to create
   one); if the user can write, the screen warns you, and Thinkflow still only reads.
2. Open **Dados com IA**, choose the connection and a model, then:
   - **Ask** (Enter): describe what you need, optionally naming a menu or routine of the legacy
     system. The AI asks a short questionnaire (up to 3 questions at a time), **suggests a period
     whenever there is a date, year or fiscal-year column** (from the column's min and max), maps
     the routine to tables using the connected **MCP servers** (for example an MCP server that
     describes your ERP), explores the catalog (`listar_tabelas`, `descrever_tabela`,
     `resumo_coluna`), builds and runs queries (`executar_consulta`) and explains the result:
     differing values, duplicates, orphans, nulls, out-of-period rows, outliers.
   - **Run SQL** (Ctrl+Enter): runs your own query directly, with no AI and no tokens spent.
3. Each query becomes a **card** with the SQL, a table (sorting, pagination), **Export CSV**,
   **Copy for Excel** and **Run again**.

## Read-only, in layers

1. A guard rejects anything that is not a single `SELECT`, `WITH`, `VALUES`, `TABLE` or `EXPLAIN`
   (without `ANALYZE`), including commands hidden in CTEs, `SELECT INTO`, `FOR UPDATE` and dangerous
   functions.
2. Every execution runs in a `READ ONLY` transaction with a `statement_timeout`, always ended with
   `ROLLBACK`. PostgreSQL itself refuses writes even if the user could write.

## What the AI can see (per connection)

- **Structure only** (default): tables, columns, types, row counts and statistics (nulls,
  distinct values, min and max for numbers and dates only). No rows.
- **Masked sample**: also up to N rows with sensitive data masked (for example CPF `10*******60`,
  e-mail `a***@d***.com`, names `M*** d* S***`, passwords). Sensitive columns are detected by name
  and by value; adjust with "Always mask" and "Never mask". Built-in name patterns also cover the
  e-Cidade schema.

The analyst sees full results on screen. **Rows are not stored** in Thinkflow: the history keeps
only the SQL and metadata, so reopen a conversation and use **Run again**.

In this mode, columns not seen before go through a review where you decide whether each is
revealed, tokenized or omitted, and the choice is remembered. See [privacy.md](privacy.md).

Usage appears as `data-ai` in the Usage page.

## API

`GET/POST /api/databases`, `GET/PUT/DELETE /api/databases/:id`, `POST /api/databases/:id/test` and
`POST /api/databases/:id/query`. The chat uses `POST /api/chat` with `mode: "data"`, `databaseId`
and, for direct SQL, `directSql: true`.

An optional test against a real database:

```bash
PG_TEST_URL=postgres://user:password@host:5432/db \
  pnpm --filter @thinkflow/server exec vitest run tests/databases/pg-gateway.real
```
