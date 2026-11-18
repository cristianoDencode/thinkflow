# Prototypes

The **Protótipos** module turns a screen of a legacy web system into an editable prototype that
analysts can change, annotate and attach to a test-case document. It is a visual editor built on
[GrapesJS](https://grapesjs.com/), with a server that sanitizes, versions and renders the result.

Thinkflow is generic about the system being prototyped. What is specific to a system (how its
screens look, its component palette, the starting window and the material given to the AI
assistant) lives in a **system profile**; **e-Cidade** (an open-source Brazilian municipal ERP) is
the first built-in profile. See [ADR 0006](adr/0006-system-profiles-and-mapper-contract.md).

## Where prototypes come from

- **Capture during a recording**: in a recorded browser session ([testing.md](testing.md)), the
  **Protótipo** action captures the current screen (or the frame you are working in) as
  standalone HTML and CSS, links it to the session and step, and annotates the components it
  recognizes with `data-ec` / `data-ec-part` attributes.
- **Import from a mapper**: an external tool that maps the screens of a system can send them to
  `POST /api/prototypes/import`. The server treats an import exactly like a capture. The payload is
  described in [mapper-contract.md](mapper-contract.md).
- **New prototype**: start from a blank screen, from the profile's standard window, from one of
  your own templates, or paste the HTML of an existing screen.

Every capture or import is **sanitized** (no scripts, event handlers, frames or external
resources; see [SECURITY.md](../SECURITY.md)) and **scrubbed** of personal data: typed field values
and grid body cells are cleared, labels, titles, legends, captions and grid headers stay, and what
remains is checked by the [privacy detectors](privacy.md). An import can keep the data only if the
mapper explicitly asks for it (`keepData`).

## Editor

Two modes edit the **same document**, and you can switch at any time:

- **Free** (default): compose like in a design tool. Drag, resize and position components with
  absolute positioning; select several with `Shift` + click; **group** and **ungroup**; bring to
  front or send to back; enter a group by double click (`Esc` leaves it). Opening a plain HTML
  prototype in this mode converts it on the server to absolutely positioned wrappers around each
  component, preserving how it looks. See [ADR 0005](adr/0005-prototype-free-mode-as-positioned-html.md).
- **HTML**: edit the document flow. Drag to reorder, `Alt` + drag to move freely, arrows to nudge.

Panels: **Blocks** (the palette: the profile's components, "Desta tela" with what was recognized in
this screen, and your favorites) and **Layers** (a tree with a **lock**: a locked layer
cannot be selected, dragged or edited, and the lock is saved with the prototype); **Style**,
**Properties** (traits) and **AI** on the right. Canvas size is editable, with zoom and pan.

### Shortcuts

Both modes:

| Keys                                    | Action               |
| --------------------------------------- | -------------------- |
| `Ctrl+S`                                | Save                 |
| `Ctrl+Z` / `Ctrl+Shift+Z`               | Undo / redo          |
| `Ctrl+C` / `Ctrl+V`                     | Copy / paste element |
| `Ctrl+D`                                | Duplicate element    |
| `Delete`                                | Delete element       |
| Double click                            | Edit text            |
| `Space` + drag, or middle button + drag | Pan the canvas       |
| `Ctrl` + wheel                          | Zoom                 |

Free mode: drag to move, arrows move 1 px (`Shift` 10 px), `Ctrl+Up`/`Ctrl+Down` bring to front or
send to back, `Shift` + click selects several, `Ctrl+G` groups, `Ctrl+Shift+G` ungroups.

HTML mode: arrows move 1 px (`Shift` 10 px), drag reorders, `Alt` + drag moves freely,
`Ctrl+Up`/`Ctrl+Down` move the element up or down, `Shift` + click on a block inserts it above.

### Saving, autosave and versions

- The editor **autosaves** about 2 seconds after the last change (it waits while you are dragging).
  Autosaves made within 10 minutes of each other replace the same version instead of piling up.
- A manual save creates a **version** with a note ("Captura", "Edição", "IA: ...", "Restaurado
  de ..."). Up to 100 versions are kept; open any of them as a draft and save to make it current.
- Leaving with unsaved changes asks for confirmation.

### Favorites, templates and thumbnails

- **Favorites**: save a component to the profile's palette category to reuse it in any prototype.
  Its CSS is scoped to the inserted component so it does not restyle the rest of the screen.
- **Templates** ("modelos"): save a prototype as a template and start new prototypes from it. The
  profile's standard window is built in and read-only.
- Each prototype has a thumbnail, refreshed when it is rendered.

## AI assistant

The **AI** tab rewrites the HTML and CSS of the screen or of the selected component. It has quick
actions (add a field, turn content into a grid with given columns, two columns, adjust labels,
generate a screen) and a free prompt, and it can consult libraries and MCP servers. The server only
**proposes** a result: nothing is saved until you apply it, and the applied change becomes a
version noted as "IA: ...". Requests go through the router and the [privacy firewall](privacy.md);
suggested sample data must be fictitious.

## Output and test cases

- **Render to PNG**: Chromium renders the current version at its exact size, at scale 1 or 2, with
  JavaScript off and no network (`POST /api/prototypes/:id/render`). Without Chromium the action
  returns 503 and the editor says why.
- **Send to test case**: put the PNG into a step of a test session as its screenshot
  (`POST /api/prototypes/:id/send-to-session`); the prototype remembers which steps received it.

## API summary

`GET/POST /api/prototypes`, `GET/PUT/DELETE /api/prototypes/:id`, `POST /api/prototypes/import`,
`GET /api/prototypes/templates`, `GET/POST /api/prototypes/blocks`, `PUT/DELETE
/api/prototypes/blocks/:blockId`, `POST /api/prototypes/:id/save-as-template`,
`GET /api/prototypes/:id/versions/:vid`, `POST .../versions/:vid/restore`,
`POST /api/prototypes/:id/render`, `POST /api/prototypes/:id/send-to-session`,
`POST /api/prototypes/:id/assistant`. Files live in the `prototypes/` namespace of the object
store ([storage.md](storage.md)).
