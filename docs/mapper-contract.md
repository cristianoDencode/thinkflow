# Mapper contract (import format, version 1)

Thinkflow prototypes screens of legacy web systems. A **mapper** is a separate tool that
captures screens of such a system (for example a browser crawler or extension) and sends them to
Thinkflow, where they become editable prototypes. This document is the interchange format between
a mapper and Thinkflow. The reference implementation of the receiving side lives in
`apps/server/src/contexts/prototypes/` and the shared schema in
`packages/shared/src/prototype-import.ts` and `packages/shared/src/prototypes.ts`.

## System profiles

Thinkflow itself is generic. What is specific to one system (how its screens look, the component
palette in the editor, the starting window template, the style hints given to the AI assistant) is
a **system profile**. **e-Cidade** (open-source municipal ERP) is the first built-in profile and
the only one so far (`id: "ecidade"`, see `packages/shared/src/system-profiles.ts`).

The component marker vocabulary below (`data-ec`, `data-ec-part`) keeps the `ec` prefix for
historical reasons, but it is the _generic_ interchange vocabulary: it describes classic
form-based business screens (title bar, fieldsets, labelled fields, lookups, grids, button bars),
not e-Cidade specifically. A mapper for another system has two options:

1. Post plain HTML and let the server recognize components with its generic heuristics (labels,
   controls, tables, in order); anything not recognized stays editable as plain HTML.
2. Pre-annotate the HTML with the markers below. The server never overrides a marker that is
   already present.

## Endpoint and authentication

```
POST /api/prototypes/import
Content-Type: application/json
```

- Success: `201` with a `PrototypeCaptureResultDto` (the new prototype's metadata plus
  `components` — counts per `data-ec` kind — and `warnings`, a list of pt-BR messages).
- `400 validation_error`: invalid payload or unsupported `formatVersion`.
- `401 unauthorized`: no valid session.
- `413 prototype_too_large`: HTML + CSS above the size limit.
- Errors always have the shape `{ "error": { "code": "...", "message": "..." } }`.

**Authentication.** All `/api` routes of Thinkflow, this one included, use the web app's cookie
session (`tf_session`, obtained with `POST /api/auth/login`). The "API keys" of the Thinkflow
settings only authorize the OpenAI/Anthropic-compatible gateway under `/v1`, not `/api`. A mapper
therefore logs in like the web app and sends the session cookie. There is no separate token scheme
for the mapper yet.

## Payload (formatVersion 1)

```jsonc
{
  "formatVersion": 1, // required, must be 1
  "name": "Consulta de empenho", // required, 1-120 chars
  "snapshot": {
    // required
    "html": "<body>...</body>", // required, non-empty (see snapshot rules)
    "css": "label{color:#111}", // optional, default ""
    "width": 1366, // required, integer px
    "height": 768, // required, integer px
  },
  "source": {
    // optional
    "url": "https://erp.example/w/emp_consulta.php?e=1", // query/hash are dropped
    "title": "Consulta Empenho", // page/window title
    "menuPath": "Financeiro > Empenho > Consulta",
    "file": "emp_consulta.php", // routine/source file; derived from *.php URLs when absent
    "system": "ecidade", // profile id or any label
  },
  "keepData": false, // optional, default false
}
```

Unknown extra fields are ignored. `source.system` that matches no profile still imports; the
response carries a warning saying the generic heuristics were used.

### Limits

| Item                                         | Limit                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| HTML + CSS together                          | 15 MiB (`PROTOTYPE_LIMITS.maxSnapshotBytes`), data-URI images included                                                         |
| Request body                                 | about 31 MiB (twice the snapshot limit plus the JSON envelope)                                                                 |
| Canvas size                                  | clamped to 200-3840 px wide and 200-4320 px high, like an in-app capture (values below 1 or above 4x the maximum are rejected) |
| `name`                                       | 120 characters                                                                                                                 |
| `source.url` / `menuPath` / `title` / `file` | 2000 / 1000 / 300 / 300 characters                                                                                             |

## Snapshot rules

- `html` is the `<body ...>` markup of the screen, **self-contained**: Thinkflow renders it with
  JavaScript off and **no network access**, so nothing may depend on external resources.
- Images (`<img>`, `<input type="image">`, CSS `url()`) must be inlined as `data:image/...` URIs.
  Relative or remote image URLs will not load in the editor nor in the rendered PNG.
- CSS is the stylesheet of the screen, pruned to the rules the captured elements use, with
  `@font-face` inlined as data URIs when needed. No `@import`, no `<link>`.
- **Frames.** Old systems build screens from frames. Same-origin `<iframe>`/`<frame>` content must be
  **flattened** into a `<div data-tf-frame="n">` that has the iframe's box (position, size, margins)
  and holds the child document's body content. The child's CSS must be scoped to that div
  (`div[data-tf-frame="n"] selector`; the child's `html`/`body` rules apply to the div itself).
  Frames of another origin (unreadable) should be left as an empty box of the same size with
  `data-tf-blank="1"`.
- Form state is written into attributes (`value`, `checked`, `selected`, textarea text), because
  the snapshot is static markup.
- Elements that are not on screen (`display:none`, `visibility:hidden`) should be left out.
- The server removes anything that can run code or navigate: scripts, event-handler attributes,
  `javascript:` URLs, frames/objects/embeds, `<base>`, `<meta>`, `<link>`; do not rely on them.
- Do not include `data-tf-free*` attributes or a `scene` (those belong to the editor's free layout).

## What the server does on import

It applies exactly the treatment of a capture made inside Thinkflow:

1. **Sanitize** the HTML and CSS (see above); the result is re-serialized by the server.
2. **Scrub personal data** unless `keepData` is `true` (default is to scrub, for LGPD): values of
   inputs and cells of data grids are cleared (header rows are kept) and personal identifiers in
   text (such as CPF, CNPJ, e-mail and phone) are replaced by neutral values. Set `keepData`
   only for screens known to hold no real data.
3. **Annotate components**: recognized elements get `data-ec="<kind>"` on the component root and
   `data-ec-part="<part>"` on inner pieces. Markers already present are kept and not duplicated.
   Only attributes are added, never classes, so the captured CSS keeps applying unchanged.
4. **Clamp the canvas** to the editor limits and store version 1 with the note
   "Captura importada". The prototype is not linked to any test session.

The response lists the component counts of the stored HTML and any warnings.

## Marker vocabulary

Attributes: `data-ec` (component kind, on the component root) and `data-ec-part` (a piece inside
a component). Constants: `ECIDADE_COMPONENT_KINDS`, `ECIDADE_COMPONENT_PARTS`, `EC_KIND_ATTR`,
`EC_PART_ATTR` in `packages/shared/src/prototypes.ts`.

### `data-ec` kinds

| Kind           | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `window-title` | Window title bar with the breadcrumb, e.g. "Consultas > Consulta Empenho"              |
| `status-bar`   | Bottom status bar, e.g. "Instituição: ... Departamento: ..."                           |
| `fieldset`     | `fieldset` with its `legend`                                                           |
| `field`        | Label plus text input                                                                  |
| `lookup`       | Clickable (underlined) label plus code input, optionally a read-only description input |
| `date`         | Label, date input and a calendar button                                                |
| `date-range`   | Label, a date, a separator ("a") and a second date                                     |
| `select`       | Label plus select                                                                      |
| `textarea`     | Label plus textarea                                                                    |
| `checkbox`     | Checkbox with its label                                                                |
| `radio-group`  | Group of radio buttons                                                                 |
| `button`       | A single button                                                                        |
| `button-bar`   | Row of buttons (Search / Clear / Add ...)                                              |
| `grid`         | Data table with a header                                                               |
| `tabs`         | Tab strip with its panels                                                              |
| `message`      | Message / notice box                                                                   |

### `data-ec-part` parts

| Part        | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `label`     | Text label of a control                                     |
| `input`     | The control (input, select, textarea) of a component        |
| `desc`      | Read-only description input of a `lookup`                   |
| `button`    | A button inside a component                                 |
| `separator` | The separator between two dates (the "a" of a `date-range`) |
| `legend`    | Legend of a `fieldset`                                      |
| `header`    | Header row of a `grid`                                      |
| `row`       | Data row of a `grid`                                        |
| `cell`      | Cell of a `grid`                                            |
| `tab`       | A tab of `tabs`                                             |
| `panel`     | Content panel of a tab                                      |
| `title`     | Text of a `window-title`                                    |
| `text`      | Plain text piece (e.g. in a `status-bar`, `message`)        |

## Example

```sh
# 1. log in (stores the session cookie)
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"password":"<password>"}' \
  https://thinkflow.example/api/auth/login

# 2. send a screen
curl -b cookies.txt -H 'Content-Type: application/json' \
  https://thinkflow.example/api/prototypes/import -d '{
    "formatVersion": 1,
    "name": "Consulta de empenho",
    "snapshot": {
      "html": "<body><fieldset><legend>Consulta</legend><label>Número</label><input name=\"num\"></fieldset></body>",
      "css": "label{font-weight:bold}",
      "width": 1366,
      "height": 768
    },
    "source": { "url": "https://erp.example/w/emp_consulta.php", "title": "Consulta Empenho", "system": "ecidade" }
  }'
```

Thinkflow is single-user: login takes only the password. The session cookie is named `tf_session`.

## Versioning policy

- `formatVersion` is an integer; this document describes version `1`. The server accepts only
  versions it knows and answers `400` for others, so a mapper learns of a mismatch immediately.
- Within a version, changes are backward compatible: new optional fields may be added, unknown
  fields are ignored, and the marker vocabulary only grows (new kinds/parts are added, existing
  ones keep their meaning).
- A breaking change (renamed or removed field, changed meaning of a marker) bumps `formatVersion`
  and the server will keep accepting the previous version for at least one release when feasible.
- The `ec` naming of the markers will not change inside version 1.
