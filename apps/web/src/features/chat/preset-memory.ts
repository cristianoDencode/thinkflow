import type { TemplateKind } from '@thinkflow/shared';

const KEY = 'thinkflow-preset-last';

/** Last template the user picked for each kind of document (per browser). */
export function lastPresetTemplate(kind: TemplateKind): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const id = stored[kind];
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export function rememberPresetTemplate(kind: TemplateKind, templateId: string): void {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(KEY, JSON.stringify({ ...stored, [kind]: templateId }));
  } catch {
    // ignore
  }
}
