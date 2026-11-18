import {
  ECIDADE_WINDOW_TEMPLATE_ID,
  type PrototypeSnapshot,
  BUILTIN_TEMPLATE_PREFIX,
} from '@thinkflow/shared';
import ecidadeWindow from '../../../../assets/prototypes/ecidade-window.json';

/*
 * Built-in templates ("modelos") shipped with the app. Their HTML/CSS is a static asset
 * (`apps/server/assets/prototypes/*.json`, images inlined as data URIs, no personal data): they
 * are never stored in the database, only copied into a new prototype when someone starts from one.
 */

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  snapshot: PrototypeSnapshot;
  /** Sizes offered when starting from it; the first is the default. */
  sizes: { width: number; height: number }[];
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: ECIDADE_WINDOW_TEMPLATE_ID,
    name: ecidadeWindow.name,
    description: ecidadeWindow.description,
    snapshot: {
      html: ecidadeWindow.html,
      css: ecidadeWindow.css,
      width: ecidadeWindow.width,
      height: ecidadeWindow.height,
    },
    sizes: [
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ],
  },
];

export const isBuiltinTemplateId = (id: string): boolean => id.startsWith(BUILTIN_TEMPLATE_PREFIX);

export const findBuiltinTemplate = (id: string): BuiltinTemplate | undefined =>
  BUILTIN_TEMPLATES.find((t) => t.id === id);
