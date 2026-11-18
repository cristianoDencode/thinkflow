import type {
  PrototypeBlockDto,
  PrototypeDetailDto,
  PrototypeDto,
  PrototypeVersionDto,
} from '@thinkflow/shared';

export const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function proto(over: Partial<PrototypeDto> = {}): PrototypeDto {
  return {
    id: 'p1',
    name: 'Consulta Empenho',
    kind: 'prototype',
    source: {
      url: null,
      file: 'emp1_empconsulta001.php',
      menuPath: 'DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho',
      title: null,
    },
    sessionId: null,
    sessionName: null,
    stepId: null,
    width: 1280,
    height: 720,
    scrubbed: true,
    versionCount: 2,
    thumbnailUrl: null,
    createdAt: 1_700_000_000_000,
    updatedAt: Date.now() - 3_600_000,
    ...over,
  };
}

export function version(over: Partial<PrototypeVersionDto> = {}): PrototypeVersionDto {
  return { id: 'v1', createdAt: 1_700_000_000_000, note: 'Captura', ...over };
}

export function detail(over: Partial<PrototypeDetailDto> = {}): PrototypeDetailDto {
  return {
    ...proto(),
    versionId: 'v2',
    html: '<body class="pg"><div class="ec-field"><label class="ec-label">Código:</label></div></body>',
    css: '.ec-field{margin:3px}',
    versions: [
      version({ id: 'v1', note: 'Captura', createdAt: 1_700_000_000_000 }),
      version({ id: 'v2', note: 'Edição', createdAt: 1_700_000_100_000 }),
    ],
    sentTo: [],
    ...over,
  };
}

export function block(over: Partial<PrototypeBlockDto> = {}): PrototypeBlockDto {
  return {
    id: 'b1',
    name: 'Cabeçalho padrão',
    category: 'Meus blocos',
    html: '<div class="ec-title">Título</div>',
    css: '',
    source: null,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}
