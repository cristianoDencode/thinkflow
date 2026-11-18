# 0005. Prototype free mode as positioned HTML

## Status

Accepted

## Context

Analysts want to rearrange a captured screen the way they would in a design tool: drag, resize and
overlap components, then place the result in a test document. A first attempt decomposed the
screen into an **image-layer canvas** (Konva): a background image plus each recognized component
cut out as a picture, with text boxes and rectangles on top. It could move things, but it could
not edit text or colors, because the layers were pictures, and the composition diverged from the
HTML document that the rest of the system (versions, the AI assistant, sanitizing, rendering,
favorites) already understands. Two representations of one screen meant conversions in both
directions and lost fidelity.

## Decision

**Free mode is the same HTML document with absolutely positioned wrappers.** Each component is
wrapped in an element marked `data-tf-free` with `position:absolute`, left, top, size and
`z-index`; groups are wrappers that contain wrappers. The editor offers two interaction modes,
**Free** and **HTML**, over that single document:

- Opening a plain HTML prototype in Free mode converts it on the server (a script run in Chromium
  measures each component and copies the computed styles it needs) so the screen looks unchanged.
- Moving, resizing, grouping, locking and stacking only change inline styles and attributes, so
  text and colors stay editable, undo works, and versions, the AI assistant and PNG rendering need
  no special case.
- Layer lock is an attribute (`data-tf-locked`) saved with the markup. Autosave runs every 2
  seconds of inactivity.

## Consequences

- One source of truth: every feature works in both modes, and switching never converts through an
  intermediate format.
- Absolutely positioned layouts are less responsive than flow layouts, which is acceptable for
  screenshots and test evidence of fixed-size legacy screens.
- The one-time conversion to wrappers is heuristic for unusual layouts and may need manual fixes.
- The image-layer scene is not part of this design: prototypes are plain HTML documents, so older
  prototypes keep working.
