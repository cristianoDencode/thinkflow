import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OneDriveConnectStartDto,
  OneDriveFolderListingDto,
  OneDriveSettingsUpdate,
  OneDriveStatusDto,
} from '@thinkflow/shared';
import { api } from '../../lib/api';

const BASE = '/api/integrations/onedrive';
export const onedriveKey = ['integrations', 'onedrive'] as const;

export const useOneDriveStatus = () =>
  useQuery({
    queryKey: onedriveKey,
    queryFn: () => api.get<OneDriveStatusDto>(BASE),
    retry: false,
  });

/** Every mutation answers with the fresh status, which replaces the cache. */
function useStatusMutation<V>(fn: (variables: V) => Promise<OneDriveStatusDto>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => queryClient.setQueryData(onedriveKey, data),
  });
}

export const useSaveOneDriveSettings = () =>
  useStatusMutation((update: OneDriveSettingsUpdate) => api.put<OneDriveStatusDto>(BASE, update));

export const useDisconnectOneDrive = () =>
  useStatusMutation(() => api.post<OneDriveStatusDto>(`${BASE}/disconnect`));

export const useSetOneDriveFolder = () =>
  useStatusMutation((id: string | null) =>
    api.put<OneDriveStatusDto>(`${BASE}/default-folder`, { id }),
  );

export const startOneDriveConnect = () => api.post<OneDriveConnectStartDto>(`${BASE}/connect`);

/** Subfolders of `parentId` (null = the OneDrive root). */
export const useOneDriveFolders = (parentId: string | null, enabled: boolean) =>
  useQuery({
    queryKey: [...onedriveKey, 'folders', parentId],
    queryFn: () =>
      api.get<OneDriveFolderListingDto>(
        parentId ? `${BASE}/folders?parentId=${encodeURIComponent(parentId)}` : `${BASE}/folders`,
      ),
    enabled,
    retry: false,
    staleTime: 10_000,
  });
