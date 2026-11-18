import { z } from 'zod';
import { PROTOTYPE_LIMITS } from './prototypes';

/*
 * `POST /api/prototypes/import`: how an external screen mapper (a separate tool that captures
 * screens of a legacy web system) feeds Thinkflow. The payload is versioned; the server treats
 * it exactly like an in-app capture (sanitize + personal-data scrub + component annotation).
 * Full description: docs/mapper-contract.md.
 */

export const PROTOTYPE_IMPORT_FORMAT_VERSION = 1;

/** Sizes are clamped to the editor's limits (like a capture), so only absurd values are refused. */
const importSize = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max * 4);

export const prototypeImportSchema = z.object({
  formatVersion: z.literal(PROTOTYPE_IMPORT_FORMAT_VERSION, {
    error: `formatVersion não suportada: use ${PROTOTYPE_IMPORT_FORMAT_VERSION}.`,
  }),
  name: z.string().trim().min(1).max(120),
  snapshot: z.object({
    /** Self-contained `<body …>` markup (or a full document: only the body is kept). */
    html: z.string().min(1),
    css: z.string().default(''),
    width: importSize(PROTOTYPE_LIMITS.maxWidth),
    height: importSize(PROTOTYPE_LIMITS.maxHeight),
  }),
  source: z
    .object({
      /** Page URL; the query string is dropped. */
      url: z.string().max(2000).nullable().optional(),
      title: z.string().max(300).nullable().optional(),
      /** Menu trail of the screen, e.g. "Financeiro > Empenho > Consulta". */
      menuPath: z.string().max(1000).nullable().optional(),
      /** Routine/source file, when the mapper knows it (otherwise derived from `.php` URLs). */
      file: z.string().max(300).nullable().optional(),
      /** System profile id (`ecidade`) or any other label; unknown ones get the generic heuristics. */
      system: z.string().trim().max(60).nullable().optional(),
    })
    .optional(),
  /** Keep typed values and grid cells. Default false: they are scrubbed (LGPD). */
  keepData: z.boolean().default(false),
});
export type PrototypeImportInput = z.infer<typeof prototypeImportSchema>;
