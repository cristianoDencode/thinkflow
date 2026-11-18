import { useQueryClient } from '@tanstack/react-query';
import {
  AUTOSAVE_NOTE,
  ECIDADE_BLOCK_CATEGORY,
  PROTOTYPE_LIMITS,
  type PrototypeBlockDto,
  type PrototypeDetailDto,
  type PrototypeFreeLayoutDto,
  type PrototypeVersionDto,
} from '@thinkflow/shared';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Boxes,
  CopyPlus,
  CornerLeftUp,
  Group,
  ImageOff,
  Keyboard,
  Layers,
  LoaderCircle,
  LocateFixed,
  Maximize,
  RefreshCw,
  PackagePlus,
  Palette,
  Redo2,
  Save,
  SlidersHorizontal,
  Send,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  Ungroup,
  ZoomIn,
  ZoomOut,
  ExternalLink,
  LayoutTemplate,
  BookmarkPlus,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { readBackground } from '../../lib/background-location';
import { notify } from '../../lib/notify';
import { useTestSessions } from '../../lib/queries';
import { cn, formatTime } from '../../lib/utils';
import { loadEditorAdapter } from './adapter-loader';
import type { EditorAdapter, EditorMode, EditorState } from './editor-adapter';
import { isFreeHtml } from './free-layout';
import {
  fetchVersion,
  protoKeys,
  useDeleteBlock,
  usePrototype,
  usePrototypeBlocks,
  useRestoreVersion,
  useSaveAsTemplate,
  useSaveBlock,
  useUpdateBlock,
  useUpdatePrototype,
} from './queries';
import {
  favoriteSignature,
  favoriteSource,
  isFavorite,
  stripFavoriteAttr,
  unscopeFavoriteCss,
} from './favorites';
import {
  PrototypeAssistantPanel,
  type PrototypeAssistantChange,
} from './prototype-assistant-panel';
import { RenderImageButton, SendToDocumentDialog } from './send-to-document-dialog';
import { thumbnailSrc } from './thumbnail';
import { DuplicateFavoriteDialog, SaveBlockDialog, UserBlocksList } from './user-blocks';
import { VersionsMenu } from './versions-menu';

/** Auto-save fires this long after the last change. */
const AUTOSAVE_DELAY_MS = 2000;
/** While a drag / resize / text edit is running, the auto-save looks again after this. */
const AUTOSAVE_RETRY_MS = 500;

const IDLE: EditorState = {
  dirty: false,
  canUndo: false,
  canRedo: false,
  selection: null,
  selectionOffset: false,
  canGroup: false,
  canUngroup: false,
  zoom: 100,
  mode: 'html',
  revision: 0,
};
const ZOOM_STEPS = [25, 33, 50, 67, 75, 100, 125, 150, 200];

const SHORTCUTS_COMMON: [string, string][] = [
  ['Ctrl+S', 'Salvar'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Desfazer / refazer'],
  ['Ctrl+C / Ctrl+V', 'Copiar / colar elemento'],
  ['Ctrl+D', 'Duplicar elemento'],
  ['Delete', 'Excluir elemento'],
  ['Duplo clique', 'Editar texto'],
  ['Espaço + arrastar', 'Mover a tela'],
  ['Botão do meio + arrastar', 'Mover a tela'],
  ['Ctrl + roda', 'Zoom'],
];
const SHORTCUTS: Record<EditorMode, [string, string][]> = {
  html: [
    ...SHORTCUTS_COMMON,
    ['Setas / Shift + setas', 'Mover elemento 1px / 10px'],
    ['Arrastar', 'Reordenar elemento'],
    ['Alt + arrastar', 'Mover livremente'],
    ['Ctrl + ↑ / ↓', 'Subir / descer elemento'],
    ['Shift + clique no bloco', 'Inserir acima'],
  ],
  free: [
    ...SHORTCUTS_COMMON,
    ['Arrastar', 'Mover livremente'],
    ['Setas', 'Mover 1px / Shift 10px'],
    ['Ctrl + ↑ / ↓', 'Trazer para frente / enviar para trás'],
    ['Shift + clique', 'Selecionar vários'],
    ['Ctrl+G', 'Agrupar'],
    ['Ctrl+Shift+G', 'Desagrupar'],
    ['Duplo clique no grupo', 'Entrar no grupo (Esc sai)'],
  ],
};

const clampSize = (value: string, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
};

type LeftTab = 'blocks' | 'layers';
type RightTab = 'style' | 'traits' | 'ai';

function PanelTabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange(value: T): void;
  items: { value: T; label: string; icon: typeof Boxes }[];
}) {
  return (
    <div role="tablist" className="flex shrink-0 border-b border-border">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            'flex flex-1 cursor-pointer items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors',
            value === item.value
              ? 'border-b-2 border-accent text-accent-text'
              : 'text-muted hover:text-fg',
          )}
        >
          <item.icon className="h-4 w-4" aria-hidden /> {item.label}
        </button>
      ))}
    </div>
  );
}

/** Small preview next to the name: the placeholder stays until the server has rendered the PNG. */
function HeaderThumbnail({ src, name }: { src: string | null; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className="flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2 text-subtle">
      {src && failedSrc !== src ? (
        <img
          src={src}
          alt={`Miniatura de ${name}`}
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <LayoutTemplate className="h-4 w-4" aria-hidden />
      )}
    </span>
  );
}

export function PrototypeEditorPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { data: detail, isLoading, error, dataUpdatedAt } = usePrototype(id);
  const { data: sessions = [] } = useTestSessions();
  const { data: userBlocks = [] } = usePrototypeBlocks();
  const update = useUpdatePrototype(id ?? '');
  const restore = useRestoreVersion(id ?? '');
  const saveBlock = useSaveBlock();
  const updateBlock = useUpdateBlock();
  const deleteBlock = useDeleteBlock();
  const saveAsTemplate = useSaveAsTemplate(id ?? '');

  const canvasRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const stylesRef = useRef<HTMLDivElement>(null);
  const traitsRef = useRef<HTMLDivElement>(null);

  const [adapter, setAdapter] = useState<EditorAdapter | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(IDLE);
  const [draftDirty, setDraftDirty] = useState(false);
  /*
   * "Livre" and "HTML" edit the SAME document: the mode only changes how the canvas reacts to the
   * mouse. "Livre" is the default: opening a plain HTML prototype converts it (server side) into a
   * free layout, which is still HTML.
   */
  const [mode, setMode] = useState<EditorMode>('free');
  /** The loaded document is a free layout (`data-tf-free` wrappers). */
  const [docFree, setDocFree] = useState(false);
  /**
   * The free layout was just made from the saved HTML and nothing was touched yet: it is not a
   * change, so nothing is saved (auto-save included) and the saved HTML stays the output.
   */
  const [freeAuto, setFreeAuto] = useState(false);
  const [freeBusy, setFreeBusy] = useState(false);
  const [freeConfirm, setFreeConfirm] = useState<'recreate' | 'discard' | null>(null);
  /** Auto-save progress: the badge says "Salvando…" / "Salvo automaticamente". */
  const [autoStatus, setAutoStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sizeDraft, setSizeDraft] = useState({ width: '', height: '' });
  const [zoom, setZoom] = useState(100);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [leftTab, setLeftTab] = useState<LeftTab>('blocks');
  const [rightTab, setRightTab] = useState<RightTab>('style');
  const [showKeys, setShowKeys] = useState(false);
  const [pending, setPending] = useState<{
    version: PrototypeVersionDto;
    action: 'open' | 'restore';
  } | null>(null);
  const [blockDraft, setBlockDraft] = useState<{ label: string; html: string; css: string } | null>(
    null,
  );
  const [blockError, setBlockError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [duplicate, setDuplicate] = useState<{
    block: { name: string; html: string; css: string };
    existing: PrototypeBlockDto;
  } | null>(null);
  const renderWrap = useRef<HTMLSpanElement>(null);
  const renderBypass = useRef(false);

  const savingRef = useRef(false);
  const loaded = useRef<{ adapter: EditorAdapter; id: string } | null>(null);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const favoriteRef = useRef<(block: { label: string; html: string; css: string }) => void>(
    () => undefined,
  );

  const sizeChanged = Boolean(
    detail && loaded.current && (size.width !== detail.width || size.height !== detail.height),
  );
  const dirty = editor.dirty || draftDirty || sizeChanged;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const autoFailed = useRef(false);
  /** Revision an auto-save failed at: no retry until the document changes again. */
  const failedRevision = useRef<number | null>(null);

  /* ---- engine (lazy chunk) --------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    let created: EditorAdapter | null = null;
    let unsubscribe: (() => void) | undefined;
    loadEditorAdapter()
      .then((factory) => {
        if (cancelled) return;
        created = factory({
          canvas: canvasRef.current!,
          blocks: blocksRef.current!,
          layers: layersRef.current!,
          styles: stylesRef.current!,
          traits: traitsRef.current!,
          onSave: () => void saveRef.current(),
          onFavorite: (block) => favoriteRef.current(block),
        });
        // the zoom the engine reports (toolbar OR Ctrl+wheel) drives the toolbar display; only a
        // CHANGE of it is applied, so unrelated state emits never overwrite a pending local value
        let seenZoom = created.getState().zoom;
        unsubscribe = created.subscribe((state) => {
          setEditor(state);
          if (typeof state.zoom === 'number' && state.zoom !== seenZoom) {
            seenZoom = state.zoom;
            setZoom(state.zoom);
          }
        });
        setAdapter(created);
      })
      .catch((err) => !cancelled && setEngineError(errorMessage(err)));
    return () => {
      cancelled = true;
      unsubscribe?.();
      created?.destroy();
      loaded.current = null;
      setAdapter(null);
      setEditor(IDLE);
    };
  }, []);

  const applyZoom = useCallback(
    (value: number) => {
      setZoom(value);
      adapter?.setZoom(value);
    },
    [adapter],
  );

  /** Puts a snapshot in the canvas and syncs the size controls. */
  const loadIntoCanvas = useCallback(
    (snapshot: { html: string; css: string; width: number; height: number }, keepZoom = false) => {
      if (!adapter) return;
      // a version made by the old image-based free editor carries a `scene`: ignored here, the
      // next save sends only html / css, which makes the HTML the output again
      adapter.load({
        html: snapshot.html,
        css: snapshot.css,
        width: snapshot.width,
        height: snapshot.height,
      });
      adapter.setMode(modeRef.current);
      setDocFree(isFreeHtml(snapshot.html));
      setFreeAuto(false);
      setAutoStatus('idle');
      setSize({ width: snapshot.width, height: snapshot.height });
      setSizeDraft({ width: String(snapshot.width), height: String(snapshot.height) });
      const nextZoom = keepZoom ? zoom : adapter.fitZoom();
      setZoom(nextZoom);
      adapter.setZoom(nextZoom);
    },
    [adapter, zoom],
  );

  /** Switches how the canvas reacts to the mouse; the document stays the same. */
  const changeMode = useCallback(
    (next: EditorMode) => {
      modeRef.current = next;
      setMode(next);
      adapter?.setMode(next);
    },
    [adapter],
  );

  /**
   * `POST free-layout`: the SAVED version turned into a free layout (still HTML), loaded as the
   * baseline — it is not a change, so nothing is saved until the first edit and the saved HTML
   * stays the output. Failing keeps (or goes back to) the HTML mode.
   */
  const convertToFree = async (prototypeId: string): Promise<boolean> => {
    if (!adapter) return false;
    setFreeBusy(true);
    try {
      const out = await api.post<PrototypeFreeLayoutDto>(
        `/api/prototypes/${encodeURIComponent(prototypeId)}/free-layout`,
      );
      const dims = queryClient.getQueryData<PrototypeDetailDto>(protoKeys.detail(prototypeId));
      changeMode('free');
      loadIntoCanvas(
        {
          html: out.html,
          css: out.css,
          width: dims?.width ?? detail?.width ?? size.width,
          height: dims?.height ?? detail?.height ?? size.height,
        },
        true,
      );
      setDraftDirty(false);
      setFreeAuto(true);
      return true;
    } catch (err) {
      changeMode('html');
      notify.info(`O modo livre não abriu (${errorMessage(err)}). Usando o modo HTML.`);
      return false;
    } finally {
      setFreeBusy(false);
    }
  };

  // the first time this prototype meets this engine instance: load it (never again: later
  // refetches/renames/links must not wipe unsaved edits)
  useEffect(() => {
    if (!adapter || !detail) return;
    if (loaded.current?.adapter === adapter && loaded.current.id === detail.id) return;
    loaded.current = { adapter, id: detail.id };
    loadIntoCanvas(detail);
    setDraftDirty(false);
    if (modeRef.current === 'free' && !isFreeHtml(detail.html)) void convertToFree(detail.id);
  }, [adapter, detail, loadIntoCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    adapter?.setUserBlocks(userBlocks);
  }, [adapter, userBlocks]);

  useEffect(() => {
    if (detail) setName(detail.name);
  }, [detail?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- saving ---------------------------------------------------------------------------- */
  const save = useCallback(
    async (note = 'Edição', opts: { autosave?: boolean } = {}): Promise<boolean> => {
      if (!adapter || !detail || savingRef.current) return false;
      const auto = Boolean(opts.autosave);
      savingRef.current = true;
      setSaving(true);
      if (auto) setAutoStatus('saving');
      try {
        const sent = adapter.getSnapshot();
        const saved = await api.put<PrototypeDetailDto>(`/api/prototypes/${detail.id}`, {
          snapshot: { ...sent, width: size.width, height: size.height },
          note,
          ...(auto ? { autosave: true } : {}),
        });
        queryClient.setQueryData(protoKeys.detail(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: protoKeys.list });
        // edits made while the request was in flight stay unsaved: the auto-save takes them next
        const now = adapter.getSnapshot();
        if (now.html === sent.html && now.css === sent.css) adapter.markClean();
        setDraftDirty(false);
        setAutoStatus(auto ? 'saved' : 'idle');
        autoFailed.current = false;
        failedRevision.current = null;
        if (!auto) notify.success(note === 'Edição' ? 'Protótipo salvo' : 'Versão criada');
        return true;
      } catch (err) {
        setAutoStatus('idle');
        if (!auto) notify.error(errorMessage(err));
        else {
          // quiet auto-saves: one message, and no new attempt until something changes again
          failedRevision.current = adapter.getState().revision;
          if (!autoFailed.current) notify.error(`Auto-save falhou: ${errorMessage(err)}`);
          autoFailed.current = true;
        }
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [adapter, detail, queryClient, size],
  );
  const saveFnRef = useRef(save);
  saveFnRef.current = save;
  saveRef.current = async () => (dirty ? save() : true);
  const saveIfDirty = async () => (dirty ? save() : true);

  /* ---- auto-save: 2s after the last change (never while dragging / resizing / typing) -------- */
  const autosavePending = (editor.dirty || sizeChanged) && !freeAuto && !freeBusy;
  useEffect(() => {
    if (!adapter || !autosavePending) return;
    if (failedRevision.current !== null && failedRevision.current === editor.revision) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (savingRef.current || adapter.isInteracting?.()) {
        timer = setTimeout(attempt, AUTOSAVE_RETRY_MS);
        return;
      }
      void saveFnRef.current(AUTOSAVE_NOTE, { autosave: true });
    };
    timer = setTimeout(attempt, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [adapter, autosavePending, editor.revision, saving]);

  // the first edit of a fresh free layout is what makes it a change worth saving
  useEffect(() => {
    if (freeAuto && dirty) setFreeAuto(false);
  }, [freeAuto, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---- leaving with unsaved changes ------------------------------------------------------- */
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      // menu pages open as a modal over this screen: the editor stays mounted
      !readBackground(nextLocation),
  );
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  /* ---- actions --------------------------------------------------------------------------- */
  const commitName = async () => {
    const trimmed = name.trim();
    if (!detail || !trimmed || trimmed === detail.name) {
      if (detail) setName(detail.name);
      return;
    }
    try {
      await update.mutateAsync({ name: trimmed });
    } catch (err) {
      setName(detail.name);
      notify.error(errorMessage(err));
    }
  };

  const linkSession = async (sessionId: string) => {
    try {
      await update.mutateAsync({ sessionId: sessionId || null });
      notify.success(sessionId ? 'Protótipo vinculado ao teste' : 'Vínculo removido');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const commitSize = () => {
    const width = clampSize(
      sizeDraft.width,
      PROTOTYPE_LIMITS.minSize,
      PROTOTYPE_LIMITS.maxWidth,
      size.width,
    );
    const height = clampSize(
      sizeDraft.height,
      PROTOTYPE_LIMITS.minSize,
      PROTOTYPE_LIMITS.maxHeight,
      size.height,
    );
    setSizeDraft({ width: String(width), height: String(height) });
    if (width === size.width && height === size.height) return;
    setSize({ width, height });
    adapter?.setFrameSize(width, height);
  };

  const confirmVersion = async () => {
    if (!pending || !id) return;
    const { version, action } = pending;
    setPending(null);
    try {
      if (action === 'open') {
        const data = await fetchVersion(id, version.id);
        // a draft cannot be converted (the server converts the saved version): plain html opens as html
        const toHtml = modeRef.current === 'free' && !isFreeHtml(data.html);
        if (toHtml) changeMode('html');
        loadIntoCanvas(data);
        setDraftDirty(true);
        notify.info(
          `Versão aberta como rascunho${toHtml ? ' no modo HTML' : ''}. Salve para criar uma nova versão.`,
        );
      } else {
        const restored = await restore.mutateAsync(version.id);
        loaded.current = adapter ? { adapter, id: restored.id } : null;
        loadIntoCanvas(restored);
        setDraftDirty(false);
        notify.success('Versão restaurada');
        if (modeRef.current === 'free' && !isFreeHtml(restored.html))
          void convertToFree(restored.id);
      }
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const openSaveBlock = () => {
    const block = adapter?.getSelectionAsBlock();
    if (!block) return;
    setBlockError(null);
    setBlockDraft(block);
  };

  const submitBlock = async (blockName: string) => {
    if (!blockDraft) return;
    try {
      await saveBlock.mutateAsync({
        name: blockName,
        category: 'Meus blocos',
        html: blockDraft.html,
        css: blockDraft.css,
      });
      setBlockDraft(null);
      notify.success('Bloco salvo em “Meus blocos”');
      setLeftTab('blocks');
    } catch (err) {
      setBlockError(errorMessage(err));
    }
  };

  /* ---- favorites (⭐ Favoritar na paleta) ----------------------------------------------- */
  const favorites = userBlocks.filter(isFavorite);

  const storeFavorite = async (
    block: { name: string; html: string; css: string },
    replaces?: PrototypeBlockDto,
  ) => {
    try {
      await saveBlock.mutateAsync({
        name: block.name.slice(0, 80),
        category: ECIDADE_BLOCK_CATEGORY,
        html: block.html,
        css: block.css,
        source: favoriteSource(detail?.name ?? 'protótipo'),
      });
      if (replaces) await deleteBlock.mutateAsync(replaces.id);
      setDuplicate(null);
      notify.success(replaces ? 'Favorito substituído na paleta' : 'Favoritado na paleta');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  /** Saves a component to the e-Cidade palette; the same structure twice asks what to do. */
  const requestFavorite = (picked: { label: string; html: string; css: string }) => {
    // a component that came from a favorite is stored again the way a capture would give it
    const block = {
      name: picked.label,
      html: stripFavoriteAttr(picked.html),
      css: unscopeFavoriteCss(picked.css),
    };
    const signature = favoriteSignature(block.html);
    const existing = signature
      ? favorites.find((f) => favoriteSignature(f.html) === signature)
      : undefined;
    if (existing) setDuplicate({ block, existing });
    else void storeFavorite(block);
  };
  favoriteRef.current = requestFavorite;

  const favoriteSelection = () => {
    const picked = adapter?.getSelectionAsBlock();
    if (picked) requestFavorite(picked);
  };

  const renameBlock = (block: PrototypeBlockDto, newName: string) =>
    updateBlock.mutate(
      { id: block.id, name: newName },
      { onError: (err) => notify.error(errorMessage(err)) },
    );

  /* ---- template ("Salvar como modelo") ------------------------------------------------------ */
  const openTemplate = async () => {
    if (!detail || !(await saveIfDirty())) return;
    setTemplateName(detail.name);
    setTemplateOpen(true);
  };

  const submitTemplate = async () => {
    const trimmed = templateName.trim();
    if (!trimmed) return;
    try {
      await saveAsTemplate.mutateAsync({ name: trimmed });
      setTemplateOpen(false);
      notify.success('Modelo salvo. Ele aparece em Novo protótipo › Meus modelos.');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  /** The render dialog renders the saved version: save pending edits first, then let it open. */
  const onRenderClickCapture = (e: { stopPropagation(): void; preventDefault(): void }) => {
    if (renderBypass.current || !dirty) return;
    e.stopPropagation();
    e.preventDefault();
    void save().then((ok) => {
      if (!ok) return;
      renderBypass.current = true;
      renderWrap.current?.querySelector('button')?.click();
      renderBypass.current = false;
    });
  };

  const openSend = async () => {
    if (await saveIfDirty()) setSendOpen(true);
  };

  const applyAssistant = async (change: PrototypeAssistantChange) => {
    if (!adapter) return;
    loadIntoCanvas(
      {
        html: change.html,
        css: change.css,
        width: size.width,
        height: size.height,
      },
      true,
    );
    // the previous version stays in the versions menu, so this is always reversible
    const ok = await save(`IA: ${change.prompt.slice(0, 150)}`);
    if (!ok) setDraftDirty(true);
    // the AI returned plain html while "Livre" is on: lay it out again from the saved version
    else if (detail && modeRef.current === 'free' && !isFreeHtml(change.html))
      void convertToFree(detail.id);
  };

  /* ---- "Livre" / "HTML" ------------------------------------------------------------------------ */
  const switchMode = async (next: EditorMode) => {
    if (next === mode || freeBusy) return;
    if (next === 'html' || docFree) {
      changeMode(next);
      return;
    }
    // "Livre" on a plain html document: the SAVED version is converted, so pending edits go first
    if (!detail || !(await saveIfDirty())) return;
    await convertToFree(detail.id);
  };

  /**
   * The newest version that is plain HTML (not a free layout): the current one when it is, else
   * the first one, newest to oldest, that is. Null when every version is a free layout.
   */
  const findPlainVersion = async (): Promise<
    | { current: true }
    | {
        current: false;
        version: PrototypeVersionDto;
        data: Awaited<ReturnType<typeof fetchVersion>>;
      }
    | null
  > => {
    if (!detail) return null;
    if (!isFreeHtml(detail.html)) return { current: true };
    const older = [...detail.versions]
      .filter((v) => v.id !== detail.versionId)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const version of older) {
      const data = await fetchVersion(detail.id, version.id);
      if (!isFreeHtml(data.html)) return { current: false, version, data };
    }
    return null;
  };

  /** "Recriar a partir do HTML": converts the last plain-HTML version again (restoring it first). */
  const recreateFree = async () => {
    if (!detail) return;
    setFreeBusy(true);
    try {
      const plain = await findPlainVersion();
      if (!plain) {
        notify.error('Nenhuma versão em HTML puro para recriar o modo livre.');
        return;
      }
      if (!plain.current) {
        // the server converts the CURRENT version: the plain one becomes current first
        const restored = await restore.mutateAsync(plain.version.id);
        loaded.current = adapter ? { adapter, id: restored.id } : null;
      }
      await convertToFree(detail.id);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setFreeBusy(false);
    }
  };

  /** "Descartar modo livre": the last plain-HTML version in the canvas, in HTML mode. */
  const discardFree = async () => {
    if (!detail) return;
    setFreeBusy(true);
    try {
      const plain = await findPlainVersion();
      if (!plain) {
        notify.error('Nenhuma versão em HTML puro para voltar.');
        return;
      }
      changeMode('html');
      if (plain.current) {
        loadIntoCanvas(detail);
        setDraftDirty(false);
        notify.info('Modo livre descartado: a tela voltou para o HTML salvo.');
      } else {
        loadIntoCanvas(plain.data);
        setDraftDirty(true);
        notify.info('Versão em HTML aberta como rascunho. Salve para criar uma nova versão.');
      }
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setFreeBusy(false);
    }
  };

  const confirmFree = () => {
    const action = freeConfirm;
    setFreeConfirm(null);
    if (action === 'discard') void discardFree();
    else if (action === 'recreate') void recreateFree();
  };

  const zoomBy = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((z) => z > zoom) ?? ZOOM_STEPS.at(-1)!)
        : ([...ZOOM_STEPS].reverse().find((z) => z < zoom) ?? ZOOM_STEPS[0]!);
    applyZoom(next);
  };

  const ready = Boolean(adapter && detail);
  const thumbSrc = detail ? thumbnailSrc(detail, dataUpdatedAt) : null;

  return (
    <div className="proto-editor-page flex h-full min-h-[34rem] flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2">
        <Link
          to="/prototypes"
          aria-label="Voltar para Protótipos"
          title="Protótipos"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <HeaderThumbnail src={thumbSrc} name={detail?.name ?? ''} />
        <Input
          aria-label="Nome do protótipo"
          className="h-8 w-56 rounded-lg"
          value={name}
          maxLength={120}
          disabled={!detail}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {detail?.kind === 'template' && <Badge tone="accent">Modelo</Badge>}
        <span role="status" aria-live="polite">
          {dirty ? (
            <Badge tone="warning">
              {autoStatus === 'saving' ? 'Salvando…' : 'Alterações não salvas'}
            </Badge>
          ) : (
            <Badge tone="success">
              {autoStatus === 'saved' ? 'Salvo automaticamente' : 'Salvo'}
            </Badge>
          )}
        </span>

        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <div
          role="radiogroup"
          aria-label="Modo de edição"
          className="flex items-center rounded-lg border border-border bg-surface p-0.5 text-xs"
        >
          {(
            [
              [
                'free',
                'Livre',
                'Compor livremente: arrastar, esticar e posicionar componentes, como no Figma. É o mesmo documento do modo HTML',
              ],
              ['html', 'HTML', 'Reordenar os componentes no fluxo da tela (o mesmo documento)'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              title={hint}
              disabled={!ready || freeBusy}
              onClick={() => void switchMode(value)}
              className={cn(
                'rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-60',
                mode === value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
              )}
            >
              {value === 'free' && freeBusy ? 'Preparando…' : label}
            </button>
          ))}
        </div>
        {mode === 'free' && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Recriar a partir do HTML"
              title="Recriar a composição livre a partir do último HTML (descarta o layout livre atual)"
              disabled={!ready || freeBusy}
              onClick={() => setFreeConfirm('recreate')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Descartar modo livre"
              title="Descartar o modo livre (volta para o último HTML)"
              disabled={!ready || freeBusy}
              onClick={() => setFreeConfirm('discard')}
            >
              <ImageOff className="h-4 w-4" />
            </Button>
          </>
        )}

        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <div className="contents">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Desfazer"
            title="Desfazer (Ctrl+Z)"
            disabled={!editor.canUndo}
            onClick={() => adapter?.run('undo')}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refazer"
            title="Refazer (Ctrl+Shift+Z)"
            disabled={!editor.canRedo}
            onClick={() => adapter?.run('redo')}
          >
            <Redo2 className="h-4 w-4" />
          </Button>

          <span className="mx-1 h-6 w-px bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Diminuir zoom"
            disabled={!ready}
            onClick={() => zoomBy(-1)}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span
            className="w-10 text-center text-xs tabular-nums text-muted"
            aria-label="Zoom atual"
          >
            {zoom}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Aumentar zoom"
            disabled={!ready}
            onClick={() => zoomBy(1)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Ajustar à tela"
            title="Ajustar à tela"
            disabled={!ready}
            onClick={() => adapter && applyZoom(adapter.fitZoom())}
          >
            <Maximize className="h-4 w-4" />
          </Button>
        </div>

        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <div
          className="flex items-center gap-1 text-xs text-muted"
          title="Tamanho fixo da tela, em pixels"
        >
          <Input
            aria-label="Largura da tela"
            type="number"
            className="h-8 w-20 rounded-lg px-2 text-xs"
            value={sizeDraft.width}
            disabled={!ready}
            onChange={(e) => setSizeDraft((s) => ({ ...s, width: e.target.value }))}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          ×
          <Input
            aria-label="Altura da tela"
            type="number"
            className="h-8 w-20 rounded-lg px-2 text-xs"
            value={sizeDraft.height}
            disabled={!ready}
            onChange={(e) => setSizeDraft((s) => ({ ...s, height: e.target.value }))}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Select
              aria-label="Teste vinculado"
              className="h-8 w-52 rounded-lg px-2 text-xs"
              value={detail?.sessionId ?? ''}
              disabled={!detail}
              onChange={(e) => void linkSession(e.target.value)}
            >
              <option value="">Sem teste vinculado</option>
              {detail?.sessionId && !sessions.some((s) => s.id === detail.sessionId) && (
                <option value={detail.sessionId}>{detail.sessionName ?? 'Teste vinculado'}</option>
              )}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            {detail?.sessionId && (
              <Link
                to={`/tests/${detail.sessionId}`}
                aria-label="Abrir o teste vinculado"
                title="Abrir o teste vinculado"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            )}
          </div>
          {detail && (
            <VersionsMenu
              versions={detail.versions}
              currentId={detail.versionId}
              onOpen={(version) => setPending({ version, action: 'open' })}
              onRestore={(version) => setPending({ version, action: 'restore' })}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!ready}
            aria-pressed={rightTab === 'ai'}
            onClick={() => setRightTab('ai')}
          >
            <Sparkles className="h-4 w-4" /> Pedir à IA
          </Button>
          {detail && (
            <span ref={renderWrap} onClickCapture={onRenderClickCapture}>
              <RenderImageButton prototype={detail} size="sm" variant="secondary" />
            </span>
          )}
          {detail && (
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={!ready}
                onClick={() => void openSend()}
              >
                <Send className="h-4 w-4" /> Enviar ao documento
              </Button>
              {detail.sentTo.length > 0 && (
                <span className="text-xs text-muted" aria-label="Envios ao documento">
                  Enviado ({detail.sentTo.length}):{' '}
                  {detail.sentTo.map((s, i) => (
                    <span key={`${s.sessionId}-${s.stepId}`}>
                      {i > 0 && ', '}
                      <Link
                        className="text-accent-text hover:underline"
                        to={`/tests/${s.sessionId}#step-${s.stepId}`}
                      >
                        passo em {sessions.find((x) => x.id === s.sessionId)?.name ?? 'teste'}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
          {detail && detail.kind !== 'template' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!ready}
              onClick={() => void openTemplate()}
            >
              <BookmarkPlus className="h-4 w-4" /> Salvar como modelo
            </Button>
          )}
          <div className="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Atalhos do teclado"
              aria-expanded={showKeys}
              onClick={() => setShowKeys((v) => !v)}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            {showKeys && (
              <dl className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-border bg-bg-elevated p-3 text-xs shadow-xl">
                {SHORTCUTS[mode].map(([keys, label]) => (
                  <div key={keys} className="flex justify-between gap-3 py-0.5">
                    <dt className="font-mono text-muted">{keys}</dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <Button
            size="sm"
            loading={saving}
            disabled={!ready || !dirty}
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" /> Salvar
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left: blocks + layers */}
        <aside
          className={cn(
            'proto-panel flex w-64 shrink-0 flex-col border-r border-border bg-surface',
          )}
          aria-label="Blocos e camadas"
        >
          <PanelTabs<LeftTab>
            value={leftTab}
            onChange={setLeftTab}
            items={[
              { value: 'blocks', label: 'Blocos', icon: Boxes },
              { value: 'layers', label: 'Camadas', icon: Layers },
            ]}
          />
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div className={cn(leftTab !== 'blocks' && 'hidden')}>
              <div ref={blocksRef} />
              <UserBlocksList
                blocks={userBlocks}
                onInsert={(b) =>
                  adapter?.insertBlock(
                    isFavorite(b) ? { html: b.html, css: b.css, scope: b.id } : b,
                  )
                }
                onRename={renameBlock}
                onDelete={(b) =>
                  deleteBlock.mutate(b.id, {
                    onError: (err) => notify.error(errorMessage(err)),
                  })
                }
              />
            </div>
            <div ref={layersRef} className={cn(leftTab !== 'layers' && 'hidden')} />
          </div>
        </aside>

        {/* canvas */}
        <div className="proto-editor relative min-w-0 flex-1 bg-surface-2">
          <div ref={canvasRef} className="absolute inset-0" />
          {freeBusy && (
            <p className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-2/80 text-sm text-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Preparando o modo livre…
            </p>
          )}
          {(isLoading || (!adapter && !engineError)) && (
            <p className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-2/80 text-sm text-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Carregando editor…
            </p>
          )}
          {(error || engineError) && (
            <p
              role="alert"
              className="absolute inset-0 z-10 flex items-center justify-center bg-surface-2 px-6 text-center text-sm text-danger"
            >
              {error
                ? `Não foi possível carregar o protótipo: ${errorMessage(error)}`
                : `Não foi possível carregar o editor: ${engineError}`}
            </p>
          )}
        </div>

        {/* right: style + properties */}
        <aside
          className={cn(
            'proto-panel flex shrink-0 flex-col border-l border-border bg-surface',
            rightTab === 'ai' ? 'w-96' : 'w-72',
          )}
          aria-label="Estilo e propriedades"
        >
          {/* two rows: the selection name keeps the full width, the actions sit below it */}
          <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-2">
            <span
              className="truncate px-1 text-xs text-muted"
              aria-live="polite"
              title={editor.selection ?? undefined}
            >
              {editor.selection ? `Selecionado: ${editor.selection}` : 'Nada selecionado'}
            </span>
            <div className="flex items-center justify-between gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Selecionar elemento pai"
                title="Selecionar o elemento pai"
                disabled={!editor.selection}
                onClick={() => adapter?.run('select-parent')}
              >
                <CornerLeftUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Mover para cima"
                title={mode === 'free' ? 'Trazer para frente (Ctrl+↑)' : 'Mover para cima (Ctrl+↑)'}
                disabled={!editor.selection}
                onClick={() => adapter?.run('move-up')}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Mover para baixo"
                title={mode === 'free' ? 'Enviar para trás (Ctrl+↓)' : 'Mover para baixo (Ctrl+↓)'}
                disabled={!editor.selection}
                onClick={() => adapter?.run('move-down')}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Restaurar posição"
                title="Restaurar posição: desfaz o deslocamento livre (Alt + arrastar / setas)"
                disabled={!editor.selectionOffset}
                onClick={() => adapter?.run('reset-offset')}
              >
                <LocateFixed className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Duplicar elemento"
                title="Duplicar (Ctrl+D)"
                disabled={!editor.selection}
                onClick={() => adapter?.run('duplicate')}
              >
                <CopyPlus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Favoritar na paleta"
                title="Favoritar na paleta: guarda o componente (categoria e-Cidade) para reutilizar em qualquer protótipo"
                disabled={!editor.selectionKind}
                onClick={favoriteSelection}
              >
                <Star className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Salvar como bloco"
                title="Salvar em Meus blocos"
                disabled={!editor.selection}
                onClick={openSaveBlock}
              >
                <PackagePlus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Excluir elemento"
                title="Excluir (Delete)"
                disabled={!editor.selection}
                onClick={() => adapter?.run('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {mode === 'free' && (
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Agrupar"
                  title="Agrupar (Ctrl+G)"
                  disabled={!editor.canGroup}
                  onClick={() => adapter?.run('group')}
                >
                  <Group className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Desagrupar"
                  title="Desagrupar (Ctrl+Shift+G)"
                  disabled={!editor.canUngroup}
                  onClick={() => adapter?.run('ungroup')}
                >
                  <Ungroup className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
          <PanelTabs<RightTab>
            value={rightTab}
            onChange={setRightTab}
            items={[
              { value: 'style', label: 'Estilo', icon: Palette },
              { value: 'traits', label: 'Propriedades', icon: SlidersHorizontal },
              { value: 'ai', label: 'IA', icon: Sparkles },
            ]}
          />
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {!editor.selection && rightTab !== 'ai' && (
              <p className="px-4 py-6 text-center text-xs text-muted">
                Clique em um elemento da tela para editar seu estilo e suas propriedades. Arraste
                blocos da paleta para montar a tela.
              </p>
            )}
            <div
              ref={stylesRef}
              className={cn((rightTab !== 'style' || !editor.selection) && 'hidden')}
            />
            <div
              ref={traitsRef}
              className={cn((rightTab !== 'traits' || !editor.selection) && 'hidden')}
            />
            {detail && (
              <div className={cn(rightTab !== 'ai' && 'hidden')}>
                <PrototypeAssistantPanel
                  prototypeId={detail.id}
                  getSnapshot={() => ({
                    ...(adapter?.getSnapshot() ?? { html: '', css: '' }),
                    width: size.width,
                    height: size.height,
                  })}
                  getSelection={() => adapter?.getSelectionPath() ?? null}
                  onApply={(change) => void applyAssistant(change)}
                />
                <p className="px-3 pb-3 text-xs text-muted">
                  Ao aplicar, uma nova versão é salva. A anterior continua no menu Versões.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* dialogs */}
      {freeConfirm && (
        <Dialog
          open
          onClose={() => setFreeConfirm(null)}
          title={
            freeConfirm === 'recreate' ? 'Recriar a partir do HTML?' : 'Descartar o modo livre?'
          }
          description={
            freeConfirm === 'recreate'
              ? 'O layout livre atual é descartado e refeito a partir da última versão em HTML puro. As alterações não salvas serão perdidas; as versões anteriores continuam no menu Versões.'
              : 'A tela volta para a última versão em HTML puro (aberta como rascunho, se não for a atual). O layout livre continua nas versões anteriores (menu Versões).'
          }
          footer={
            <>
              <Button variant="ghost" onClick={() => setFreeConfirm(null)}>
                Cancelar
              </Button>
              <Button
                variant={freeConfirm === 'discard' ? 'danger' : 'primary'}
                onClick={confirmFree}
              >
                {freeConfirm === 'recreate' ? 'Recriar layout' : 'Descartar'}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
      {pending && (
        <Dialog
          open
          onClose={() => setPending(null)}
          title={pending.action === 'restore' ? 'Restaurar versão?' : 'Abrir versão?'}
          description={`Versão de ${formatTime(pending.version.createdAt)}${pending.version.note ? ` — ${pending.version.note}` : ''}`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void confirmVersion()}>
                {pending.action === 'restore' ? 'Restaurar versão' : 'Abrir versão'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            {pending.action === 'restore'
              ? 'A versão escolhida vira a versão atual (uma nova versão é criada) e as alterações não salvas serão perdidas.'
              : 'O conteúdo da versão é carregado no editor como rascunho: nada é gravado até você salvar. As alterações não salvas atuais serão perdidas.'}
          </p>
        </Dialog>
      )}
      {sendOpen && detail && (
        <SendToDocumentDialog prototype={detail} onDone={() => setSendOpen(false)} />
      )}
      {blockDraft && (
        <SaveBlockDialog
          defaultName={blockDraft.label}
          saving={saveBlock.isPending}
          error={blockError}
          onSave={(n) => void submitBlock(n)}
          onClose={() => setBlockDraft(null)}
        />
      )}
      {duplicate && (
        <DuplicateFavoriteDialog
          existing={duplicate.existing}
          saving={saveBlock.isPending || deleteBlock.isPending}
          onReplace={() => void storeFavorite(duplicate.block, duplicate.existing)}
          onKeepBoth={() => void storeFavorite(duplicate.block)}
          onClose={() => setDuplicate(null)}
        />
      )}
      {templateOpen && (
        <Dialog
          open
          onClose={() => setTemplateOpen(false)}
          title="Salvar como modelo"
          description="Guarda uma cópia desta versão para começar novos protótipos a partir dela. Mudanças futuras neste protótipo não alteram o modelo."
          footer={
            <>
              <Button variant="ghost" onClick={() => setTemplateOpen(false)}>
                Cancelar
              </Button>
              <Button loading={saveAsTemplate.isPending} onClick={() => void submitTemplate()}>
                Salvar modelo
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitTemplate();
            }}
          >
            <Field label="Nome do modelo" htmlFor="template-name">
              <Input
                id="template-name"
                value={templateName}
                maxLength={120}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </Field>
          </form>
        </Dialog>
      )}
      {blocker.state === 'blocked' && (
        <Dialog
          open
          onClose={() => blocker.reset()}
          title="Sair sem salvar?"
          description="Este protótipo tem alterações que ainda não foram salvas."
          footer={
            <>
              <Button variant="ghost" onClick={() => blocker.reset()}>
                Continuar editando
              </Button>
              <Button variant="danger" onClick={() => blocker.proceed()}>
                Sair sem salvar
              </Button>
              <Button
                onClick={() => void save().then((ok) => (ok ? blocker.proceed() : blocker.reset()))}
              >
                Salvar e sair
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            Se sair agora, as alterações feitas desde o último salvamento serão perdidas.
          </p>
        </Dialog>
      )}
    </div>
  );
}
