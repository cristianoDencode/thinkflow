# Reports and templates

Generates long documents (technical report, summary, PRD, prototype) in the **background** from a
**document template**, researching your sources (MCP servers and libraries). Open **Relatórios**
(tabs "Relatórios gerados" and "Modelos") or use the cards on the chat home screen.

## Templates

- **Kinds**: `report`, `summary`, `prd` and `prototype`. Built-in templates are read-only: use
  **Duplicate** to customize. There is one built-in per kind, plus a worked example of a guide for
  analysts of a municipal ERP.
- **Editor**: persona, goal, audience, title pattern, **variables** (`{{name}}`, with label,
  example, required or default; every variable used in the text must be declared), research
  (guidelines, maximum steps, use MCP and libraries), **sections** (title, requirements, table,
  diagram, word limit; reorderable) and **layout**: theme (`thinkflow`, `sobrio`, `compacto`),
  colors, logo (PNG or JPEG up to 200 KB), cover (with subtitle), header and footer text and a page
  break per section.
- **MCP servers per template**: each template chooses which servers research may use (empty = all
  enabled). Research runs **unattended** and may call any tool of those servers; the editor and the
  new-report dialog warn about it.
- **Template assistant** (`POST /api/report-templates/assist`, origin `template-assist` in Usage):
  **Import from prompt** (paste an existing prompt and the AI converts it) or **Create with AI**
  (describe the document). If the AI does not return valid JSON after two tries, a deterministic
  fallback detects the sections in the text and the draft carries a warning. The result is only a
  draft: review and save.

## How a report is generated

A pipeline with resume points, one step at a time (`report-runner`, its own queue):

1. **Research**: a short plan of steps (up to `maxResearchSteps`, 6 by default); each step queries
   MCP and/or the library (`buscar_na_biblioteca`) and keeps **notes** with the source.
2. **Outline**: distributes the notes among the sections within the context budget.
3. **Section by section writing** (`sectionMaxTokens`, 1,800 by default), each call with only that
   section's requirements and relevant notes, which fits small free models.
4. **Assembly**: table of contents, an "About this document" appendix (template, AI, sources,
   warnings) and the final HTML.

If a provider asks to wait (short 429), the report waits and continues, with the reason in the
progress bar. An exhausted quota or a persistent error leaves the report in **Error**, with
**Resume** from the step where it stopped (finished sections and notes are kept). You can also
**Cancel** and **Regenerate a section** (only that section and the assembly are redone). On server
restart, pending jobs resume. Origins in Usage: `report-research`, `report-outline`,
`report-section`, `report-intake` (variable extraction from the conversation), `diagram-repair` and
`template-assist`.

Settings (`GET/PUT /api/reports/settings`, key `reportSettings`): `defaultModel`, `repairModel`,
`maxResearchSteps`, `maxToolCallsPerStep`, `sectionMaxTokens`, `keepReports` (200; older ones are
removed) and `chromiumPath`.

## Outputs

- **HTML** is the canonical format (self-contained, with SVG diagrams and the template theme).
  **PDF** is rendered from it by Chromium, with a cache. **Markdown** is the text of the sections.
- **Add to Library** indexes the document in a library for future research
  ([library.md](library.md)).
- **Prototype** kind: HTML with screens navigable by CSS only (`:target`), a fixed component kit and
  no JavaScript, shown in a sandboxed `iframe`. No PDF for prototypes. (Not to be confused with the
  [Prototypes editor](prototypes.md).)

## Mermaid diagrams

Any model (or a NotebookLM answer) may return Mermaid diagrams in a messy form. Thinkflow
normalizes them in `packages/shared/src/diagrams` (a pure function used by the chat, the server and
the reports):

- **Fences**: ` ```mermaid `, ` ```flowchart `, unlabeled and mislabeled blocks are recognized by
  content and relabeled `mermaid`.
- **No fence**: a loose `flowchart TD ...`, `sequenceDiagram ...` and so on gets a fence when the
  body looks like a diagram. Blocks of other languages and ASCII art are untouched.
- **Common fixes**: labels with parentheses, quotes or accents, list markers and citations (`[1]`)
  inside the body, trailing `;`, a missing header, line terminators.

In the chat the diagram is drawn in the browser (`mermaid`, loaded on demand). If rendering fails,
**one** repair call is made (`POST /api/diagrams/repair`, origin `diagram-repair`) and the result
or the failure is stored in the message's `meta.diagramRepairs` (by code hash), so reopening a
conversation does not repeat it. In generated documents (HTML/PDF) diagrams are validated and
rendered **on the server** (Chromium) and embedded as sanitized SVG. Without Chromium a diagram
becomes a code block with a warning.

## Chromium

The server uses `playwright-core` (1.65.0, same version as `@playwright/test`) and **reuses the
Chromium already installed** in `~/.cache/ms-playwright`. Install it with
`pnpm --filter @thinkflow/web exec playwright install chromium`, or set a binary in
`reportSettings.chromiumPath`. Status: `GET /api/reports/renderer`.

**Degraded mode (no Chromium)**: generation, HTML and Markdown keep working; diagrams become code
blocks with a warning and the PDF buttons are disabled with the reason. Chromium runs **offline**
(external requests are blocked).

- **Docker**: the default image has no Chromium. Build with
  `docker build --build-arg WITH_CHROMIUM=true .` (a few hundred MB more).
- **Tests**: the real-Chromium test is opt-in (`RUN_CHROMIUM_TESTS=1`).
- **Known limitation**: the header and footer configured in a template also appear on the PDF
  cover.

## Chat document modes

The chat home has 4 cards (summarize a technical document, create a PRD, generate a report, create
a prototype). Each enables a **document mode**: `POST /api/chat` receives `preset`
(`{kind, templateId}`; `undefined` keeps the conversation's, `null` clears it) and a **Document
template** selector appears next to the library. The AI runs **guided questions** (the template's
variables, scope, and it may use tools to confirm names) and, after you confirm, calls the
`gerar_documento` tool. Models without tool calling may emit the tag
`<gerar_documento>{...}</gerar_documento>` in the text, which is recognized and removed from the
saved message. **Generate now** uses what was discussed (`report-intake` extraction); with missing
required variables the response is `422 report_missing_variables` with the list. The document is not
a message: the chat shows a **progress card** with **Open** and **Cancel**. The mode is copied on
**Fork** and dropped with a warning if the template is deleted.

## API

`POST /api/diagrams/repair`; `GET/POST /api/report-templates`,
`GET/PUT/DELETE /api/report-templates/:id`, `POST .../:id/duplicate`,
`POST /api/report-templates/assist`; `GET/POST /api/reports`, `GET/PATCH/DELETE /api/reports/:id`,
`POST .../:id/cancel`, `POST .../:id/retry`, `POST .../:id/sections/:ordinal/regenerate`,
`GET .../:id/html`, `GET .../:id/markdown`, `GET .../:id/pdf`, `POST .../:id/library`,
`GET /api/reports/renderer` and `GET/PUT /api/reports/settings`.

## Security

- Report HTML is sanitized (scripts, `on*` handlers, styles and external links removed; diagram SVG
  validated) and served with a restrictive **CSP** plus `sandbox`. The prototype kind is sanitized
  separately (only `#tela-...` anchors).
- Chromium has no network: nothing is fetched from the internet when making PDFs or diagrams.
- MCP, library and attachment content enters the prompt delimited as **data, not instructions**
  (prompt-injection mitigation), but research is automatic: use templates that list only MCP
  servers you trust.
