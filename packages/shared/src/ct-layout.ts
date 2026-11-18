import { z } from 'zod';
import { hexColorSchema, logoDataUrlSchema } from './templates';

/*
 * Look of the "Caso de Teste CT" document (a "modelo"). Only the appearance is configurable:
 * titles, header/footer, colors, font and logo. The categories of the document (sections, fields
 * and their labels) are fixed in the renderers.
 */

/** Fonts that exist in Word and have a metric-compatible fallback in the PDF browser. */
export const CT_LAYOUT_FONTS = [
  'Calibri',
  'Arial',
  'Cambria',
  'Georgia',
  'Times New Roman',
  'Tahoma',
  'Verdana',
] as const;
export type CtLayoutFont = (typeof CT_LAYOUT_FONTS)[number];

export const CT_LAYOUT_LIMITS = {
  maxTitleChars: 80,
  maxKickerChars: 80,
  maxHeaderChars: 120,
  maxFooterChars: 160,
  maxNameChars: 80,
  maxModels: 100,
} as const;

export const CT_DEFAULT_MODEL_ID = 'default';
export const CT_DEFAULT_MODEL_NAME = 'Padrão';

const text = (max: number) => z.string().trim().max(max);

export const ctLayoutSchema = z.object({
  /** Large title at the top of the document. */
  title: text(CT_LAYOUT_LIMITS.maxTitleChars)
    .min(1, 'Informe o título do documento.')
    .default('Caso de Teste'),
  /** Small line above the title (blank = none). */
  kicker: text(CT_LAYOUT_LIMITS.maxKickerChars).default('DOCUMENTAÇÃO TÉCNICA'),
  headerText: text(CT_LAYOUT_LIMITS.maxHeaderChars).default('Caso de Teste'),
  /** Text before "Página X de Y" in the footer (blank = only the page number). */
  footerText: text(CT_LAYOUT_LIMITS.maxFooterChars).default(''),
  /** Section numbers and the kicker. */
  primaryColor: hexColorSchema.default('#4A6FA5'),
  /** Use-case status text. */
  accentColor: hexColorSchema.default('#11734B'),
  fontFamily: z.enum(CT_LAYOUT_FONTS).default('Calibri'),
  /** PNG/JPEG data URL, at most 200 KB; only ever uploaded by the person. */
  logo: logoDataUrlSchema.nullable().default(null),
  logoPosition: z.enum(['left', 'right']).default('right'),
  showHeader: z.boolean().default(true),
  showFooter: z.boolean().default(true),
});
export type CtLayout = z.infer<typeof ctLayoutSchema>;
export type CtLayoutInput = z.input<typeof ctLayoutSchema>;

/** Neutral look: no logo, no client provenance. */
export const DEFAULT_CT_LAYOUT: CtLayout = ctLayoutSchema.parse({});

export const ctModelInputSchema = z.object({
  name: text(CT_LAYOUT_LIMITS.maxNameChars).min(1, 'Informe o nome do modelo.'),
  layout: ctLayoutSchema,
});
export type CtModelInput = z.input<typeof ctModelInputSchema>;

export interface CtModelDto {
  id: string;
  name: string;
  /** The built-in "Padrão": read-only. */
  builtIn: boolean;
  layout: CtLayout;
  createdAt: number;
  updatedAt: number;
}

/** Body of `PUT .../ct/model`. */
export const ctSessionModelSchema = z.object({
  modelId: z.string().trim().min(1).max(100),
});

export const CT_LAYOUT_ASSIST_LIMITS = { maxPromptChars: 2000 } as const;

export const ctLayoutAssistSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, 'Descreva o visual desejado.')
    .max(CT_LAYOUT_ASSIST_LIMITS.maxPromptChars),
  /** The layout being edited, to refine (the logo is kept and never sent to the model). */
  layout: ctLayoutSchema.optional(),
  /** Router model; blank / omitted = automatic. */
  model: z.string().trim().max(200).optional(),
});
export type CtLayoutAssistInput = z.input<typeof ctLayoutAssistSchema>;

/** A draft proposed by the AI: never saved. */
export interface CtLayoutAssistResultDto {
  name: string;
  layout: CtLayout;
  explanation: string;
  model: string;
  warnings: string[];
}

/** Layout of the sample document used by the live preview of the editor (never saved). */
export const ctLayoutPreviewSchema = z.object({ layout: ctLayoutSchema });
