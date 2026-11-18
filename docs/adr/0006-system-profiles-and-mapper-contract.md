# 0006. System profiles and the mapper contract

## Status

Accepted

## Context

The prototype and test tooling began with one target: the screens of e-Cidade, an open-source
Brazilian municipal ERP with a recognizable look (grey windows, blue title bar, fieldsets, lookups,
grids). That knowledge is valuable, but Thinkflow is meant for analysts and QA of **any** legacy web
system, and hardcoding one system would make the project narrower than it is. Capturing screens
well also needs a crawler that navigates a system and extracts markup, which is a different tool
with a different release cycle than this workspace.

## Decision

- A **system profile** holds everything specific to a system: how its screens look, its palette
  category and recognized components, the standard window template and the prompt material for the
  AI assistant. e-Cidade is the **first built-in profile**; the rest of the tool is generic.
- The component markers on captured markup (`data-ec` and `data-ec-part`) are the shared
  vocabulary between mappers and the editor. They keep the `ec` prefix for historical reasons and
  are attributes only, so the original CSS keeps applying.
- A separate **mapper** (its own repository) captures screens and sends them to Thinkflow through
  `POST /api/prototypes/import`, a **versioned payload** (`formatVersion: 1`) with name, snapshot
  (HTML, CSS, size), optional source (URL, title, menu path, file, `system`) and an optional
  `keepData` flag. The server treats an import exactly like an in-app capture: sanitize, scrub
  personal data (unless `keepData`) and annotate components. An unknown `system` gets generic
  heuristics. The contract is documented in [mapper-contract.md](../mapper-contract.md).

## Consequences

- Supporting another system means adding a profile, not forking the editor.
- The mapper and Thinkflow evolve independently as long as the contract version holds; breaking
  changes require a new `formatVersion`.
- The `ec` prefix in markers can confuse newcomers, and only one profile exists today, so the
  abstraction is lightly exercised and may need adjusting when a second system arrives.
- Import is a trust boundary: everything received is sanitized and scrubbed server side.
