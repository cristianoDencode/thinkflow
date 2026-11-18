import { stepTitle } from '@thinkflow/shared';
import type { TestAnnotation, TestSessionDto, TestStepImageDto } from '@thinkflow/shared';
import Konva from 'konva';
import {
  ArrowUpRight,
  Check,
  Circle as CircleIcon,
  Copy,
  Download,
  EyeOff,
  Hash,
  Highlighter,
  Minus,
  MousePointer2,
  PanelRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
} from 'react-konva';
import { Button } from '../../components/ui/button';
import { Field, Switch, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { cn } from '../../lib/utils';
import { useSessionAction } from './use-session-action';

export type Tool =
  | 'select'
  | 'pen'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'highlight'
  | 'text'
  | 'badge'
  | 'pixelate';

const COLORS = ['#ef4444', '#f59e0b', '#2563eb', '#16a34a', '#111827', '#ffffff'];
const DEFAULT_SIZE = 4;
const MAX_SIZE = 20;
const PANEL_W = 320;
const ACCENT = '#a855f7';
/** 2 numbers per point: a freehand stroke keeps at most 2.000 points (schema limit). */
const MAX_PEN_NUMBERS = 4000;

const TOOLS: { tool: Tool; label: string; key: string; icon: ReactNode }[] = [
  {
    tool: 'select',
    label: 'Selecionar e mover',
    key: 'V',
    icon: <MousePointer2 className="h-4 w-4" />,
  },
  { tool: 'pen', label: 'Lápis', key: 'P', icon: <Pencil className="h-4 w-4" /> },
  { tool: 'line', label: 'Linha', key: 'L', icon: <Minus className="h-4 w-4" /> },
  { tool: 'arrow', label: 'Seta', key: 'A', icon: <ArrowUpRight className="h-4 w-4" /> },
  { tool: 'rect', label: 'Retângulo', key: 'R', icon: <Square className="h-4 w-4" /> },
  { tool: 'ellipse', label: 'Elipse', key: 'E', icon: <CircleIcon className="h-4 w-4" /> },
  { tool: 'highlight', label: 'Destaque', key: 'M', icon: <Highlighter className="h-4 w-4" /> },
  { tool: 'text', label: 'Texto', key: 'T', icon: <Type className="h-4 w-4" /> },
  { tool: 'badge', label: 'Número de passo', key: 'N', icon: <Hash className="h-4 w-4" /> },
  {
    tool: 'pixelate',
    label: 'Tarjar (borrar dado sensível)',
    key: 'X',
    icon: <EyeOff className="h-4 w-4" />,
  },
];

/** Undo/redo over the list of annotations. */
export function useHistory(initial: TestAnnotation[]) {
  const [state, setState] = useState({
    past: [] as TestAnnotation[][],
    present: initial,
    future: [] as TestAnnotation[][],
  });
  return {
    items: state.present,
    set: (next: TestAnnotation[]) =>
      setState((s) => ({ past: [...s.past, s.present].slice(-100), present: next, future: [] })),
    undo: () =>
      setState((s) =>
        s.past.length
          ? { past: s.past.slice(0, -1), present: s.past.at(-1)!, future: [s.present, ...s.future] }
          : s,
      ),
    redo: () =>
      setState((s) =>
        s.future.length
          ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1) }
          : s,
      ),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}

/** Next number for a step badge. */
export const nextBadge = (items: TestAnnotation[]) =>
  items.reduce((max, a) => (a.type === 'badge' ? Math.max(max, a.n) : max), 0) + 1;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Stroke width / text scale of a shape, in image pixels. */
const sizeOf = (a: TestAnnotation) => ('size' in a ? (a.size ?? DEFAULT_SIZE) : DEFAULT_SIZE);

/** Same shape moved by a fraction of the image. */
export function moveBy(a: TestAnnotation, dx: number, dy: number): TestAnnotation {
  switch (a.type) {
    case 'arrow':
    case 'line':
      return {
        ...a,
        points: [a.points[0] + dx, a.points[1] + dy, a.points[2] + dx, a.points[3] + dy],
      };
    case 'pen':
      return { ...a, points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

/** Same shape with another color and/or size (the tarja has neither; the highlight has no size). */
function restyle(a: TestAnnotation, patch: { color?: string; size?: number }): TestAnnotation {
  if (a.type === 'pixelate') return a;
  if (a.type === 'highlight') return patch.color ? { ...a, color: patch.color } : a;
  return { ...a, ...patch };
}

/** Normalizes a drag (any direction) into x/y/w/h fractions. */
const box = (x1: number, y1: number, x2: number, y2: number) => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});

function useHtmlImage(src: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const image = new window.Image();
    image.onload = () => setImg(image);
    image.onerror = () => setFailed(true);
    image.src = src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [src]);
  return { img, failed };
}

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

/** Position and size of an element on screen, refreshed when it (or `deps`) change. */
function useRect(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height },
      );
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return rect;
}

function Pixelated({
  img,
  a,
  w,
  h,
}: {
  img: HTMLImageElement;
  a: Extract<TestAnnotation, { type: 'pixelate' }>;
  w: number;
  h: number;
}) {
  const ref = useRef<Konva.Image>(null);
  const scaleX = img.naturalWidth / w;
  const scaleY = img.naturalHeight / h;
  useEffect(() => {
    const node = ref.current;
    if (!node || a.w <= 0 || a.h <= 0) return;
    node.cache();
    node.getLayer()?.batchDraw();
  }, [a.x, a.y, a.w, a.h, img, w, h]);
  return (
    <KImage
      ref={ref}
      image={img}
      x={a.x * w}
      y={a.y * h}
      width={Math.max(1, a.w * w)}
      height={Math.max(1, a.h * h)}
      crop={{
        x: a.x * w * scaleX,
        y: a.y * h * scaleY,
        width: Math.max(1, a.w * w * scaleX),
        height: Math.max(1, a.h * h * scaleY),
      }}
      filters={[Konva.Filters.Pixelate]}
      pixelSize={12}
    />
  );
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/**
 * Full-screen screenshot editor (always the whole browser screen): draw with the toolbar under the
 * image; the shapes stay editable (fractions of the original image) and the saved PNG is flattened.
 */
export function AnnotationEditor({
  session,
  evidence,
  onClose,
}: {
  session: TestSessionDto;
  evidence: TestStepImageDto;
  onClose(): void;
}) {
  const { img, failed } = useHtmlImage(evidence.originalUrl);
  const history = useHistory(evidence.annotations);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0]!);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [comment, setComment] = useState(evidence.comment);
  const [include, setInclude] = useState(evidence.include);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<TestAnnotation | null>(null);
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string } | null>(null);
  const vp = useViewport();
  const [panel, setPanel] = useState(() => window.innerWidth >= 1024);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Where a text box opens on mouse up (opening it on mouse down loses the focus right away). */
  const pendingText = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const { busy, run } = useSessionAction(session.id);

  // the screenshot fits the screen (never upscaled); shapes are stored as fractions of it
  const panelW = panel ? Math.min(PANEL_W, vp.w) : 0;
  const scale = Math.min(
    1,
    Math.max(0.05, (vp.w - panelW - 48) / evidence.width),
    Math.max(0.05, (vp.h - 120) / evidence.height),
  );
  const width = Math.max(1, Math.round(evidence.width * scale));
  const height = Math.max(1, Math.round(evidence.height * scale));
  /** display px per image px */
  const k = width / evidence.width;
  const items = history.items;
  const shown = useMemo(() => (draft ? [...items, draft] : items), [items, draft]);
  // the print belongs to a step: that is what it documents
  const step = session.definition.steps.find((s) => s.id === evidence.stepId) ?? null;
  const stepNumber = step ? session.definition.steps.indexOf(step) + 1 : evidence.seq;

  const wrap = useRect(wrapRef, [width, height, panel]);
  const bar = useRect(toolbarRef, [panel, tool]);

  const dirty =
    JSON.stringify(items) !== JSON.stringify(evidence.annotations) ||
    comment !== evidence.comment ||
    include !== evidence.include;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const editingText = textEdit !== null;
  useEffect(() => {
    if (editingText) textRef.current?.focus();
  }, [editingText]);

  const close = () => {
    if (dirty && !window.confirm('Descartar as alterações deste print?')) return;
    onClose();
  };

  const pointer = () => {
    const p = stageRef.current?.getPointerPosition();
    return p ? { x: p.x / width, y: p.y / height } : null;
  };

  const updateSelected = (patch: { color?: string; size?: number }) => {
    if (selected === null) return;
    history.set(items.map((a, i) => (i === selected ? restyle(a, patch) : a)));
  };
  const pickColor = (c: string) => {
    setColor(c);
    updateSelected({ color: c });
  };
  const changeSize = (next: number) => {
    const n = clamp(Math.round(next), 1, MAX_SIZE);
    setSize(n);
    updateSelected({ size: n });
  };
  const pickTool = (t: Tool) => {
    setTool(t);
    setSelected(null);
  };
  const removeSelected = () => {
    if (selected === null) return;
    history.set(items.filter((_, i) => i !== selected));
    setSelected(null);
  };

  const commitText = () => {
    if (!textEdit) return;
    const value = textEdit.value.trim().slice(0, 500);
    if (value) {
      history.set([
        ...items,
        { type: 'text', x: textEdit.x, y: textEdit.y, text: value, color, size },
      ]);
    }
    setTextEdit(null);
  };

  const onDown = (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (textEdit) return; // the click blurs the text box, which commits it
    const p = pointer();
    if (!p) return;
    if (tool === 'select') {
      if (!e?.target?.findAncestor?.('.shape', true)) setSelected(null);
      return;
    }
    if (tool === 'badge') {
      history.set([...items, { type: 'badge', x: p.x, y: p.y, n: nextBadge(items), color, size }]);
      return;
    }
    if (tool === 'text') {
      pendingText.current = p;
      return;
    }
    start.current = p;
    if (tool === 'pen') setDraft({ type: 'pen', points: [p.x, p.y], color, size });
  };

  const onMove = () => {
    const s = start.current;
    if (!s) return;
    const p = pointer();
    if (!p) return;
    if (tool === 'pen') {
      setDraft((d) => {
        if (!d || d.type !== 'pen' || d.points.length >= MAX_PEN_NUMBERS) return d;
        const lx = d.points[d.points.length - 2]!;
        const ly = d.points[d.points.length - 1]!;
        if (Math.hypot((p.x - lx) * width, (p.y - ly) * height) < 2) return d;
        return { ...d, points: [...d.points, p.x, p.y] };
      });
    } else if (tool === 'arrow' || tool === 'line')
      setDraft({ type: tool, points: [s.x, s.y, p.x, p.y], color, size });
    else if (tool === 'rect' || tool === 'ellipse')
      setDraft({ type: tool, ...box(s.x, s.y, p.x, p.y), color, size });
    else if (tool === 'highlight')
      setDraft({ type: 'highlight', ...box(s.x, s.y, p.x, p.y), color });
    else if (tool === 'pixelate') setDraft({ type: 'pixelate', ...box(s.x, s.y, p.x, p.y) });
  };

  const onUp = () => {
    start.current = null;
    const at = pendingText.current;
    pendingText.current = null;
    if (at) {
      setTextEdit({ x: at.x, y: at.y, value: '' });
      return;
    }
    if (!draft) return;
    let done: TestAnnotation | null = draft;
    if (draft.type === 'pen') {
      // a click without movement is a dot
      if (draft.points.length < 4) {
        done = { ...draft, points: [...draft.points, draft.points[0]! + 0.0005, draft.points[1]!] };
      }
    } else if (draft.type === 'arrow' || draft.type === 'line') {
      const [x1, y1, x2, y2] = draft.points;
      if (Math.hypot((x2 - x1) * width, (y2 - y1) * height) < 6) done = null;
    } else if ('w' in draft && (draft.w * width < 4 || draft.h * height < 4)) {
      done = null;
    }
    if (done) history.set([...items, done]);
    setDraft(null);
  };

  /**
   * Commits a text still being typed and clears the selection highlight, synchronously (the canvas
   * is exported right after). Returns the final list of shapes.
   */
  const finalize = (): TestAnnotation[] => {
    let next = items;
    const value = textEdit?.value.trim().slice(0, 500);
    if (textEdit && value) {
      next = [...items, { type: 'text', x: textEdit.x, y: textEdit.y, text: value, color, size }];
    }
    flushSync(() => {
      if (next !== items) history.set(next);
      setTextEdit(null);
      setSelected(null);
    });
    return next;
  };

  /** The picture as it will be saved: the whole screenshot at its own resolution. */
  const renderBlob = async (): Promise<Blob | null> => {
    const stage = stageRef.current;
    if (!stage) return null;
    return (await stage.toBlob({
      pixelRatio: evidence.width / width,
      mimeType: 'image/png',
    })) as Blob | null;
  };

  const copy = async () => {
    try {
      finalize();
      const blob = await renderBlob();
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify.success('Imagem copiada para a área de transferência');
    } catch (err) {
      notify.error(`Não foi possível copiar a imagem: ${errorMessage(err)}`);
    }
  };

  const download = async () => {
    finalize();
    const blob = await renderBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `passo-${stepNumber}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const save = async () => {
    const annotations = finalize();
    const form = new FormData();
    // always the whole screen: an area selected by an earlier version is dropped
    form.append('data', JSON.stringify({ annotations, crop: null, comment, include }));
    if (annotations.length > 0) {
      const blob = await renderBlob();
      if (blob) form.append('image', blob, 'annotated.png');
    }
    const ok = await run(
      'save',
      () => api.put(`/api/tests/sessions/${session.id}/evidences/${evidence.id}/annotated`, form),
      'Print salvo',
    );
    if (ok) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (selected !== null) setSelected(null);
        else close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        history.redo();
      } else if (mod && key === 'c' && !e.shiftKey) {
        e.preventDefault();
        void copy();
      } else if (mod && key === 's' && !e.shiftKey) {
        e.preventDefault();
        void download();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === ' ') {
        e.preventDefault();
        setPanel((p) => !p);
      } else if (!mod && !e.altKey) {
        const match = TOOLS.find((t) => t.key.toLowerCase() === key);
        if (match) pickTool(match.tool);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const common = (index: number, onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void) => ({
    name: 'shape',
    draggable: tool === 'select',
    onClick: () => tool === 'select' && setSelected(index),
    onTap: () => tool === 'select' && setSelected(index),
    onDragEnd:
      onDragEnd ??
      ((e: Konva.KonvaEventObject<DragEvent>) => {
        const node = e.target;
        const dx = node.x() / width;
        const dy = node.y() / height;
        node.position({ x: 0, y: 0 });
        history.set(items.map((a, i) => (i === index ? moveBy(a, dx, dy) : a)));
      }),
  });

  const toPx = (pts: number[]) => pts.map((v, i) => v * (i % 2 === 0 ? width : height));

  const renderShape = (a: TestAnnotation, index: number) => {
    const isSelected = index === selected;
    const stroke = isSelected ? ACCENT : undefined;
    const sw = Math.max(1, sizeOf(a) * k);
    switch (a.type) {
      case 'rect':
        return (
          <Group key={index} {...common(index)}>
            <Rect
              x={a.x * width}
              y={a.y * height}
              width={a.w * width}
              height={a.h * height}
              stroke={stroke ?? a.color}
              strokeWidth={sw}
              cornerRadius={2 * k}
            />
          </Group>
        );
      case 'ellipse':
        return (
          <Group key={index} {...common(index)}>
            <Ellipse
              x={(a.x + a.w / 2) * width}
              y={(a.y + a.h / 2) * height}
              radiusX={(a.w * width) / 2}
              radiusY={(a.h * height) / 2}
              stroke={stroke ?? a.color}
              strokeWidth={sw}
            />
          </Group>
        );
      case 'highlight':
        return (
          <Group key={index} {...common(index)}>
            <Rect
              x={a.x * width}
              y={a.y * height}
              width={a.w * width}
              height={a.h * height}
              fill={a.color}
              opacity={0.3}
              stroke={stroke}
            />
          </Group>
        );
      case 'pixelate':
        return img ? (
          <Group key={index} {...common(index)}>
            <Pixelated img={img} a={a} w={width} h={height} />
            {isSelected && (
              <Rect
                x={a.x * width}
                y={a.y * height}
                width={a.w * width}
                height={a.h * height}
                stroke={stroke}
              />
            )}
          </Group>
        ) : null;
      case 'arrow':
        return (
          <Group key={index} {...common(index)}>
            <Arrow
              points={toPx(a.points)}
              stroke={stroke ?? a.color}
              fill={stroke ?? a.color}
              strokeWidth={sw}
              pointerLength={Math.max(8, sw * 3.5)}
              pointerWidth={Math.max(8, sw * 3.5)}
              lineCap="round"
              hitStrokeWidth={Math.max(12, sw)}
            />
          </Group>
        );
      case 'line':
      case 'pen':
        return (
          <Group key={index} {...common(index)}>
            <Line
              points={toPx(a.points)}
              stroke={stroke ?? a.color}
              strokeWidth={sw}
              lineCap="round"
              lineJoin="round"
              tension={a.type === 'pen' ? 0.4 : 0}
              hitStrokeWidth={Math.max(12, sw)}
            />
          </Group>
        );
      case 'badge': {
        const r = (6 + sizeOf(a) * 2) * k;
        return (
          <Group
            key={index}
            x={a.x * width}
            y={a.y * height}
            {...common(index, (e) => {
              const node = e.target;
              const dx = node.x() / width - a.x;
              const dy = node.y() / height - a.y;
              node.position({ x: a.x * width, y: a.y * height });
              history.set(items.map((b, i) => (i === index ? moveBy(b, dx, dy) : b)));
            })}
          >
            <Circle radius={r} fill={a.color} stroke={stroke ?? '#ffffff'} strokeWidth={2} />
            <Text
              text={String(a.n)}
              fontSize={r * 1.05}
              fontStyle="bold"
              fill={a.color.toLowerCase() === '#ffffff' ? '#111827' : '#ffffff'}
              width={r * 2}
              height={r * 2}
              offsetX={r}
              offsetY={r}
              align="center"
              verticalAlign="middle"
            />
          </Group>
        );
      }
      case 'text':
        return (
          <Group key={index} {...common(index)}>
            <Text
              x={a.x * width}
              y={a.y * height}
              text={a.text}
              fontSize={(8 + sizeOf(a) * 3) * k}
              fontStyle="bold"
              fill={a.color}
              // only the chosen color (no outline); a glow marks the selected text in the editor
              shadowColor={isSelected ? ACCENT : undefined}
              shadowBlur={isSelected ? 8 : 0}
              shadowOpacity={isSelected ? 1 : 0}
            />
          </Group>
        );
    }
  };

  // toolbar: under the image, else inside its bottom edge (screen coordinates)
  const barStyle = (() => {
    if (!wrap) return { left: 8, top: 8 };
    const bw = bar?.width ?? 640;
    const bh = bar?.height ?? 44;
    const bottom = wrap.top + height;
    let top = bottom + 10;
    if (top + bh > vp.h - 8) top = Math.max(8, bottom - bh - 10);
    const maxLeft = Math.max(8, vp.w - panelW - bw - 8);
    const left = clamp(wrap.left + width / 2 - bw / 2, 8, maxLeft);
    return { left, top };
  })();

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Print do passo ${stepNumber}`}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex bg-neutral-950 text-white outline-none"
    >
      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6">
        {failed ? (
          <p className="text-sm text-red-300">Não foi possível carregar o print.</p>
        ) : (
          <div ref={wrapRef} className="relative shadow-2xl" style={{ width, height }}>
            <Stage
              ref={stageRef}
              width={width}
              height={height}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={onUp}
              onTouchStart={onDown}
              onTouchMove={onMove}
              onTouchEnd={onUp}
              onWheel={(e) => {
                e.evt.preventDefault();
                changeSize(size + (e.evt.deltaY < 0 ? 1 : -1));
              }}
              style={{
                cursor: tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair',
              }}
            >
              <Layer listening={false}>
                {img && <KImage image={img} width={width} height={height} />}
              </Layer>
              <Layer>{shown.map(renderShape)}</Layer>
            </Stage>

            {textEdit && (
              <textarea
                ref={textRef}
                autoFocus
                aria-label="Texto da anotação"
                placeholder="Digite e tecle Enter"
                rows={1}
                value={textEdit.value}
                maxLength={500}
                onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setTextEdit(null);
                  } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitText();
                  }
                }}
                className="absolute min-w-40 resize border border-dashed bg-black/20 px-1 font-bold outline-none"
                style={{
                  left: textEdit.x * width,
                  top: textEdit.y * height,
                  color,
                  borderColor: ACCENT,
                  fontSize: (8 + size * 3) * k,
                  lineHeight: 1.1,
                }}
              />
            )}
          </div>
        )}
      </div>

      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Ferramentas de anotação"
        className="fixed z-[61] flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-neutral-900/95 p-1.5 text-white shadow-2xl"
        style={{ ...barStyle, maxWidth: `calc(100vw - ${panelW + 16}px)` }}
      >
        {TOOLS.map((t) => (
          <ToolButton
            key={t.tool}
            label={t.label}
            shortcut={t.key}
            active={tool === t.tool}
            onClick={() => pickTool(t.tool)}
          >
            {t.icon}
          </ToolButton>
        ))}
        <Divider />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Cor ${c}`}
            aria-pressed={color === c}
            title={`Cor ${c}`}
            onClick={() => pickColor(c)}
            className={cn(
              'h-5 w-5 cursor-pointer rounded-full border-2',
              color === c ? 'border-white' : 'border-white/20',
            )}
            style={{ background: c }}
          />
        ))}
        <label
          className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border-2 border-white/20"
          title="Outra cor"
          style={{
            background: COLORS.includes(color)
              ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)'
              : color,
          }}
        >
          <input
            type="color"
            aria-label="Outra cor"
            value={color}
            onChange={(e) => pickColor(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <Divider />
        <label className="flex items-center gap-1.5 px-1 text-xs" title="Espessura (roda do mouse)">
          <input
            type="range"
            aria-label="Espessura"
            min={1}
            max={MAX_SIZE}
            value={size}
            onChange={(e) => changeSize(Number(e.target.value))}
            className="w-20 accent-purple-500"
          />
          <span className="w-4 text-right tabular-nums">{size}</span>
        </label>
        <Divider />
        <ToolButton
          label="Desfazer"
          shortcut="Ctrl+Z"
          disabled={!history.canUndo}
          onClick={history.undo}
        >
          <Undo2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Refazer"
          shortcut="Ctrl+Y"
          disabled={!history.canRedo}
          onClick={history.redo}
        >
          <Redo2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Remover forma selecionada"
          shortcut="Delete"
          disabled={selected === null}
          onClick={removeSelected}
        >
          <Trash2 className="h-4 w-4" />
        </ToolButton>
        <Divider />
        <ToolButton label="Copiar imagem" shortcut="Ctrl+C" onClick={() => void copy()}>
          <Copy className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Baixar PNG" shortcut="Ctrl+S" onClick={() => void download()}>
          <Download className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label={panel ? 'Ocultar detalhes' : 'Mostrar detalhes'}
          shortcut="Espaço"
          active={panel}
          onClick={() => setPanel((p) => !p)}
        >
          <PanelRight className="h-4 w-4" />
        </ToolButton>
        <Divider />
        <ToolButton label="Salvar" shortcut="Enter" onClick={() => void save()}>
          <Check className="h-4 w-4 text-green-400" />
        </ToolButton>
        <ToolButton label="Fechar" shortcut="Esc" onClick={close}>
          <X className="h-4 w-4" />
        </ToolButton>
      </div>

      {panel && (
        <aside
          className="flex shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-bg-elevated p-4 text-fg"
          style={{ width: panelW }}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">Print do passo {stepNumber}</h2>
              <p className="text-xs text-muted">
                Tela inteira · {evidence.width} × {evidence.height}
              </p>
              {step && (
                <p className="mt-1 line-clamp-2 break-words text-xs text-muted">
                  {stepTitle(session.definition, step)}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Ocultar detalhes"
              onClick={() => setPanel(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <Field
            label="Comentário"
            htmlFor="evidence-comment"
            hint="Entra no documento logo abaixo da imagem."
          >
            <Textarea
              id="evidence-comment"
              rows={4}
              maxLength={4000}
              value={comment}
              placeholder="O que este print comprova? Ex.: mensagem de validação exibida ao informar CPF inválido."
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={include} onChange={setInclude} label="Incluir no documento" />
            Incluir no documento
          </label>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Atalhos</summary>
            <ul className="mt-2 space-y-0.5">
              {TOOLS.map((t) => (
                <li key={t.tool}>
                  <kbd className="font-mono">{t.key}</kbd> {t.label}
                </li>
              ))}
              <li>Roda do mouse: espessura · Ctrl+Z / Ctrl+Y: desfazer / refazer</li>
              <li>Ctrl+C: copiar · Ctrl+S: baixar PNG · Espaço: este painel</li>
              <li>Enter: salvar · Esc: fechar</li>
            </ul>
          </details>
          <div className="mt-auto flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={close}>
              Cancelar
            </Button>
            <Button loading={busy === 'save'} onClick={() => void save()}>
              Salvar print
            </Button>
          </div>
        </aside>
      )}
    </div>
  );
}

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-35',
        active ? 'bg-purple-600 text-white' : 'text-white/85 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-0.5 h-6 w-px bg-white/15" aria-hidden />;
