# Security Policy

## Supported versions

Only the latest release (and the `main` branch) receives security fixes. Please update before
reporting.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting instead:
open the repository's **Security** tab and choose **Report a vulnerability** (GitHub Security
Advisories). Include:

- what you found and which component it affects;
- steps to reproduce (a minimal request, payload or screen is enough);
- the version or commit, and how you run Thinkflow (Docker or `pnpm`, behind a proxy or not).

You will get an acknowledgement as soon as the maintainer can read the report. Please allow a
reasonable time to fix the problem before disclosing it publicly. Credit is given in the advisory
unless you prefer to stay anonymous.

## Security model

Thinkflow is a **self-hosted, single-tenant** tool: one local user per installation, running on a
machine you control. It is not designed to be exposed to the open internet as is. The notes below
describe what the code does today, so you can judge what it protects against.

- **Local user and sessions.** The first visit creates the only user (name and password). The
  password is hashed with scrypt and a random salt. A login creates a session whose token is stored
  hashed (SHA-256) and sent in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when `COOKIE_SECURE=true`).
  Sessions last 30 days. There is no built-in rate limiting of login attempts.
- **Router API keys.** Keys used by Claude Code and OpenAI-style clients on `/v1` are prefixed
  `tf_` and stored only as a hash (the full key is visible only when it is created).
- **Secrets at rest.** Provider API keys, MCP server env vars and headers, database connection
  passwords, OneDrive tokens, NotebookLM credentials and the privacy vault values are encrypted in
  SQLite with AES-256-GCM. The key is derived (SHA-256) from `THINKFLOW_SECRET`; when it is empty a
  random secret is generated into `DATA_DIR/secret.key` (mode `0600`). Whoever holds the secret and
  the SQLite file can read these values: protect both and back them up. Changing the secret makes
  stored credentials unreadable (they must be entered again).
- **Privacy firewall.** Before a request leaves for any model provider (chat, agent, reports,
  history summaries, Data with AI, `/v1`), personal data detected in the text (CPF, CNPJ, e-mail,
  phone, names and more) is replaced by reversible tokens such as `[CPF_1]`. The real values stay
  in an encrypted per-conversation vault and are restored in the answer. Limits: images and
  attached PDFs are not read by the filter, and detection is heuristic, so it is a mitigation, not
  a guarantee. See [docs/privacy.md](docs/privacy.md).
- **Data with AI is read-only.** SQL is checked lexically (a single `SELECT`/`WITH`/`VALUES`/
  `TABLE`/`EXPLAIN` statement, no write or dangerous functions) and then executed inside a
  `READ ONLY` transaction with a statement timeout that is always rolled back. Even so, connect
  with a database user that has read-only privileges. Result rows are not stored.
- **HTML sanitization.** Generated reports, test-case documents and screen prototypes are
  sanitized (scripts, event handlers, `javascript:` URLs, frames, external stylesheets and links
  are removed), served with a restrictive Content-Security-Policy and shown in sandboxed frames.
  The headless Chromium used for PDF and PNG rendering runs with external requests blocked.
- **Prompt injection.** Content from MCP servers, libraries and attachments is delimited and
  labelled as data, not instructions. This reduces, but does not remove, the risk: only connect
  MCP servers and upload documents you trust.
- **MCP stdio servers run commands on the host**, and in Agent mode the "allow everything"
  permission lets the agent run commands and edit files in the chosen folder. Treat both as
  remote-code-execution surfaces and enable them deliberately.
- **Network exposure.** The server listens on `127.0.0.1` by default, and `docker-compose.yml`
  publishes the port only on the host loopback. If you expose Thinkflow beyond your machine, put it
  behind a reverse proxy with **TLS**, set `COOKIE_SECURE=true`, use a strong password and a fixed
  `THINKFLOW_SECRET`, and restrict who can reach it.

## Out of scope

Reports that require physical access to the host or a stolen `secret.key` plus database, issues in
third-party providers or services you connect, and findings that need the single user to paste
malicious content into their own settings are generally not treated as vulnerabilities, although
hardening suggestions are welcome as normal issues.
