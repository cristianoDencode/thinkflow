import { z } from 'zod';

/* Reports & templates ("Modelos") */

export const templateKindSchema = z.enum(['report', 'summary', 'prd', 'prototype']);
export type TemplateKind = z.infer<typeof templateKindSchema>;

export const TEMPLATE_KINDS = templateKindSchema.options;

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  report: 'Relatório',
  summary: 'Resumo',
  prd: 'PRD',
  prototype: 'Protótipo',
};

export const TEMPLATE_LIMITS = {
  maxSections: 30,
  maxVariables: 20,
  maxDirectives: 30,
  maxTemplates: 200,
  maxLogoBytes: 200_000,
  maxImportChars: 60_000,
} as const;

/** Visual themes of the generated document (the default is the Thinkflow violet one). */
export const templateThemeSchema = z.enum(['thinkflow', 'sobrio', 'compacto']);
export type TemplateTheme = z.infer<typeof templateThemeSchema>;

export const TEMPLATE_THEME_LABELS: Record<TemplateTheme, string> = {
  thinkflow: 'Thinkflow (violeta)',
  sobrio: 'Sóbrio (cinza e azul)',
  compacto: 'Compacto (denso, para impressão)',
};

export const DEFAULT_TEMPLATE_PRIMARY_COLOR = '#6d28d9';
export const DEFAULT_TEMPLATE_ACCENT_COLOR = '#a78bfa';

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB');
const hexColor = hexColorSchema;
/** Base64 grows 4/3 over the raw bytes; the prefix is short. */
const MAX_LOGO_DATA_URL_CHARS = Math.ceil((TEMPLATE_LIMITS.maxLogoBytes * 4) / 3) + 64;

export const templateVariableSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/,
      'Use letras, números e _ (começando por letra ou _), até 40 caracteres',
    ),
  label: z.string().trim().min(1, 'Informe o rótulo').max(100),
  description: z.string().trim().max(500).default(''),
  required: z.boolean().default(false),
  example: z.string().trim().max(300).default(''),
  defaultValue: z.string().trim().max(1000).default(''),
});
export type TemplateVariable = z.infer<typeof templateVariableSchema>;

export const templateSectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Use letras, números, - e _ (até 40 caracteres)'),
  title: z.string().trim().min(1, 'Informe o título da seção').max(200),
  requirements: z.string().trim().max(4000).default(''),
  diagram: z.enum(['none', 'optional', 'required']).default('none'),
  table: z.enum(['none', 'optional', 'required']).default('none'),
  maxWords: z.number().int().min(50).max(5000).nullable().default(null),
});
export type TemplateSection = z.infer<typeof templateSectionSchema>;

export const templateResearchSchema = z.object({
  useMcp: z.boolean().default(false),
  /** Names of MCP servers the research may call, unattended. `[]` = every enabled server. */
  mcpServers: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  useLibrary: z.boolean().default(true),
  directives: z
    .array(z.string().trim().min(1).max(1000))
    .max(TEMPLATE_LIMITS.maxDirectives)
    .default([]),
  maxSteps: z.number().int().min(1).max(20).default(6),
});
export type TemplateResearch = z.infer<typeof templateResearchSchema>;

export const templateStyleSchema = z.object({
  tone: z.string().trim().max(300).default(''),
  rules: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
});

/** PNG/JPEG data URL of at most `TEMPLATE_LIMITS.maxLogoBytes` bytes (no SVG). */
export const logoDataUrlSchema = z
  .string()
  .max(MAX_LOGO_DATA_URL_CHARS, 'A logo deve ter no máximo 200 KB')
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, 'A logo deve ser PNG ou JPEG');

export const templateLayoutSchema = z.object({
  theme: templateThemeSchema.default('thinkflow'),
  primaryColor: hexColor.default(DEFAULT_TEMPLATE_PRIMARY_COLOR),
  accentColor: hexColor.default(DEFAULT_TEMPLATE_ACCENT_COLOR),
  cover: z.boolean().default(true),
  coverSubtitle: z.string().trim().max(200).default(''),
  headerText: z.string().trim().max(200).default(''),
  footerText: z.string().trim().max(200).default(''),
  /** PNG/JPEG data URL, at most `TEMPLATE_LIMITS.maxLogoBytes` bytes (no SVG). */
  logo: logoDataUrlSchema.nullable().default(null),
  toc: z.boolean().default(true),
  pageSize: z.enum(['A4', 'Letter']).default('A4'),
  sectionPageBreak: z.boolean().default(false),
});
export type TemplateLayout = z.infer<typeof templateLayoutSchema>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,39})\s*\}\}/g;

/** Names of the `{{variable}}` placeholders found in a text. */
export function placeholdersIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

/** Every free-text field of a spec that may contain `{{variable}}` placeholders. */
export function templateTexts(spec: {
  persona: string;
  objective: string;
  audience: string;
  titlePattern: string;
  research: { directives: string[] };
  sections: { title: string; requirements: string }[];
  style: { tone: string; rules: string[] };
  intakeQuestions: string[];
  layout: { coverSubtitle: string; headerText: string; footerText: string };
}): string[] {
  return [
    spec.persona,
    spec.objective,
    spec.audience,
    spec.titlePattern,
    ...spec.research.directives,
    ...spec.sections.flatMap((s) => [s.title, s.requirements]),
    spec.style.tone,
    ...spec.style.rules,
    ...spec.intakeQuestions,
    spec.layout.coverSubtitle,
    spec.layout.headerText,
    spec.layout.footerText,
  ];
}

export const templateSpecSchema = z
  .object({
    persona: z.string().trim().max(2000).default(''),
    objective: z.string().trim().max(4000).default(''),
    audience: z.string().trim().max(500).default(''),
    titlePattern: z.string().trim().max(300).default(''),
    research: templateResearchSchema.default(() => templateResearchSchema.parse({})),
    sections: z
      .array(templateSectionSchema)
      .min(1, 'Inclua ao menos uma seção')
      .max(TEMPLATE_LIMITS.maxSections),
    style: templateStyleSchema.default(() => templateStyleSchema.parse({})),
    variables: z.array(templateVariableSchema).max(TEMPLATE_LIMITS.maxVariables).default([]),
    intakeQuestions: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    layout: templateLayoutSchema.default(() => templateLayoutSchema.parse({})),
  })
  .superRefine((spec, ctx) => {
    const declared = new Set<string>();
    spec.variables.forEach((v, i) => {
      if (declared.has(v.name))
        ctx.addIssue({
          code: 'custom',
          path: ['variables', i, 'name'],
          message: `Variável repetida: ${v.name}`,
        });
      declared.add(v.name);
    });
    const ids = new Set<string>();
    spec.sections.forEach((s, i) => {
      if (ids.has(s.id))
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'id'],
          message: `Identificador de seção repetido: ${s.id}`,
        });
      ids.add(s.id);
    });
    const undeclared = new Set<string>();
    for (const text of templateTexts(spec))
      for (const name of placeholdersIn(text)) if (!declared.has(name)) undeclared.add(name);
    if (undeclared.size > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['variables'],
        message: `Variáveis usadas mas não declaradas: ${[...undeclared].map((n) => `{{${n}}}`).join(', ')}`,
      });
  });
export type TemplateSpec = z.infer<typeof templateSpecSchema>;
export type TemplateSpecInput = z.input<typeof templateSpecSchema>;

export const templateInputSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do modelo').max(120),
  kind: templateKindSchema,
  description: z.string().trim().max(500).default(''),
  spec: templateSpecSchema,
});
export type TemplateInput = z.infer<typeof templateInputSchema>;
export type TemplateInputPayload = z.input<typeof templateInputSchema>;

export const templateListQuerySchema = z.object({ kind: templateKindSchema.optional() });

export interface ReportTemplateDto {
  id: string;
  name: string;
  kind: TemplateKind;
  description: string;
  builtIn: boolean;
  builtInVersion: number | null;
  spec: TemplateSpec;
  createdAt: number;
  updatedAt: number;
}

export interface ReportTemplateSummaryDto {
  id: string;
  name: string;
  kind: TemplateKind;
  description: string;
  builtIn: boolean;
  sectionCount: number;
  variableCount: number;
  usesMcp: boolean;
  theme: TemplateTheme;
  primaryColor: string;
  updatedAt: number;
}

/** Document-template preset of a conversation (set by the chat modes). */
export const chatPresetSchema = z.object({
  kind: templateKindSchema,
  templateId: z.string().min(1),
});
export type ChatPreset = z.infer<typeof chatPresetSchema>;

/* Template assistant ("Importar de prompt" and "Criar com IA") */

export const TEMPLATE_ASSIST_LIMITS = { maxAnswers: 20, maxRounds: 2, maxQuestions: 5 } as const;

const assistAnswerSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().max(2000),
});

export const templateAssistSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('import'),
    model: z.string().trim().min(1, 'Escolha um modelo de IA').max(200),
    text: z
      .string()
      .trim()
      .min(20, 'Cole o prompt completo')
      .max(
        TEMPLATE_LIMITS.maxImportChars,
        `O prompt deve ter no máximo ${TEMPLATE_LIMITS.maxImportChars} caracteres`,
      ),
    kind: templateKindSchema.optional(),
  }),
  z.object({
    mode: z.literal('interview'),
    model: z.string().trim().min(1, 'Escolha um modelo de IA').max(200),
    goal: z.string().trim().min(3, 'Descreva o objetivo do modelo').max(2000),
    kind: templateKindSchema.default('report'),
    /** Answers collected so far (empty on the first call). */
    answers: z.array(assistAnswerSchema).max(TEMPLATE_ASSIST_LIMITS.maxAnswers).default([]),
    /** How many question rounds were already answered (0 = none). The draft is forced after 2. */
    round: z.number().int().min(0).max(TEMPLATE_ASSIST_LIMITS.maxRounds).default(0),
  }),
]);
export type TemplateAssistRequest = z.input<typeof templateAssistSchema>;

export type TemplateAssistResultDto =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'draft'; draft: TemplateInput; warnings: string[] };
