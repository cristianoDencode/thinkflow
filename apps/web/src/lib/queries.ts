import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiKeyDto,
  AuthStatusDto,
  ComboDto,
  ConnectionDto,
  ConversationDto,
  ConversationOrigin,
  DatabaseConnectionDto,
  HealthDto,
  LibraryDetailDto,
  LibraryDto,
  LibrarySettings,
  McpServerDto,
  MetadataMcpServerDto,
  NotebookLmLoginStatusDto,
  NotebookLmSettingsDto,
  ModelOptionDto,
  ProviderDto,
  ReportDetailDto,
  ReportDto,
  ReportSettings,
  ReportStatus,
  ReportTemplateDto,
  ReportTemplateSummaryDto,
  RequestLogDto,
  SettingsDto,
  TemplateKind,
  UsageMonthsDto,
  UsageReportDto,
  ReportRendererStatusDto,
  StorageStatusDto,
  TestDownloadDto,
  TestSessionDto,
  TestSessionSummaryDto,
  TestSupportDto,
} from '@thinkflow/shared';
import { api, ApiError } from './api';

export const keys = {
  auth: ['auth'] as const,
  health: ['health'] as const,
  providers: ['providers'] as const,
  connections: ['connections'] as const,
  combos: ['combos'] as const,
  models: ['models'] as const,
  logs: ['logs'] as const,
  mcp: ['mcp'] as const,
  conversations: ['conversations'] as const,
  settings: ['settings'] as const,
  apiKeys: ['api-keys'] as const,
  usage: ['usage'] as const,
  libraries: ['libraries'] as const,
  reportTemplates: ['report-templates'] as const,
  reports: ['reports'] as const,
  storage: ['storage'] as const,
  tests: ['tests'] as const,
  databases: ['databases'] as const,
  databaseRules: (id: string) => ['databases', id, 'ai-rules'] as const,
  metadataServers: ['databases', 'metadata-mcp', 'servers'] as const,
  metadataProjects: (serverId: string) =>
    ['databases', 'metadata-mcp', 'servers', serverId, 'projects'] as const,
};

export const useAuthStatus = () =>
  useQuery({ queryKey: keys.auth, queryFn: () => api.get<AuthStatusDto>('/api/auth/status') });

export const useHealth = () =>
  useQuery({
    queryKey: keys.health,
    queryFn: () => api.get<HealthDto>('/api/health'),
    refetchInterval: 15_000,
    retry: false,
  });

export const useProviders = () =>
  useQuery({
    queryKey: keys.providers,
    queryFn: () => api.get<ProviderDto[]>('/api/providers'),
    staleTime: Infinity,
  });

export const useConnections = () =>
  useQuery({
    queryKey: keys.connections,
    queryFn: () => api.get<ConnectionDto[]>('/api/connections'),
    refetchInterval: 10_000,
  });

export const useCombos = () =>
  useQuery({ queryKey: keys.combos, queryFn: () => api.get<ComboDto[]>('/api/combos') });

export const useModelOptions = () =>
  useQuery({ queryKey: keys.models, queryFn: () => api.get<ModelOptionDto[]>('/api/models') });

export const useLibraries = () =>
  useQuery({ queryKey: keys.libraries, queryFn: () => api.get<LibraryDto[]>('/api/libraries') });

export const useLibrary = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.libraries, 'detail', id],
    queryFn: () => api.get<LibraryDetailDto>(`/api/libraries/${id}`),
    enabled: Boolean(id),
    // poll while documents are still being processed / synced
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      const busy = docs.some(
        (d) =>
          d.status === 'processing' ||
          d.remote?.status === 'pending' ||
          d.remote?.status === 'syncing',
      );
      return busy ? 2000 : false;
    },
  });

export const useLibrarySettings = () =>
  useQuery({
    queryKey: [...keys.libraries, 'settings'],
    queryFn: () => api.get<LibrarySettings>('/api/library/settings'),
  });

export const useNotebookLmSettings = () =>
  useQuery({
    queryKey: [...keys.libraries, 'notebooklm'],
    queryFn: () => api.get<NotebookLmSettingsDto>('/api/library/notebooklm'),
  });

/** State of the in-app Google login; polls every 2 s while the login window is open. */
export const useNotebookLmLogin = () =>
  useQuery({
    queryKey: [...keys.libraries, 'notebooklm', 'login'],
    queryFn: () => api.get<NotebookLmLoginStatusDto>('/api/library/notebooklm/login'),
    refetchInterval: (query) => (query.state.data?.state === 'waiting' ? 2000 : false),
  });

export const useLogs = () =>
  useQuery({
    queryKey: keys.logs,
    queryFn: () => api.get<RequestLogDto[]>('/api/logs?limit=100'),
    refetchInterval: 10_000,
  });

export const useMcpServers = () =>
  useQuery({ queryKey: keys.mcp, queryFn: () => api.get<McpServerDto[]>('/api/mcp') });

export const useDatabases = () =>
  useQuery({
    queryKey: keys.databases,
    queryFn: () => api.get<DatabaseConnectionDto[]>('/api/databases'),
  });

/** Enabled MCP servers that expose a data dictionary (`field_search`), for a connection's settings. */
export const useMetadataServers = (enabled: boolean) =>
  useQuery({
    queryKey: keys.metadataServers,
    queryFn: () => api.get<MetadataMcpServerDto[]>('/api/databases/metadata-mcp/servers'),
    enabled,
    staleTime: 30_000,
  });

/** Projects (`list_projects`) of a dictionary server. */
export const useMetadataProjects = (serverId: string) =>
  useQuery({
    queryKey: keys.metadataProjects(serverId),
    queryFn: () =>
      api.get<string[]>(
        `/api/databases/metadata-mcp/servers/${encodeURIComponent(serverId)}/projects`,
      ),
    enabled: serverId !== '',
    staleTime: 30_000,
  });

export interface ConversationParams {
  q?: string;
  mode?: 'chat' | 'agent' | 'data';
  /** chat = "Pergunte à AI" without a document template; document = with one. */
  origin?: ConversationOrigin;
  databaseId?: string;
  /** Last-activity range (epoch ms, inclusive). */
  from?: number;
  to?: number;
  pinned?: boolean;
  limit?: number;
}

export const useConversations = (params?: ConversationParams) =>
  useQuery({
    queryKey: [...keys.conversations, params ?? {}],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set('q', params.q);
      if (params?.mode) qs.set('mode', params.mode);
      if (params?.origin) qs.set('origin', params.origin);
      if (params?.databaseId) qs.set('databaseId', params.databaseId);
      if (params?.from !== undefined) qs.set('from', String(params.from));
      if (params?.to !== undefined) qs.set('to', String(params.to));
      if (params?.pinned !== undefined) qs.set('pinned', String(params.pinned));
      if (params?.limit) qs.set('limit', String(params.limit));
      const query = qs.toString();
      return api.get<ConversationDto[]>(`/api/conversations${query ? `?${query}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api.get<SettingsDto>('/api/settings') });

export const useApiKeys = () =>
  useQuery({ queryKey: keys.apiKeys, queryFn: () => api.get<ApiKeyDto[]>('/api/api-keys') });

export const useUsage = (month: string | undefined) =>
  useQuery({
    queryKey: [...keys.usage, 'report', month ?? 'current'],
    queryFn: () => api.get<UsageReportDto>(`/api/usage${month ? `?month=${month}` : ''}`),
    refetchInterval: 60_000,
  });

export const useUsageMonths = () =>
  useQuery({
    queryKey: [...keys.usage, 'months'],
    queryFn: () => api.get<UsageMonthsDto>('/api/usage/months'),
    refetchInterval: 60_000,
  });

export const useReportTemplates = (kind?: TemplateKind) =>
  useQuery({
    queryKey: [...keys.reportTemplates, 'list', kind ?? 'all'],
    queryFn: () =>
      api.get<ReportTemplateSummaryDto[]>(
        `/api/report-templates${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
      ),
  });

export const useReportTemplate = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.reportTemplates, 'detail', id],
    queryFn: () => api.get<ReportTemplateDto>(`/api/report-templates/${id}`),
    enabled: Boolean(id),
  });

/** Statuses in which the background job is still running (the UI polls every 2 s). */
export const ACTIVE_REPORT_STATUSES: readonly ReportStatus[] = [
  'queued',
  'researching',
  'outlining',
  'writing',
  'assembling',
];
export const isReportActive = (status: ReportStatus | undefined): boolean =>
  status !== undefined && ACTIVE_REPORT_STATUSES.includes(status);

export interface ReportListParams {
  status?: ReportStatus;
  kind?: TemplateKind;
  q?: string;
  limit?: number;
}

export const useReports = (params: ReportListParams = {}) =>
  useQuery({
    queryKey: [...keys.reports, 'list', params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params.status) qs.set('status', params.status);
      if (params.kind) qs.set('kind', params.kind);
      if (params.q) qs.set('q', params.q);
      if (params.limit) qs.set('limit', String(params.limit));
      const query = qs.toString();
      return api.get<ReportDto[]>(`/api/reports${query ? `?${query}` : ''}`);
    },
    placeholderData: keepPreviousData,
    // keep the list live while any job is running
    refetchInterval: (query) =>
      query.state.data?.some((r) => isReportActive(r.status)) ? 2000 : false,
  });

export const useReport = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.reports, 'detail', id],
    queryFn: () => api.get<ReportDetailDto>(`/api/reports/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => (isReportActive(query.state.data?.status) ? 2000 : false),
  });

export const useReportSettings = () =>
  useQuery({
    queryKey: [...keys.reports, 'settings'],
    queryFn: () => api.get<ReportSettings>('/api/reports/settings'),
  });

/** Output capabilities of the server (PDF / diagram rendering with Chromium). */
export type ReportRendererStatus = ReportRendererStatusDto;

/** Resolves to `null` when the server has no renderer route (older build). */
export const useReportRenderer = () =>
  useQuery({
    queryKey: [...keys.reports, 'renderer'],
    queryFn: async () => {
      try {
        return await api.get<ReportRendererStatus>('/api/reports/renderer');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

/** Document storage status; resolves to `null` on servers without the route. */
export const useStorageStatus = () =>
  useQuery({
    queryKey: [...keys.storage, 'status'],
    queryFn: async () => {
      try {
        return await api.get<StorageStatusDto>('/api/storage/status');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

/** Forces a fresh connectivity check and stores the result in the status cache. */
export const useStorageCheck = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<StorageStatusDto>('/api/storage/check', {}),
    onSuccess: (data) => queryClient.setQueryData([...keys.storage, 'status'], data),
  });
};

/** Re-sends documents that are still pending upload. */
export const useStorageSync = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ accepted: boolean }>('/api/storage/sync', {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.storage });
      await queryClient.invalidateQueries({ queryKey: keys.reports });
    },
  });
};

/* Test sessions ("Testes") */

const isTestBusy = (state: TestSessionSummaryDto['state'] | undefined) =>
  state !== undefined && state !== 'idle';

export const useTestSupport = () =>
  useQuery({
    queryKey: [...keys.tests, 'support'],
    queryFn: () => api.get<TestSupportDto>('/api/tests/support'),
    staleTime: 60_000,
  });

export const useTestSessions = () =>
  useQuery({
    queryKey: [...keys.tests, 'list'],
    queryFn: () => api.get<TestSessionSummaryDto[]>('/api/tests/sessions'),
    refetchInterval: (query) => (query.state.data?.some((s) => isTestBusy(s.state)) ? 2000 : false),
  });

/** Polls every second while the browser records or a replay runs, so steps show up live. */
export const useTestSession = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.tests, 'detail', id],
    queryFn: () => api.get<TestSessionDto>(`/api/tests/sessions/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => (isTestBusy(query.state.data?.state) ? 1000 : false),
  });

/** Files downloaded while recording or replaying a session, newest first. */
export const useTestDownloads = (id: string | undefined, busy: boolean) =>
  useQuery({
    queryKey: [...keys.tests, 'downloads', id],
    queryFn: () => api.get<TestDownloadDto[]>(`/api/tests/sessions/${id}/downloads`),
    enabled: Boolean(id),
    // new files show up while the browser records or a replay runs
    refetchInterval: busy ? 2000 : false,
  });
