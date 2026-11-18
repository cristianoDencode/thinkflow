import type { PrototypeBlockDto, PrototypeSnapshot } from '@thinkflow/shared';
import type { EditorMode } from './free-layout';

export type { EditorMode };

/*
 * The seam between the React shell and the visual editor engine (GrapesJS). The shell only knows
 * this interface; the GrapesJS implementation lives in `grapes-adapter.ts` and is loaded lazily
 * (its own chunk) so the main bundle does not grow. Tests replace the loader with a fake adapter.
 */

export interface EditorState {
  /** Canvas changed since the last `load`/`markClean`. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Label of the selected component, null when nothing is selected. */
  selection: string | null;
  /** `data-ec` kind of the selected component, null when it is not a recognized e-Cidade one. */
  selectionKind?: string | null;
  /** The selection is shifted with `transform` (free move / arrow keys): "Restaurar posição" applies. */
  selectionOffset: boolean;
  /** "Livre": two or more sibling units are selected and none is locked, so "Agrupar" applies. */
  canGroup: boolean;
  /** "Livre": a group is selected (alone) and not locked, so "Desagrupar" applies. */
  canUngroup: boolean;
  /**
   * Canvas zoom in percent (100 = real size). It reflects EVERY change, whether it came from
   * `setZoom` (toolbar buttons, fit) or from the canvas itself (Ctrl+wheel), so the shell can show
   * the real value without tracking it on its own.
   */
  zoom: number;
  /** How the canvas reacts to the mouse: "Livre" (absolute drag / resize) or "HTML" (flow). */
  mode: EditorMode;
  /**
   * Bumped every time the document content changes (never by selection / zoom / mode): the shell
   * debounces its auto-save on it.
   */
  revision: number;
}

export type EditorCommand =
  | 'undo'
  | 'redo'
  | 'duplicate'
  | 'delete'
  | 'select-parent'
  | 'deselect'
  /** One position up / down among the sibling elements (no-op at the ends or when locked). */
  | 'move-up'
  | 'move-down'
  /** Removes the free-move offset (`transform: translate`) of the selection. */
  | 'reset-offset'
  /** Free layout: wraps the selected units in a group / dissolves the selected group (one undo step). */
  | 'group'
  | 'ungroup';

/** DOM nodes where the engine renders its panels (all stay mounted; the shell toggles them). */
export interface EditorMount {
  canvas: HTMLElement;
  blocks: HTMLElement;
  layers: HTMLElement;
  styles: HTMLElement;
  traits: HTMLElement;
  /** Ctrl+S inside the canvas/panels. */
  onSave(): void;
  /** The ⭐ of a "Desta tela" tile: save that component as a favorite of the e-Cidade palette. */
  onFavorite?(block: { label: string; html: string; css: string }): void;
}

export interface EditorAdapter {
  /** Replaces the canvas content (sanitized by the adapter) and the frame size; resets undo and dirty. */
  load(snapshot: PrototypeSnapshot): void;
  /** Current html/css, ready to be saved. */
  getSnapshot(): { html: string; css: string };
  setFrameSize(width: number, height: number): void;
  /** Percent, 100 = real size. The result shows up in `EditorState.zoom` (like Ctrl+wheel zoom). */
  setZoom(percent: number): void;
  /** Zoom that fits the whole frame in the visible canvas area. */
  fitZoom(): number;
  setUserBlocks(blocks: PrototypeBlockDto[]): void;
  /**
   * Appends the block to the selected container (or the page); next to a selected row / element it
   * goes right after it, or right above it with `opts.before`. A block with a `scope` (a favorite)
   * keeps its css scoped to the inserted component: pass the block as the palette holds it.
   */
  insertBlock(
    block: { html: string; css: string; scope?: string },
    opts?: { before?: boolean },
  ): void;
  /** Selected component as a reusable block, null when nothing is selected. */
  getSelectionAsBlock(): { label: string; html: string; css: string } | null;
  /**
   * Selected component for the AI assistant: its exported html and its position among the ELEMENT
   * children, from the `<body>` wrapper (`[]` would be the body itself). Null when nothing, or
   * only the body, is selected.
   */
  getSelectionPath(): { html: string; path: number[] } | null;
  /**
   * "Livre" or "HTML": the SAME document, edited differently. Free: dragging moves the
   * `data-tf-free` wrapper of a component (`left` / `top`, with guides), the arrows add 1px / 10px,
   * Ctrl+↑/↓ change its z-index, all 8 resize handles, blocks land at a free position. HTML: the
   * flow (reorder, Alt = translate). Default `html`.
   */
  setMode(mode: EditorMode): void;
  /** A drag, a resize or a text edit is in progress (the shell postpones its auto-save). */
  isInteracting?(): boolean;
  run(command: EditorCommand): void;
  markClean(): void;
  getState(): EditorState;
  subscribe(listener: (state: EditorState) => void): () => void;
  destroy(): void;
}

export type AdapterFactory = (mount: EditorMount) => EditorAdapter;
