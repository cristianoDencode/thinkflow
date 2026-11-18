import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PrototypeBlockDto,
  PrototypeBlockInput,
  PrototypeBlockUpdateInput,
  PrototypeCreateInput,
  PrototypeDetailDto,
  PrototypeDto,
  PrototypeKind,
  PrototypeSaveAsTemplateInput,
  PrototypeSnapshot,
  PrototypeTemplateDto,
  PrototypeUpdateInput,
} from '@thinkflow/shared';
import { api } from '../../lib/api';
import { thumbnailPollInterval } from './thumbnail';

export const protoKeys = {
  all: ['prototypes'] as const,
  /** Prefix of every list (prototypes and templates): invalidating it refreshes both. */
  list: ['prototypes', 'list'] as const,
  listOf: (kind: PrototypeKind) => ['prototypes', 'list', kind] as const,
  templates: ['prototypes', 'templates'] as const,
  detail: (id: string) => ['prototypes', 'detail', id] as const,
  blocks: ['prototypes', 'blocks'] as const,
};

export const usePrototypes = (kind: PrototypeKind = 'prototype', enabled = true) =>
  useQuery({
    queryKey: protoKeys.listOf(kind),
    enabled,
    queryFn: () =>
      api.get<PrototypeDto[]>(
        kind === 'prototype' ? '/api/prototypes' : `/api/prototypes?kind=${kind}`,
      ),
    // captures made from Testes only invalidate the tests query: always refetch when shown
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    // the server renders the thumbnails after a capture/save: look again for a few seconds
    refetchInterval: (query) => thumbnailPollInterval(query.state.data),
  });

export const usePrototype = (id: string | undefined) =>
  useQuery({
    queryKey: protoKeys.detail(id ?? ''),
    queryFn: () => api.get<PrototypeDetailDto>(`/api/prototypes/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      thumbnailPollInterval(query.state.data ? [query.state.data] : undefined),
  });

/** Built-in templates followed by the user's own (`GET /api/prototypes/templates`). */
export const useTemplates = (enabled = true) =>
  useQuery({
    queryKey: protoKeys.templates,
    queryFn: () => api.get<PrototypeTemplateDto[]>('/api/prototypes/templates'),
    enabled,
  });

export const usePrototypeBlocks = () =>
  useQuery({
    queryKey: protoKeys.blocks,
    queryFn: () => api.get<PrototypeBlockDto[]>('/api/prototypes/blocks'),
  });

/** Everything that changes a prototype refreshes the list and primes the detail cache. */
function useDetailMutation<TVars>(fn: (vars: TVars) => Promise<PrototypeDetailDto>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (detail) => {
      queryClient.setQueryData(protoKeys.detail(detail.id), detail);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: protoKeys.list }),
        queryClient.invalidateQueries({ queryKey: protoKeys.templates }),
      ]);
    },
  });
}

export const useCreatePrototype = () =>
  useDetailMutation((input: PrototypeCreateInput) =>
    api.post<PrototypeDetailDto>('/api/prototypes', input),
  );

export const useUpdatePrototype = (id: string) =>
  useDetailMutation((input: PrototypeUpdateInput) =>
    api.put<PrototypeDetailDto>(`/api/prototypes/${id}`, input),
  );

/** Copies the current (saved) version of a prototype into a new template. */
export const useSaveAsTemplate = (id: string) =>
  useDetailMutation((input: PrototypeSaveAsTemplateInput) =>
    api.post<PrototypeDetailDto>(`/api/prototypes/${id}/save-as-template`, input),
  );

export const useRestoreVersion = (id: string) =>
  useDetailMutation((versionId: string) =>
    api.post<PrototypeDetailDto>(`/api/prototypes/${id}/versions/${versionId}/restore`),
  );

export const fetchVersion = (id: string, versionId: string) =>
  api.get<Pick<PrototypeSnapshot, 'html' | 'css' | 'width' | 'height' | 'scene'>>(
    `/api/prototypes/${id}/versions/${versionId}`,
  );

export const useDeletePrototype = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/prototypes/${id}`),
    onSuccess: async (_data, id) => {
      queryClient.removeQueries({ queryKey: protoKeys.detail(id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: protoKeys.list }),
        queryClient.invalidateQueries({ queryKey: protoKeys.templates }),
      ]);
    },
  });
};

export const useSaveBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PrototypeBlockInput) =>
      api.post<PrototypeBlockDto>('/api/prototypes/blocks', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: protoKeys.blocks }),
  });
};

export const useUpdateBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PrototypeBlockUpdateInput & { id: string }) =>
      api.put<PrototypeBlockDto>(`/api/prototypes/blocks/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: protoKeys.blocks }),
  });
};

export const useDeleteBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blockId: string) => api.del(`/api/prototypes/blocks/${blockId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: protoKeys.blocks }),
  });
};

/** Duplicate = new prototype from the current snapshot of another one. */
export async function duplicatePrototype(source: PrototypeDto): Promise<PrototypeDetailDto> {
  const detail = await api.get<PrototypeDetailDto>(`/api/prototypes/${source.id}`);
  return api.post<PrototypeDetailDto>('/api/prototypes', {
    name: `${source.name} (cópia)`.slice(0, 120),
    snapshot: { html: detail.html, css: detail.css, width: detail.width, height: detail.height },
    source: detail.source,
    sessionId: detail.sessionId,
  } satisfies PrototypeCreateInput);
}
