# Library

A **library** is a named set of documents (PDF, DOCX, Markdown/TXT, and PNG, JPEG or WEBP images)
that the chat searches to answer from your own material. Manage them under **Biblioteca**.

## Limits

20 MB per file (10 MB for images), up to 1,000 documents per local library (for NotebookLM
libraries, the account's source limit), 1.5 million characters per document, 60 million per
library, 100 libraries, and 10 files per upload.

## Where things live

Originals are stored in the object store under `library/<library>/<document>.<ext>` (local disk
or S3/MinIO, see [storage.md](storage.md)). Extracted text and the search index live in SQLite.
Files uploaded by old versions to `DATA_DIR/library` are moved at startup. If S3 is down, new
uploads are refused with a warning.

A document is `processing` (queued), `ready` (searchable) or `error` (with the reason).
**Reprocess** redoes extraction and indexing, **View text** shows the extracted text (handy to
check OCR) and **Test search** runs a query and shows the snippets the model would receive.

## How search works

Text is split into chunks of about 500 tokens with overlap (respecting headings and pages) and
indexed with **SQLite FTS5 (BM25)**. Search ignores accents and case, removes Portuguese stop
words and uses a prefix heuristic for word variants. FTS operators are neutralized. There is no
semantic (embedding) search yet.

## Use in chat

Pick a library next to the MCP toggle. The choice is saved with the conversation and copied when
you fork it. The model gets the `buscar_na_biblioteca` tool and receives only relevant snippets
with document name and page, which it cites. Per turn: up to 4 calls and 12,000 characters in
total. Chat mode only (Agent mode does not use libraries yet); models without tool calling may
not consult it.

## OCR

Configured in the library settings:

- **local** (default): Tesseract, fully offline for `por+eng`; other languages are downloaded once
  into `DATA_DIR/tessdata`.
- **vision**: sends the image to a model through the router (recorded as `library-ocr` in Usage),
  falling back to local OCR on failure.
- **off**: images and PDFs without text become an explanatory error.

Scanned PDFs (up to 30 pages) are rendered with the optional dependency `@napi-rs/canvas`;
without it a PDF with no text becomes an `error`. A real-Tesseract smoke test is opt-in
(`RUN_OCR_TESTS=1`, see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## NotebookLM engine (experimental)

When creating a library you can choose the **NotebookLM** engine: the question is sent straight to
NotebookLM and its answer, with citations, goes back to the model. Documents are always also
indexed locally, which serves as a fallback (on by default).

> **Warnings.** This uses the unofficial CLI
> [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py), which relies on undocumented
> Google APIs. It may stop working without notice and may violate Google's terms: use a separate
> Google account created for this, because the session cookies give access to the account.
> Documents and questions leave your server for that account. Tested version: `0.8.6`.
> It is not supported in the Docker image (no Python, CLI or display for the login).

Install (Python 3.10+ on the server):

```bash
python3 -m venv "$HOME/.local/share/thinkflow/notebooklm-venv"
"$HOME/.local/share/thinkflow/notebooklm-venv/bin/pip" install "notebooklm-py[browser]==0.8.6"
"$HOME/.local/share/thinkflow/notebooklm-venv/bin/playwright" install chromium
```

That path is detected automatically; otherwise set "CLI command" in the settings.

Login (Library, NotebookLM tab): **Sign in with Google** (opens Chromium on the server machine),
**Import existing login** (adopts `~/.notebooklm/profiles/default/storage_state.json`) or **Paste
manually** (the contents of `storage_state.json`, useful on servers without a display). The cookies
are stored encrypted (AES-256-GCM). Enable the integration, save and use **Test connection**.

How it behaves:

- Creating a library creates a `Thinkflow - <name>` notebook. Each upload is indexed locally and
  then sent as a source through a separate queue. The NotebookLM column shows Pending, Syncing,
  Synced or Error (use **Sync** to retry). Deleting documents or the library removes the remote
  sources or notebook too, and local deletion proceeds even if NotebookLM fails.
- Each question is independent and limited to synced documents. Usage is recorded as
  `library-notebooklm` (estimated tokens).
- If NotebookLM fails or the daily limit is reached, the model receives a warning followed by the
  local snippets. With the fallback off, the tool returns an error.
- Credentials older than 12 hours are refreshed before a call (or use **Refresh now**).
- Limits depend on the Google plan (free: 50 sources per notebook and 50 questions per day; higher
  plans allow more). Choose "Automatic" under account plan, or set it manually. Counting is per UTC
  day. Each call starts a CLI process (one at a time, at least 1.5 s apart), adding 1 to 3 s of
  overhead plus the answer time.
- The engine is fixed when the library is created.

Common problems: expired credentials (`notebooklm_auth`, sign in again or paste a new
`storage_state.json`; changing `THINKFLOW_SECRET` also invalidates them), CLI not found
(`notebooklm_cli_missing`, install it or set the command), and "server has no display" (without
`DISPLAY` or `WAYLAND_DISPLAY` the login button is disabled; import or paste instead). NotebookLM
errors reach the browser as `502 notebooklm_<type>`, never as 401, so you stay signed in.

## API

`GET/POST /api/libraries`, `GET/PATCH/DELETE /api/libraries/:id`,
`POST /api/libraries/:id/documents` (multipart), `DELETE /api/libraries/:id/documents/:docId`,
`POST .../documents/:docId/reindex`, `GET .../documents/:docId/text`,
`POST .../documents/:docId/sync`, `GET /api/libraries/:id/search?q=`, `GET/PUT /api/library/settings`
and `/api/library/notebooklm...` for the NotebookLM integration. The chat uses `libraryId` in
`POST /api/chat`.
