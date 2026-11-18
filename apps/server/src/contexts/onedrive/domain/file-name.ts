import { ONEDRIVE_DEFAULT_NAMING_PATTERN } from '@thinkflow/shared';

const stripControl = (text: string): string =>
  Array.from(text)
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('');
const ILLEGAL = /[\\/:*?"<>|]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
export const MAX_FILE_NAME_LENGTH = 150;

/** Replaces what OneDrive rejects (\ / : * ? " < > |, control chars), trims and caps the length. */
export function sanitizeFileName(raw: string, fallback = 'documento'): string {
  let name = stripControl(raw.normalize('NFC'))
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim();
  // a name cannot end in "." or " " and cannot start with " "
  name = name.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  const cappedStem =
    stem.length > MAX_FILE_NAME_LENGTH - ext.length
      ? stem.slice(0, MAX_FILE_NAME_LENGTH - ext.length).trim()
      : stem;
  name = (cappedStem.replace(/[. ]+$/, '') || fallback) + ext;
  if (RESERVED.test(name) || name.toLowerCase().startsWith('_vti_')) name = `_${name}`;
  return name;
}

export interface NamingVars {
  ticketId: string;
  title: string;
}

/**
 * Applies the naming pattern (`{ticketId}`, `{title}`), sanitizes the result and guarantees the
 * `.docx` extension. Empty variables leave no dangling " - ".
 */
export function buildFileName(
  pattern: string | undefined,
  vars: NamingVars,
  extension = '.docx',
): string {
  const source = pattern?.trim() ? pattern : ONEDRIVE_DEFAULT_NAMING_PATTERN;
  let text = source
    .replace(/\{ticketId\}/g, vars.ticketId.trim())
    .replace(/\{title\}/g, vars.title.trim());
  // an empty variable at the end ("CT 1 - " + ".docx") would leave " - " before the extension
  text = text.replace(/\s*[-–]\s*(\.[A-Za-z0-9]{1,5})$/, '$1');
  text = text.replace(/\s*[-–]\s*$/, '');
  const clean = sanitizeFileName(text);
  return clean.toLowerCase().endsWith(extension.toLowerCase())
    ? clean
    : sanitizeFileName(clean + extension);
}

/** "name.docx" -> "name (2).docx", "name (3).docx", ... */
export function withCounter(fileName: string, counter: number): string {
  if (counter <= 1) return fileName;
  const dot = fileName.lastIndexOf('.');
  const hasExt = dot > 0 && fileName.length - dot <= 6;
  const stem = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : '';
  return `${stem} (${counter})${ext}`;
}
