import { z } from 'zod';
import { PROTOTYPE_LIMITS } from './prototypes';

/*
 * "Assistente de IA" of the prototype editor: request / response contract of
 * POST /api/prototypes/:id/assistant.
 *
 * The model only ever rewrites the HTML/CSS of the screen (or of the selected component). The
 * server proposes a result; nothing is saved until the person applies it in the editor.
 */

export const PROTOTYPE_ASSISTANT_ACTIONS = [
  'custom',
  'add_field',
  'grid_columns',
  'two_columns',
  'labels',
  'generate',
] as const;
export type PrototypeAssistantAction = (typeof PROTOTYPE_ASSISTANT_ACTIONS)[number];

export const PROTOTYPE_ASSISTANT_LIMITS = {
  maxPromptChars: 4_000,
  maxLibraries: 5,
  maxMcpServers: 5,
  /** HTML + CSS (after compaction) that may be sent to the model in one request. */
  maxModelChars: 48_000,
  maxPathDepth: 60,
} as const;

/** Quick action of the panel: a prompt template, optionally completed with one short input. */
export interface PrototypeAssistantQuickAction {
  action: Exclude<PrototypeAssistantAction, 'custom'>;
  label: string;
  hint: string;
  /** Label of the extra field the person fills in before sending (none = sends right away). */
  input?: { label: string; placeholder: string };
  /** Prompt; `{valor}` is replaced by the input. */
  template: string;
}

export const PROTOTYPE_ASSISTANT_QUICK_ACTIONS: readonly PrototypeAssistantQuickAction[] = [
  {
    action: 'add_field',
    label: 'Adicionar campo…',
    hint: 'Inclui um campo (rótulo + entrada) no mesmo estilo dos demais',
    input: { label: 'Nome do campo', placeholder: 'Ex.: Data de vencimento' },
    template:
      'Adicione o campo "{valor}" (rótulo e entrada) ao formulário, ao lado dos campos existentes e no mesmo estilo deles. Não altere mais nada.',
  },
  {
    action: 'grid_columns',
    label: 'Transformar em grid com colunas…',
    hint: 'Monta uma grade (tabela) com as colunas informadas',
    input: { label: 'Colunas (separadas por vírgula)', placeholder: 'Ex.: Código, Nome, Valor' },
    template:
      'Transforme o conteúdo escolhido em uma grade (tabela) no estilo das grades que já existem na tela (ou da grade padrão do perfil do sistema), com as colunas: {valor}. Use linhas de exemplo curtas e genéricas (sem dados pessoais).',
  },
  {
    action: 'two_columns',
    label: 'Reorganizar em duas colunas',
    hint: 'Divide os campos do formulário em duas colunas',
    template:
      'Reorganize os campos do formulário em duas colunas lado a lado, mantendo todos os campos, rótulos, botões e o estilo atual.',
  },
  {
    action: 'labels',
    label: 'Traduzir/ajustar rótulos',
    hint: 'Muda só os textos visíveis (rótulos, títulos, botões)',
    input: {
      label: 'O que fazer com os rótulos',
      placeholder: 'Ex.: traduzir para português, usar os nomes do dicionário',
    },
    template:
      'Ajuste somente os textos visíveis (rótulos, títulos, legendas, botões e opções): {valor}. Não mude a estrutura, os atributos nem o estilo.',
  },
  {
    action: 'generate',
    label: 'Gerar a partir da descrição',
    hint: 'Monta uma tela no estilo do sistema a partir de um texto (ideal para tela em branco)',
    input: {
      label: 'Descreva a tela',
      placeholder: 'Ex.: Cadastro de fornecedor com CNPJ, razão social, endereço e botão Salvar',
    },
    template:
      'Monte uma tela no estilo do sistema (perfil ativo) a partir desta descrição: {valor}. Use fieldsets, rótulos e campos no padrão clássico, uma barra de título e a barra de botões.',
  },
];

/** The prompt of a quick action (`value` fills `{valor}`; empty input leaves a neutral text). */
export function buildQuickActionPrompt(
  action: PrototypeAssistantQuickAction['action'],
  value = '',
): string {
  const quick = PROTOTYPE_ASSISTANT_QUICK_ACTIONS.find((q) => q.action === action);
  if (!quick) return value.trim();
  return quick.template.replace('{valor}', value.trim() || '(o que for mais adequado)');
}

/**
 * The selected component: `path` = positions among the ELEMENT children, starting at `<body>`
 * (`[0, 2]` = body > 1st element > 3rd element; also accepted as "0/2"); `html` = its markup.
 * The server finds the component by path and, when that does not fit, by its markup.
 */
export const prototypeAssistantSelectionSchema = z
  .object({
    path: z
      .union([
        z.array(z.number().int().min(0).max(100_000)).max(PROTOTYPE_ASSISTANT_LIMITS.maxPathDepth),
        z.string().max(400),
      ])
      .optional(),
    html: z.string().max(PROTOTYPE_LIMITS.maxSnapshotBytes).optional(),
  })
  .refine((s) => s.path !== undefined || !!s.html?.trim(), {
    message: 'Informe o caminho ou o HTML do componente selecionado.',
  });
export type PrototypeAssistantSelection = z.infer<typeof prototypeAssistantSelectionSchema>;

const ids = z.array(z.string().trim().min(1).max(200));

export const prototypeAssistantRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Escreva o que você quer pedir à IA.')
    .max(PROTOTYPE_ASSISTANT_LIMITS.maxPromptChars),
  /** Which quick action produced the prompt (tunes the instructions and the checks). */
  action: z.enum(PROTOTYPE_ASSISTANT_ACTIONS).default('custom'),
  /** Absent = the whole screen. */
  selection: prototypeAssistantSelectionSchema.optional(),
  html: z.string().max(PROTOTYPE_LIMITS.maxSnapshotBytes),
  css: z.string().max(PROTOTYPE_LIMITS.maxSnapshotBytes).default(''),
  width: z.number().int().min(PROTOTYPE_LIMITS.minSize).max(PROTOTYPE_LIMITS.maxWidth),
  height: z.number().int().min(PROTOTYPE_LIMITS.minSize).max(PROTOTYPE_LIMITS.maxHeight),
  libraryIds: ids.max(PROTOTYPE_ASSISTANT_LIMITS.maxLibraries).default([]),
  mcpServerIds: ids.max(PROTOTYPE_ASSISTANT_LIMITS.maxMcpServers).default([]),
  /** Model id or combo name as in `/api/models`; absent = "auto". */
  model: z.string().trim().min(1).max(200).optional(),
});
export type PrototypeAssistantRequest = z.input<typeof prototypeAssistantRequestSchema>;

export interface PrototypeAssistantResultDto {
  /** The whole `<body …>` of the proposed screen (a component answer is already spliced in). */
  html: string;
  css: string;
  /** Short pt-BR explanation of what changed. */
  explanation: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Non-fatal notes: stripped scripts/URLs, big changes, sources that could not be used… */
  warnings: string[];
}
