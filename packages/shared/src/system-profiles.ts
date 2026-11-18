import { ECIDADE_BLOCK_CATEGORY, ECIDADE_WINDOW_TEMPLATE_ID } from './prototypes';

/*
 * System profiles. Thinkflow prototypes screens of legacy web systems (ERPs and in-house
 * corporate systems). A profile is the system-specific part of that: how its screens look, the
 * component palette, the starting window and the prompt material of the assistant. The tool itself
 * is generic; "e-Cidade" (open-source municipal ERP) is the first built-in profile and the only
 * one so far.
 *
 * The component markers (`data-ec` / `data-ec-part`, see ECIDADE_COMPONENT_KINDS) are the shared
 * interchange vocabulary between screen mappers and the editor, whatever the system; they keep
 * the `ec` prefix for historical reasons (see docs/mapper-contract.md).
 *
 * The server holds the profile's prompt material (prototypes/domain/system-profiles.ts); this
 * is the part both sides need.
 */

export interface SystemProfileDto {
  /** Stable id, also accepted as `source.system` by the mapper import. */
  id: string;
  /** Display name (pt-BR). */
  name: string;
  /** One line (pt-BR) about the system and its screens. */
  description: string;
  /** Built-in window template (`GET /api/prototypes/templates`) of the profile. */
  windowTemplateId: string;
  /** Category of the profile's palette in the editor; favorites are saved there. */
  paletteCategory: string;
}

export const DEFAULT_SYSTEM_PROFILE_ID = 'ecidade';

export const SYSTEM_PROFILES: readonly SystemProfileDto[] = [
  {
    id: DEFAULT_SYSTEM_PROFILE_ID,
    name: 'e-Cidade',
    description:
      'ERP municipal de código aberto: telas clássicas em janelas cinza com barra de título azul, fieldsets, campos com rótulo em negrito, lookups e grades.',
    windowTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
    paletteCategory: ECIDADE_BLOCK_CATEGORY,
  },
];

/** The profile with that id (case-insensitive), or undefined when there is none. */
export function findSystemProfile(id: string | null | undefined): SystemProfileDto | undefined {
  const wanted = (id ?? '').trim().toLowerCase();
  return SYSTEM_PROFILES.find((p) => p.id === wanted);
}

/** The default profile (e-Cidade). */
export const defaultSystemProfile = (): SystemProfileDto =>
  findSystemProfile(DEFAULT_SYSTEM_PROFILE_ID)!;
