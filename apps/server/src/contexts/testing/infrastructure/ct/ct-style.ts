import type { CtLayout, CtLayoutFont } from '@thinkflow/shared';
import type { CtDocument } from '../../domain/ct-document';

/*
 * A4 page measurements. Sizes are in points unless stated otherwise; the DOCX and HTML/PDF
 * renderers both read them so the formats stay aligned. Colors, texts, font and logo come from
 * the document model (`CtLayout`); the categories (sections, fields, labels) are fixed here.
 */

/** Colors that do not depend on the model (hex without `#`, as WordprocessingML wants them). */
export const CT_COLORS = {
  text: '000000',
  heading: '2B2B2B',
  labelBg: 'F2F2F2',
  tableBorder: '000000',
  rule: 'D9D9D9',
  blockBorder: 'E7E6E6',
  gray: '919191',
} as const;

export interface CtPalette {
  text: string;
  heading: string;
  labelBg: string;
  tableBorder: string;
  rule: string;
  blockBorder: string;
  gray: string;
  /** Model's primary color: kicker and section numbers. */
  blue: string;
  /** Model's accent color: use-case status. */
  green: string;
}

const hexOf = (color: string): string => color.replace(/^#/, '').toUpperCase();

/** The fixed colors plus the model's two (hex without `#`). */
export function ctPalette(layout: CtLayout): CtPalette {
  return { ...CT_COLORS, blue: hexOf(layout.primaryColor), green: hexOf(layout.accentColor) };
}

/** CSS font stack of a model font (with the Linux metric-compatible fallbacks). */
const FONT_STACKS: Record<CtLayoutFont, string> = {
  Calibri: "Calibri, Carlito, 'Liberation Sans', Arial, sans-serif",
  Arial: "Arial, 'Liberation Sans', Helvetica, sans-serif",
  Cambria: "Cambria, Caladea, Georgia, 'Liberation Serif', serif",
  Georgia: "Georgia, 'DejaVu Serif', 'Liberation Serif', serif",
  'Times New Roman': "'Times New Roman', 'Liberation Serif', Times, serif",
  Tahoma: "Tahoma, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif",
  Verdana: "Verdana, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif",
};

export const ctFontStack = (font: CtLayoutFont): string => FONT_STACKS[font];

export const CT_FONT_SIZES = {
  body: 10.5,
  label: 9.5,
  status: 10,
  kicker: 9,
  title: 18,
  h1: 12,
  h2: 10,
  useCaseTitle: 10,
  version: 9,
  header: 7,
  footer: 6.5,
  code: 9.5,
} as const;

/** Content width of the A4 page with 2 cm side margins: 17 cm. */
export const CT_CONTENT_WIDTH_PT = 481.9;
export const CT_CELL_PADDING_PT = 5.25;

/** The fixed categories of the document (section titles, field labels). */
export const CT_TEXTS = {
  s1: 'Cabeçalho',
  s2sub: 'Contexto',
  s3: 'Plano de Teste',
  s3sub: 'Critérios de Aceitação',
  versions: 'Controle de Versões do Documento',
  labels: {
    title: 'Título',
    ticketId: 'ID/Código do Chamado',
    priority: 'Prioridade',
    systemModule: 'Sistema / Módulo Afetado',
    author: 'Responsável pela Documentação',
  },
  versionHeaders: ['Versão', 'Data', 'Descrição da Alteração', 'Responsável'],
} as const;

/** Column widths of the version table, in 1/10000 of the content width. */
export const CT_VERSION_COLS = [1868, 1878, 3308, 2946] as const;

/** Section numbers: 1 Cabeçalho, 2 Análise (2.1), 3 Plano de Teste (3.1), 4 Controle de Versões. */
export const CT_SECTION_NUMBERS = {
  header: '1',
  analysis: '2',
  context: '2.1',
  plan: '3',
  criteria: '3.1',
  versions: '4',
} as const;

export function ctDocumentTitleForFile(doc: CtDocument): string {
  const base = [doc.ticketId.trim() && `CT ${doc.ticketId.trim()}`, doc.title.trim()]
    .filter(Boolean)
    .join(' - ');
  return base || 'Caso de Teste CT';
}

/** Lowercase file name stem for downloads (accents and unsafe characters removed). */
export function ctFileStem(doc: CtDocument): string {
  const stem = ctDocumentTitleForFile(doc)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return stem || 'Caso de Teste CT';
}

export type SniffedImage = { type: 'png' | 'jpg' | 'gif' | 'bmp'; mime: string };

/** Image format from the magic bytes (the renderers never trust a file extension). */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: 'png', mime: 'image/png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'jpg', mime: 'image/jpeg' };
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { type: 'gif', mime: 'image/gif' };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { type: 'bmp', mime: 'image/bmp' };
  return null;
}

export class CtImageFormatError extends Error {
  constructor(readonly key: string) {
    super(`Formato de imagem não suportado (use PNG, JPEG ou GIF): ${key}`);
    this.name = 'CtImageFormatError';
  }
}
