import {
  placeholdersIn,
  templateInputSchema,
  templateSpecSchema,
  templateTexts,
  type ReportTemplateDto,
  type TemplateInput,
  type TemplateKind,
  type TemplateSection,
  type TemplateSpec,
  type TemplateVariable,
} from '@thinkflow/shared';

/** Editable form state of a template (a full `TemplateInput`, validated on save). */
export interface TemplateDraft {
  name: string;
  kind: TemplateKind;
  description: string;
  spec: TemplateSpec;
}

export function emptyDraft(kind: TemplateKind = 'report'): TemplateDraft {
  return {
    name: '',
    kind,
    description: '',
    spec: templateSpecSchema.parse({ sections: [{ id: 'secao-1', title: 'Introdução' }] }),
  };
}

export function draftFromTemplate(t: ReportTemplateDto): TemplateDraft {
  return { name: t.name, kind: t.kind, description: t.description, spec: t.spec };
}

export function nextSectionId(sections: { id: string }[]): string {
  const taken = new Set(sections.map((s) => s.id));
  for (let n = 1; ; n++) if (!taken.has(`secao-${n}`)) return `secao-${n}`;
}

export function newSection(sections: { id: string }[]): TemplateSection {
  return {
    id: nextSectionId(sections),
    title: '',
    requirements: '',
    diagram: 'none',
    table: 'none',
    maxWords: null,
  };
}

export function newVariable(name = ''): TemplateVariable {
  return {
    name,
    label: name,
    description: '',
    required: false,
    example: '',
    defaultValue: '',
  };
}

/** `{{x}}` placeholders used in the spec's texts that have no variable declared. */
export function undeclaredVariables(spec: TemplateSpec): string[] {
  const declared = new Set(spec.variables.map((v) => v.name));
  const used = new Set<string>();
  for (const text of templateTexts(spec)) for (const n of placeholdersIn(text)) used.add(n);
  return [...used].filter((n) => !declared.has(n));
}

export type DraftValidation =
  | { ok: true; data: TemplateInput }
  | { ok: false; errors: Record<string, string>; messages: string[] };

/** Validates with the same schema as the server; errors are keyed by dotted path (e.g. `spec.sections.0.title`). */
export function validateDraft(draft: TemplateDraft): DraftValidation {
  const result = templateInputSchema.safeParse(draft);
  if (result.success) return { ok: true, data: result.data };
  const errors: Record<string, string> = {};
  const messages: string[] = [];
  for (const issue of result.error.issues) {
    const key = issue.path.join('.');
    if (!(key in errors)) errors[key] = issue.message;
    if (!messages.includes(issue.message)) messages.push(issue.message);
  }
  return { ok: false, errors, messages };
}
