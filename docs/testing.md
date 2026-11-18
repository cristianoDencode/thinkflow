# Testing: recording, evidence, replay and documents

Under **Testes**, a session combines manual testing, screenshots and a reusable script. It is meant
for QA and analysts who must prove that a change on a legacy web system works and hand over a
test-case document.

## Recording modes

The **mode** is chosen when you start recording the first time and does not change afterwards.
Older sessions are classified by their steps: any replayable step means "Gravar passos", otherwise
"Só prints".

1. **Gravar passos (record steps)**: enter the URL and start recording. The server opens a
   **visible** Chromium (Playwright) and an injected script records clicks, typing, selections,
   checkboxes and typed navigations as steps. Each step gets an **automatic screenshot** (PNG at
   the real window size) taken when the screen **settles**: page and frames loaded, no request in
   flight (about 500 ms) and no DOM change (about 400 ms), with an 8 s cap. If the next action
   arrives first, the shot is taken immediately so it never shows a later state. There is no manual
   capture in this mode.
2. **Só prints (screenshots only)**: the browser opens and **nothing you do becomes a step**.
   **Capturar** (button on the floating bar, `Ctrl+Shift+S` in the window or in the Thinkflow
   screen) waits for the screen to settle (up to 3 s) and creates a "Print da tela" step with the
   image, which opens in the editor. There is no replay or script in this mode. **Parar** is also on
   the floating bar of the browser.

Recording needs Thinkflow running on your machine (`pnpm dev` or `pnpm start`), not in Docker,
because the browser window must open on your screen. Install the browser with
`pnpm --filter @thinkflow/web exec playwright install chromium`, or set a Chromium path in
Reports, Settings.

**Locators**: the recorder prefers `data-testid`, then role and name, label, placeholder, text and
CSS, only keeping those that match exactly one element at that moment, and stores alternatives for
replay.

**Secrets**: passwords, cards, one-time codes and data marked as secret are stored encrypted,
blacked out in every screenshot and shown as `••••••` in the document; in the generated script they
come from environment variables (`TF_SENHA`, `TF_SENHA_2`, ...).

## Evidence editor

In **Steps**, each step with an image has a thumbnail, an _Include screenshot in the document_
switch, **Edit** and **Remove screenshot** (the step stays). The full-screen editor works like
Flameshot: pencil, line, arrow, rectangle, ellipse, highlight, text, step number and redaction bar;
color and thickness; `Ctrl+Z`/`Ctrl+Y`; `Ctrl+C` copies and `Ctrl+S` downloads the PNG; `Enter`
saves, `Esc` closes, `Space` shows the comment panel. **Add screenshot** (or `Ctrl+V`) creates a
step from a PNG of another system.

## Assertions

In "Gravar passos", the **Verify** mode turns a click into an assertion (field value, visible text
or visible element) instead of sending it to the page. There are also _Verify URL_ and title.

## Data sets and replay

Every typed value becomes a parameter. Create data sets with other values and run again, headless
or with the browser visible. The result is shown per step, with a screenshot on failure. "Print da
tela" steps and notes are not executed. You can also export a data-driven `@playwright/test`
script (`.spec.ts`).

## Test-case document

The **Documento** tab builds a test-case document ("Caso de Teste CT") from the session:

- **Header** (title, ticket, priority, system and module, author), **context**, **test plan** with
  the use cases and their acceptance criteria, and a **version control** table. Use-case dividers
  split the steps; each use case has a title and a status. The step comments and the screenshots set
  to be included form its content.
- **Outputs**: DOCX, PDF (rendered from the HTML by Chromium) and HTML, plus copy to clipboard for
  Word or Docs, Markdown and a `.zip` (Markdown, HTML and images).
- **AI assistant** for the text of the document (review the writing, improve the context, describe
  the use cases, suggest a title, or a free request). It only sees and edits text, never images, and
  its suggestion is applied only after you accept it. Requests go through the router and the
  [privacy firewall](privacy.md).
- **Document models**: the _categories_ of the document (its sections, fields and their labels)
  are fixed. A model only controls the **look**: titles, header and footer text, colors, font, logo
  and its position. In the document tab, pick the model in the **Modelo** selector (the built-in
  **Padrão** is neutral, with no logo) and open **Modelos…** to create, edit, duplicate or delete
  models with a live preview. **Criar modelo com IA** turns a description ("sober, navy blue,
  logo on the left, footer with the team name") into a draft you review before saving; the AI
  only designs the look, never writes HTML/CSS, never invents a logo (you upload it) and never
  changes the categories. API: `/api/tests/ct-models` (list, create, preview, assist, update,
  delete) and `PUT /api/tests/sessions/:id/ct/model` to choose the model of a test.
- **OneDrive**: upload the DOCX as a **new** file to a folder of a personal Microsoft account and
  open it in Word Online ([onedrive.md](onedrive.md)).

Images are stored in the object store (`tests/` namespace, see [storage.md](storage.md)).

## Prototypes in a session

While recording, the **Protótipo** action captures the current screen as an editable prototype
([prototypes.md](prototypes.md)), and a rendered prototype can be sent back to a step as its
screenshot.
