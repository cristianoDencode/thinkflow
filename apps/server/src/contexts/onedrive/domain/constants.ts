/** Least privilege for create/upload/list in the user's own drive + a refresh token + profile. */
export const ONEDRIVE_SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'] as const;

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Simple `PUT .../content` up to this size; bigger files use an upload session. */
export const SMALL_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload-session fragments must be multiples of 320 KiB (Microsoft requirement). */
export const CHUNK_UNIT = 320 * 1024;
/** 10 MiB = 32 x 320 KiB (the size Microsoft recommends for stable connections). */
export const DEFAULT_CHUNK_SIZE = 32 * CHUNK_UNIT;
