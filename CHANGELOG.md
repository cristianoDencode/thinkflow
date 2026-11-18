# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - First public release

First open-source release (MIT).

### Added

- **AI gateway and routing**: connections to OpenRouter, Groq, Mistral, NVIDIA NIM, DeepSeek,
  Ollama/LM Studio, Anthropic, OpenAI and any OpenAI-compatible endpoint; combos (virtual models
  with an ordered target list); fallback with per-connection cooldown and exponential backoff that
  honors `Retry-After`; automatic model selection restricted to text models.
- **Anthropic and OpenAI compatible gateway** (`/v1/messages`, `/v1/chat/completions`,
  `/v1/models`) so Claude Code (CLI and VS Code) and OpenAI clients can use the router, with model
  mapping and router API keys.
- **Chat** with a "thinking" panel, MCP tools (stdio and HTTP servers), attachments, history with
  search, incremental summaries and conversation forking, light and dark themes.
- **Agent mode** running Claude Code through the Claude Agent SDK, with every model call routed by
  Thinkflow.
- **Usage**: tokens per day, provider, model and origin, projections and an optional monthly
  budget.
- **Library**: PDF, DOCX, Markdown/TXT and image documents with OCR (Tesseract offline or vision
  model), SQLite FTS5 full-text search, citations in chat, and an experimental NotebookLM engine.
- **Data with AI** over PostgreSQL: read-only SQL checks plus `READ ONLY` transactions, schema
  exploration tools, structure-only or masked-sample visibility, result cards with CSV export.
- **Reports and templates**: background generation from document templates (report, summary, PRD,
  prototype) with MCP and library research, Mermaid diagrams, HTML, Markdown and PDF output.
- **Privacy firewall**: personal data (CPF, CNPJ, e-mail, phone, names and more) is tokenized
  before any model call and restored in the answer; optional Presidio sidecar.
- **QA toolkit**: Playwright-based test recording ("Gravar") and screenshot-only sessions
  ("Só prints"), annotated evidence editor, replay with data sets and per-step results, test-case
  documents in DOCX, PDF and HTML with a fixed set of sections and AI-assisted look and wording,
  upload of a new document per test case to a personal OneDrive.
- **Prototype editor** (GrapesJS) for legacy web screens: capture during a recording or import
  from an external mapper, Free mode (absolute positioning, multi-select, grouping, layer lock) and
  HTML mode on one document, autosave, versions, templates, favorites, AI assistant, PNG render and
  "send to test case". System profiles, with e-Cidade as the first built-in profile.
- **Storage**: pluggable object store (local disk, S3, MinIO) with a migration CLI and an optional
  MinIO Compose profile.
- **Operations**: Docker image (optional Chromium), health check, CI (format, lint, typecheck,
  architecture rules, coverage, build, end to end, image), release workflow to GHCR.

[Unreleased]: https://github.com/cristianoDencode/thinkflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cristianoDencode/thinkflow/releases/tag/v0.1.0
