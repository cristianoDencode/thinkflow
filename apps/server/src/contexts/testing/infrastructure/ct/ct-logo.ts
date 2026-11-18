import type { CtLayout } from '@thinkflow/shared';
import { imageSize } from '../../domain/image-size';
import { sniffImage } from './ct-style';

/** The model's logo, decoded and sized for the page header (null when the model has none). */
export interface CtLogo {
  bytes: Uint8Array;
  type: 'png' | 'jpg';
  mime: string;
  /** Header size in CSS pixels (height capped, aspect ratio kept). */
  widthPx: number;
  heightPx: number;
  dataUri: string;
}

/** Height of the header logo (about 21 pt) and the widest it may get. */
const MAX_HEIGHT_PX = 28;
const MAX_WIDTH_PX = 180;

/**
 * Decodes `layout.logo` (a validated PNG/JPEG data URL). A logo that cannot be read is ignored:
 * the document is still generated, just without it.
 */
export function ctLogoOf(layout: CtLayout): CtLogo | null {
  const match = layout.logo ? /^data:image\/(?:png|jpeg);base64,(.+)$/.exec(layout.logo) : null;
  if (!match) return null;
  const bytes = new Uint8Array(Buffer.from(match[1]!, 'base64'));
  const sniffed = sniffImage(bytes);
  const natural = imageSize(bytes);
  if (!sniffed || (sniffed.type !== 'png' && sniffed.type !== 'jpg')) return null;
  if (!natural || natural.width < 1 || natural.height < 1) return null;
  const scale = Math.min(MAX_HEIGHT_PX / natural.height, MAX_WIDTH_PX / natural.width);
  return {
    bytes,
    type: sniffed.type,
    mime: sniffed.mime,
    widthPx: Math.max(1, Math.round(natural.width * scale)),
    heightPx: Math.max(1, Math.round(natural.height * scale)),
    dataUri: `data:${sniffed.mime};base64,${Buffer.from(bytes).toString('base64')}`,
  };
}
