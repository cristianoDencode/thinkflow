import type {
  TestDownloadDto,
  TestRunDto,
  TestSessionDto,
  TestSessionSummaryDto,
} from '@thinkflow/shared';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function sessionSummary(over: Partial<TestSessionSummaryDto> = {}): TestSessionSummaryDto {
  return {
    id: 's1',
    name: 'Cadastro de contribuinte',
    startUrl: 'https://homolog.exemplo/login',
    state: 'idle',
    stepCount: 0,
    imageCount: 0,
    mode: null,
    lastRun: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function sessionDetail(over: Partial<TestSessionDto> = {}): TestSessionDto {
  return {
    ...sessionSummary(),
    definition: {
      schemaVersion: 1,
      viewport: { width: 1366, height: 768 },
      autoThumbnails: true,
      parameters: [],
      dataSets: [{ id: 'recorded', name: 'Gravado', values: {} }],
      steps: [],
    },
    runs: [],
    images: {},
    downloadCount: 0,
    stepDownloads: {},
    warning: null,
    recordingMode: null,
    ...over,
  };
}

export function testRun(over: Partial<TestRunDto> = {}): TestRunDto {
  return {
    id: 'r1',
    sessionId: 's1',
    seq: 1,
    rerunOf: null,
    rerunOfSeq: null,
    data: null,
    rerun: null,
    dataSetId: 'recorded',
    dataSetName: 'Gravado',
    status: 'passed',
    headed: false,
    results: [],
    error: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    ...over,
  };
}

export function testDownload(over: Partial<TestDownloadDto> = {}): TestDownloadDto {
  return {
    id: 'd1',
    sessionId: 's1',
    stepId: null,
    runId: null,
    runSeq: null,
    source: 'recording',
    fileName: 'relatorio.xlsx',
    size: 2048,
    contentType: 'application/octet-stream',
    url: 'https://homolog.exemplo/exportar',
    status: 'saved',
    reason: null,
    createdAt: 1_700_000_000_000,
    fileUrl: '/api/tests/sessions/s1/downloads/d1/file',
    ...over,
  };
}
