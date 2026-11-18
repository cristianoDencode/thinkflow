import { z } from 'zod';

/** Integration with a personal OneDrive (Microsoft Graph): connection, default folder and file naming. */

export const ONEDRIVE_DEFAULT_NAMING_PATTERN = 'CT {ticketId} - {title}.docx';

/** The Application (client) ID that Microsoft shows in the app registration is a GUID. */
const CLIENT_ID_PATTERN = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export type OneDriveConnectionState = 'disconnected' | 'connected' | 'reconnect_required';

export interface OneDriveFolderRefDto {
  id: string;
  name: string;
  /** Human-readable path ("/Documentos/Testes"); "/" is the root. */
  path: string;
}

export interface OneDriveStatusDto {
  clientId: string;
  hasClientSecret: boolean;
  /** The exact redirect URI the app uses (derived from the address the browser used, or the override). */
  redirectUri: string;
  /** The manual override, empty when the address is derived. */
  redirectUriOverride: string;
  /** pt-BR hint when the redirect URI will probably not be accepted by Microsoft. */
  redirectUriWarning: string | null;
  state: OneDriveConnectionState;
  account: { name: string; email: string } | null;
  connectedAt: number | null;
  defaultFolder: OneDriveFolderRefDto | null;
  namingPattern: string;
  defaultNamingPattern: string;
  scopes: string[];
}

export const onedriveSettingsUpdateSchema = z.object({
  clientId: z
    .string()
    .trim()
    .max(100)
    .refine((v) => v === '' || CLIENT_ID_PATTERN.test(v), {
      message:
        'O ID do aplicativo (client ID) é um GUID, ex.: 00000000-0000-0000-0000-000000000000',
    })
    .optional(),
  /** New secret; omit/empty keeps the stored one. */
  clientSecret: z.string().trim().max(400).optional(),
  clearClientSecret: z.boolean().optional(),
  namingPattern: z
    .string()
    .trim()
    .min(1, 'Informe o padrão do nome do arquivo')
    .max(200)
    .optional(),
  redirectUriOverride: z
    .string()
    .trim()
    .max(256)
    .refine(
      // no URL class in the shared package (no DOM/Node lib): a plain shape check
      (v) => v === '' || /^https?:\/\/[^\s/?#]+[^\s#]*$/.test(v),
      { message: 'URI de redirecionamento inválido (use http:// ou https://)' },
    )
    .optional(),
});
export type OneDriveSettingsUpdate = z.infer<typeof onedriveSettingsUpdateSchema>;

export const onedriveDefaultFolderSchema = z.object({
  /** null clears the default folder (uploads go to the root of the OneDrive). */
  id: z.string().trim().min(1).max(200).nullable(),
});

export interface OneDriveFolderListingDto {
  parent: OneDriveFolderRefDto & { parentId: string | null };
  folders: { id: string; name: string; childCount: number | null }[];
}

export interface OneDriveConnectStartDto {
  authorizeUrl: string;
}

export const onedriveFileNameSchema = z.object({
  ticketId: z.string().trim().max(100).default(''),
  title: z.string().trim().max(300).default(''),
});
