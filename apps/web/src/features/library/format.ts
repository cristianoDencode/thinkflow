import {
  LIBRARY_ACCEPT,
  LIBRARY_LIMITS,
  NOTEBOOKLM_PLANS,
  notebookLmPlanForTier,
  type LibraryDocumentDto,
  type LibraryDocumentKind,
  type LibraryExtractionMethod,
  type LibraryRemoteStatus,
  type NotebookLmDetectionDto,
} from '@thinkflow/shared';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text =
    value >= 10 || Number.isInteger(value) ? Math.round(value).toString() : value.toFixed(1);
  return `${text.replace('.', ',')} ${units[i]}`;
}

export const KIND_LABELS: Record<LibraryDocumentKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  markdown: 'Markdown',
  text: 'Texto',
  image: 'Imagem',
};

export const EXTRACTION_LABELS: Record<LibraryExtractionMethod, string> = {
  text: 'Texto',
  'ocr-local': 'OCR local',
  'ocr-vision': 'OCR IA',
};

export const REMOTE_LABELS: Record<LibraryRemoteStatus, string> = {
  pending: 'Pendente',
  syncing: 'Sincronizando',
  synced: 'Sincronizado',
  error: 'Erro',
};

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface DocumentStatusView {
  label: string;
  tone: StatusTone;
  spinner: boolean;
  /** Tooltip / detail text. */
  detail: string | null;
}

/**
 * Images fail with "OCR desativado ..." while OCR is turned off in the settings (documents indexed
 * by earlier versions may still say "Aguardando OCR"). It is a fixable state, not a real error.
 */
export function isWaitingOcr(doc: Pick<LibraryDocumentDto, 'status' | 'error'>): boolean {
  return doc.status === 'error' && /ocr desativado|aguardando ocr/i.test(doc.error ?? '');
}

export function statusView(doc: Pick<LibraryDocumentDto, 'status' | 'error'>): DocumentStatusView {
  if (doc.status === 'processing')
    return { label: 'Processando', tone: 'neutral', spinner: true, detail: null };
  if (doc.status === 'ready')
    return { label: 'Pronto', tone: 'success', spinner: false, detail: null };
  if (isWaitingOcr(doc))
    return {
      label: /desativado/i.test(doc.error ?? '') ? 'OCR desativado' : 'Aguardando OCR',
      tone: 'warning',
      spinner: false,
      detail: doc.error,
    };
  return { label: 'Erro', tone: 'danger', spinner: false, detail: doc.error };
}

export type FileCheck = { ok: true } | { ok: false; reason: string };

const ACCEPTED_EXTENSIONS = LIBRARY_ACCEPT.split(',');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx).toLowerCase();
}

/** Client-side mirror of the server checks (the server stays authoritative). */
export function checkFile(file: { name: string; size: number }): FileCheck {
  const ext = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext))
    return { ok: false, reason: 'Tipo de arquivo não suportado' };
  if (file.size === 0) return { ok: false, reason: 'Arquivo vazio' };
  if (file.size > LIBRARY_LIMITS.maxFileBytes)
    return { ok: false, reason: 'Arquivo maior que 20 MB' };
  if (IMAGE_EXTENSIONS.has(ext) && file.size > LIBRARY_LIMITS.maxImageBytes)
    return { ok: false, reason: 'Imagem maior que 10 MB' };
  return { ok: true };
}

export interface SplitFiles {
  accepted: File[];
  rejected: { name: string; reason: string }[];
}

/** Splits dropped files into uploadable ones and rejected ones (type, size, free slots). */
export function splitFiles(files: File[], freeSlots: number, maxDocuments: number): SplitFiles {
  const accepted: File[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const file of files) {
    const check = checkFile(file);
    if (!check.ok) rejected.push({ name: file.name, reason: check.reason });
    else if (accepted.length >= freeSlots)
      rejected.push({
        name: file.name,
        reason: `Limite de ${maxDocuments} documentos por biblioteca`,
      });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** 'DD/MM HH:mm' (local time). */
export function formatShortDateTime(timestamp: number): string {
  const d = new Date(timestamp);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "Detectado: Pro — 300 fontes por notebook, 500 consultas/dia (em 13/11 14:05)", or null. */
export function describeDetection(detection: NotebookLmDetectionDto): string | null {
  if (detection.at === null) return null;
  const plan = notebookLmPlanForTier(detection.tier);
  const parts = [
    detection.sourceLimit !== null ? `${detection.sourceLimit} fontes por notebook` : null,
    plan ? `${NOTEBOOKLM_PLANS[plan].chatsPerDay} consultas/dia` : null,
  ].filter((p): p is string => p !== null);
  const limits = parts.join(', ');
  const what = detection.planLabel
    ? limits
      ? `${detection.planLabel} — ${limits}`
      : detection.planLabel
    : limits || 'limites da conta';
  return `Detectado: ${what} (em ${formatShortDateTime(detection.at)})`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
