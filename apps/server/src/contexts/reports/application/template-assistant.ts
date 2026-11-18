import {
  TEMPLATE_ASSIST_LIMITS,
  TEMPLATE_KIND_LABELS,
  templateAssistSchema,
  type TemplateAssistResultDto,
  type TemplateInput,
  type TemplateKind,
} from '@thinkflow/shared';
import { headTail } from '../../chat/domain/context-window';
import { convertStream, tapUsage, type UsageTotals } from '../../protocol/domain/convert';
import type { OAIChunk } from '../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import { BUILTIN_TEMPLATES } from '../domain/builtin-templates';
import { extractJsonObject } from '../domain/json-extract';
import {
  coerceTemplateDraft,
  describeHints,
  heuristicTemplateFromPrompt,
} from '../domain/template-import';

const ASSIST_TIMEOUT_MS = 120_000;
const ASSIST_MAX_OUTPUT_TOKENS = 3_000;
/** Characters of the pasted prompt sent to the model (head + tail when longer). */
const PROMPT_HEAD_CHARS = 30_000;
const PROMPT_TAIL_CHARS = 10_000;

export const HEURISTIC_WARNING =
  'A IA não devolveu um modelo válido; usamos a estrutura detectada no texto. Revise antes de salvar.';

const SHAPE = `{
  "name": "nome curto do modelo",
  "kind": "report | summary | prd | prototype",
  "description": "uma frase",
  "spec": {
    "persona": "papel do redator, ex.: Arquiteto de Sistemas Especialista em ...",
    "objective": "objetivo e entregável",
    "audience": "quem vai ler",
    "titlePattern": "título do documento, pode usar {{variavel}}",
    "research": {
      "useMcp": false,
      "mcpServers": [],
      "useLibrary": true,
      "directives": ["o que pesquisar nas fontes"],
      "maxSteps": 6
    },
    "sections": [
      {
        "title": "título da seção",
        "requirements": "o que a seção deve conter",
        "diagram": "none | optional | required",
        "table": "none | optional | required",
        "maxWords": null
      }
    ],
    "style": { "tone": "tom de voz", "rules": ["regras de escrita"] },
    "variables": [
      {
        "name": "funcao",
        "label": "Função PL/pgSQL",
        "description": "",
        "required": true,
        "example": "fc_calcula",
        "defaultValue": "fc_calcula"
      }
    ],
    "intakeQuestions": ["perguntas de escopo para o usuário"]
  }
}`;

const IMPORT_SYSTEM = [
  'Você converte um prompt de geração de documento em um MODELO reutilizável.',
  'Responda SOMENTE com um objeto JSON válido (sem comentários e sem texto fora do JSON) neste formato:',
  SHAPE,
  'Regras: preserve as seções do prompt na mesma ordem e com os mesmos títulos; copie para "requirements" o que cada seção deve conter; ' +
    'use "diagram": "required" quando a seção pede um diagrama/fluxograma e "table": "required" quando pede tabela; ' +
    'coloque as instruções de pesquisa em "research.directives" e as regras de escrita em "style.rules".',
  'Identifique valores específicos que deveriam ser variáveis (ex.: o nome de uma função, tabela ou módulo) e troque-os por {{nome}} em todos os textos, ' +
    'declarando cada um em "variables" (nome em minúsculas, sem acentos, com letras, números e _).',
  'Use "useMcp": true se o prompt manda consultar um servidor MCP ou ferramentas externas.',
].join('\n\n');

const INTERVIEW_SYSTEM_BASE = [
  'Você ajuda a criar MODELOS de documento (relatório, resumo, PRD ou protótipo) para uma IA redatora que pesquisa em fontes (MCP e Biblioteca).',
];

const DEFAULT_QUESTIONS: Record<TemplateKind, string[]> = {
  report: [
    'Quem vai ler o documento e o que essa pessoa precisa decidir ou entender?',
    'Quais seções ou tópicos não podem faltar?',
    'Há diagramas ou tabelas obrigatórios (fluxo, comparativo, métricas)?',
    'Qual valor muda a cada geração (por exemplo, o nome de um módulo, função ou sistema)?',
    'Qual o tom desejado (técnico, executivo, didático) e há regras de escrita?',
  ],
  summary: [
    'Que tipo de material será resumido e para quem?',
    'Quais pontos o resumo precisa destacar (decisões, riscos, prazos)?',
    'Qual o tamanho desejado do resumo?',
  ],
  prd: [
    'Qual o produto ou área e quem são os usuários principais?',
    'Quais seções o PRD deve ter além de problema, objetivos e requisitos?',
    'Existem métricas de sucesso ou restrições que devem constar?',
  ],
  prototype: [
    'Qual produto ou fluxo será prototipado e para quem?',
    'Quais telas são indispensáveis?',
    'Há padrões visuais ou regras de negócio que o protótipo deve seguir?',
  ],
};

type Message = { role: 'system' | 'user'; content: string };

export interface TemplateAssistantDeps {
  router: RouteChatRequest;
}

type Completion = { ok: true; text: string } | { ok: false; error: string };

export class TemplateAssistant {
  constructor(private readonly deps: TemplateAssistantDeps) {}

  async assist(input: unknown, signal?: AbortSignal): Promise<TemplateAssistResultDto> {
    const request = templateAssistSchema.parse(input);
    return request.mode === 'import'
      ? this.importPrompt(request.text, request.model, request.kind, signal)
      : this.interview(request, signal);
  }

  /** "Importar de prompt": AI first, deterministic structure when the AI fails. Never throws for model problems. */
  private async importPrompt(
    text: string,
    model: string,
    kind: TemplateKind | undefined,
    signal?: AbortSignal,
  ): Promise<TemplateAssistResultDto> {
    const heuristic = heuristicTemplateFromPrompt(text, kind ?? 'report');
    const warnings: string[] = [];
    const clipped = headTail(text, PROMPT_HEAD_CHARS, PROMPT_TAIL_CHARS);
    if (clipped !== text)
      warnings.push('O prompt é muito longo; o meio do texto não foi enviado à IA.');
    const userContent =
      `<prompt>\n${clipped}\n</prompt>\n\nPistas detectadas automaticamente (podem estar incompletas):\n` +
      describeHints(heuristic);
    const messages: Message[] = [
      { role: 'system', content: IMPORT_SYSTEM },
      { role: 'user', content: userContent },
    ];

    const outcome = await this.askForDraft(messages, model, { kind, name: heuristic.name }, signal);
    if (outcome.draft) return { kind: 'draft', draft: outcome.draft, warnings };
    if (outcome.error) warnings.push(`Falha ao consultar a IA: ${outcome.error}`);
    warnings.push(HEURISTIC_WARNING);
    return { kind: 'draft', draft: heuristic, warnings };
  }

  private async interview(
    request: Extract<ReturnType<typeof templateAssistSchema.parse>, { mode: 'interview' }>,
    signal?: AbortSignal,
  ): Promise<TemplateAssistResultDto> {
    const { goal, kind, model, answers } = request;
    const round = Math.max(request.round, answers.length > 0 ? 1 : 0);
    const forced = round >= TEMPLATE_ASSIST_LIMITS.maxRounds;
    const label = TEMPLATE_KIND_LABELS[kind];
    const context =
      `Tipo de documento: ${label}\nObjetivo do modelo: ${goal}` +
      (answers.length
        ? `\n\nRespostas do usuário:\n${answers.map((a) => `P: ${a.question}\nR: ${a.answer || '(sem resposta)'}`).join('\n')}`
        : '');

    if (round === 0) {
      const completion = await this.complete(
        [
          {
            role: 'system',
            content: [
              ...INTERVIEW_SYSTEM_BASE,
              `Faça até ${TEMPLATE_ASSIST_LIMITS.maxQuestions} perguntas curtas e objetivas, em português, para entender o que o modelo precisa ter (público, seções, diagramas/tabelas, o que varia a cada geração, tom). ` +
                'Responda SOMENTE com JSON: {"perguntas":["..."]}.',
            ].join('\n\n'),
          },
          { role: 'user', content: context },
        ],
        model,
        signal,
      );
      const questions = completion.ok ? questionsFrom(extractJsonObject(completion.text)) : [];
      return {
        kind: 'questions',
        questions: questions.length > 0 ? questions : DEFAULT_QUESTIONS[kind],
      };
    }

    const system = [
      ...INTERVIEW_SYSTEM_BASE,
      forced
        ? 'Com as informações abaixo, monte o modelo. Responda SOMENTE com JSON: {"modelo": <objeto no formato abaixo>}.'
        : `Com as informações abaixo, monte o modelo. Se faltar algo essencial, responda {"perguntas":["..."]} com até ${TEMPLATE_ASSIST_LIMITS.maxQuestions} perguntas novas; caso contrário responda SOMENTE com JSON: {"modelo": <objeto no formato abaixo>}.`,
      `Formato de "modelo":\n${SHAPE}`,
      'Use {{nome}} nos textos para valores que mudam a cada geração e declare cada um em "variables" (nome em minúsculas, sem acentos, com letras, números e _). ' +
        `Use "kind": "${kind}".`,
    ].join('\n\n');
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: context },
    ];

    const outcome = await this.askForDraft(
      messages,
      model,
      { kind, name: goal.slice(0, 120) },
      signal,
      forced ? undefined : true,
    );
    if (outcome.questions) return { kind: 'questions', questions: outcome.questions };
    if (outcome.draft) return { kind: 'draft', draft: outcome.draft, warnings: [] };
    const warnings: string[] = [];
    if (outcome.error) warnings.push(`Falha ao consultar a IA: ${outcome.error}`);
    warnings.push(
      'A IA não devolveu um modelo válido; começamos de um modelo padrão do mesmo tipo. Ajuste as seções e os textos.',
    );
    return { kind: 'draft', draft: skeleton(kind, goal), warnings };
  }

  /**
   * Asks for a template (one retry with the validation issues). `allowQuestions` makes a
   * `{"perguntas": [...]}` answer a valid outcome.
   */
  private async askForDraft(
    messages: Message[],
    model: string,
    options: { kind?: TemplateKind | undefined; name: string },
    signal?: AbortSignal,
    allowQuestions?: boolean,
  ): Promise<{ draft?: TemplateInput; questions?: string[]; error?: string }> {
    let conversation = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await this.complete(conversation, model, signal);
      if (!completion.ok) return { error: completion.error };
      const json = extractJsonObject(completion.text);
      if (allowQuestions && json) {
        const questions = questionsFrom(json);
        if (questions.length > 0 && !('modelo' in json) && !('spec' in json)) return { questions };
      }
      const coerced = json
        ? coerceTemplateDraft(json, options)
        : { ok: false as const, issues: ['A resposta não contém um objeto JSON'] };
      if (coerced.ok) return { draft: coerced.draft };
      conversation = [
        ...messages,
        {
          role: 'user',
          content:
            'Sua resposta anterior era inválida:\n- ' +
            coerced.issues.slice(0, 8).join('\n- ') +
            '\nResponda de novo SOMENTE com o JSON corrigido.',
        },
      ];
    }
    return {};
  }

  private async complete(
    messages: Message[],
    model: string,
    signal?: AbortSignal,
  ): Promise<Completion> {
    const timeout = AbortSignal.timeout(ASSIST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const routed = await this.deps.router.execute(
        {
          format: 'openai',
          body: {
            model,
            messages,
            stream: true,
            max_tokens: ASSIST_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
          },
        },
        { source: 'template-assist', signal: combined },
      );
      if (!routed.ok) return { ok: false, error: routed.message };
      const usage: UsageTotals = { inputTokens: null, outputTokens: null };
      let text = '';
      try {
        const chunks = tapUsage(
          convertStream(routed.stream.events, routed.stream.format, 'openai', routed.model),
          'openai',
          usage,
        );
        for await (const raw of chunks) {
          const delta = (raw as unknown as OAIChunk).choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
        }
        routed.finish(usage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        routed.finish({ ...usage, error: message });
        // a cut-off answer may still hold a recoverable JSON
        return text ? { ok: true, text } : { ok: false, error: message };
      }
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function questionsFrom(json: Record<string, unknown> | null): string[] {
  const raw = json?.perguntas ?? json?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, TEMPLATE_ASSIST_LIMITS.maxQuestions);
}

/** Interview fallback: a built-in template of the same kind, renamed after the goal. */
function skeleton(kind: TemplateKind, goal: string): TemplateInput {
  const base = BUILTIN_TEMPLATES.find((t) => t.kind === kind) ?? BUILTIN_TEMPLATES[0]!;
  const coerced = coerceTemplateDraft(
    {
      name: `${base.name} (personalizado)`,
      kind,
      description: goal.slice(0, 500),
      spec: structuredClone(base.spec),
    },
    { kind },
  );
  if (!coerced.ok) throw new Error('built-in template is invalid');
  return coerced.draft;
}
