import {
  placeholdersIn,
  templateTexts,
  type ReportTemplateSummaryDto,
  type TemplateKind,
  type TemplateSpec,
} from '@thinkflow/shared';

export type { TemplateKind, TemplateSpec };

export interface ReportTemplate {
  id: string;
  name: string;
  kind: TemplateKind;
  description: string;
  builtIn: boolean;
  /** Seeds are upgraded at boot when the code's version is higher than the stored one. */
  builtInVersion: number | null;
  spec: TemplateSpec;
  createdAt: number;
  updatedAt: number;
}

/** Replaces `{{name}}` with the value; placeholders without a value are kept as they are. */
export function renderTemplateText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,39})\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : whole,
  );
}

/** Names of every `{{variable}}` the spec uses, in order of first appearance. */
export function referencedVariables(spec: TemplateSpec): string[] {
  const names = new Set<string>();
  for (const text of templateTexts(spec)) for (const name of placeholdersIn(text)) names.add(name);
  return [...names];
}

/** Applies defaults: every declared variable gets the given (trimmed) value, else its default, else ''. */
export function resolveVariables(
  spec: TemplateSpec,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of spec.variables) {
    const given = (values[v.name] ?? '').trim();
    out[v.name] = given || v.defaultValue;
  }
  return out;
}

/** Required variables with neither a value nor a default. */
export function missingVariables(spec: TemplateSpec, values: Record<string, string>): string[] {
  const resolved = resolveVariables(spec, values);
  return spec.variables.filter((v) => v.required && !resolved[v.name]).map((v) => v.name);
}

export function resolveTitle(
  spec: TemplateSpec,
  vars: Record<string, string>,
  fallbackName: string,
): string {
  const title = renderTemplateText(spec.titlePattern, vars).replace(/\s+/g, ' ').trim();
  return title || fallbackName;
}

export function templateSummary(t: ReportTemplate): ReportTemplateSummaryDto {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    description: t.description,
    builtIn: t.builtIn,
    sectionCount: t.spec.sections.length,
    variableCount: t.spec.variables.length,
    usesMcp: t.spec.research.useMcp,
    theme: t.spec.layout.theme,
    primaryColor: t.spec.layout.primaryColor,
    updatedAt: t.updatedAt,
  };
}

/** "Nome (cópia)", then "Nome (cópia 2)"… until `taken` has no clash; the result fits in 120 chars. */
export function copyName(name: string, taken: (candidate: string) => boolean): string {
  const base = name.replace(/ \(cópia(?: \d+)?\)$/, '');
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? ' (cópia)' : ` (cópia ${n})`;
    const candidate = `${base.slice(0, 120 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base.slice(0, 100)} (cópia ${Date.now()})`.slice(0, 120);
}
