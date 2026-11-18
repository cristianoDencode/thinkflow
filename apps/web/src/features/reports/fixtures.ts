import {
  templateSpecSchema,
  type ReportDetailDto,
  type ReportDto,
  type ReportTemplateDto,
  type ReportTemplateSummaryDto,
  type TemplateSpecInput,
} from '@thinkflow/shared';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function summary(over: Partial<ReportTemplateSummaryDto> = {}): ReportTemplateSummaryDto {
  return {
    id: 't1',
    name: 'Meu modelo',
    kind: 'report',
    description: 'Descrição do modelo',
    builtIn: false,
    sectionCount: 2,
    variableCount: 1,
    usesMcp: false,
    theme: 'thinkflow',
    primaryColor: '#6d28d9',
    updatedAt: Date.now(),
    ...over,
  };
}

export function template(
  over: Partial<ReportTemplateDto> = {},
  spec: TemplateSpecInput = {
    persona: 'Analista',
    titlePattern: 'Relatório de {{tema}}',
    sections: [
      { id: 's1', title: 'Resumo' },
      { id: 's2', title: 'Detalhes' },
    ],
    variables: [{ name: 'tema', label: 'Tema', required: true }],
  },
): ReportTemplateDto {
  return {
    id: 't1',
    name: 'Meu modelo',
    kind: 'report',
    description: 'Descrição do modelo',
    builtIn: false,
    builtInVersion: null,
    spec: templateSpecSchema.parse(spec),
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

export function report(over: Partial<ReportDto> = {}): ReportDto {
  return {
    id: 'r1',
    title: 'Relatório de teste',
    kind: 'report',
    templateId: 't1',
    templateName: 'Meu modelo',
    status: 'done',
    progress: { phase: 'done', current: 1, total: 1, label: '' },
    error: null,
    failedPhase: null,
    cancelRequested: false,
    model: 'auto',
    variables: {},
    libraryId: null,
    useMcp: false,
    conversationId: null,
    researchDone: 0,
    researchTotal: null,
    sectionCount: 2,
    hasMarkdown: true,
    hasHtml: true,
    hasPdf: false,
    meta: {
      models: [],
      sources: [],
      warnings: [],
      limits: [],
      diagrams: { total: 0, rendered: 0, repaired: 0, failed: 0, unvalidated: 0 },
      libraryDocuments: [],
      generatedAt: null,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

export function reportDetail(over: Partial<ReportDetailDto> = {}): ReportDetailDto {
  return {
    ...report(),
    brief: '',
    markdown: '# x',
    plan: null,
    noteCount: 0,
    sections: [
      {
        ordinal: 1,
        title: 'Resumo',
        role: 'section',
        status: 'done',
        markdown: 'Texto do resumo',
        noteCount: 0,
        model: null,
        providerId: null,
        warnings: ['Dado não verificado'],
        error: null,
        updatedAt: 1,
      },
      {
        ordinal: 2,
        title: 'Detalhes',
        role: 'section',
        status: 'done',
        markdown: 'Texto dos detalhes',
        noteCount: 0,
        model: null,
        providerId: null,
        warnings: [],
        error: null,
        updatedAt: 1,
      },
    ],
    ...over,
  };
}
