import {
  SECRET_MARKER,
  TEST_LIMITS,
  type TestDefinition,
  type TestParameter,
  type TestStep,
  type TestTarget,
} from '@thinkflow/shared';
import { describeElement, isEmptySpaceTarget, rankLocators } from './locators';
import type { ElementFacts, EventPage, RecorderEvent } from './recorder-events';
import type { SessionSecrets } from './session';

export interface RecordingState {
  definition: TestDefinition;
  secrets: SessionSecrets;
}

export interface ApplyResult extends RecordingState {
  /** Step created or updated by the event (null when the event was ignored). */
  stepId: string | null;
  change: 'added' | 'updated' | 'ignored';
}

/** `E-mail do titular` → `email_do_titular`; always a valid parameter name. */
export function parameterName(label: string, taken: Iterable<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'campo';
  const safe = /^[a-z]/.test(base) ? base : `campo_${base}`.slice(0, 40);
  const used = new Set(taken);
  if (!used.has(safe)) return safe;
  for (let i = 2; ; i++) {
    const candidate = `${safe}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function targetFromFacts(facts: ElementFacts): TestTarget | null {
  const locators = rankLocators(facts.candidates);
  if (locators.length === 0) return null;
  return {
    locators,
    description: describeElement(facts),
    bbox: facts.bbox,
    frameUrl: facts.frameUrl,
  };
}

const sameElement = (a: TestTarget | null, b: TestTarget | null): boolean =>
  !!a &&
  !!b &&
  a.frameUrl === b.frameUrl &&
  JSON.stringify(a.locators[0]) === JSON.stringify(b.locators[0]);

const baseStep = (id: string, at: number, page: EventPage | null) => ({
  id,
  at,
  page,
  comment: null,
});

const RECORDED = (def: TestDefinition) => def.dataSets[0]!.id;

/** Records `value` as the recorded data set's value of `param` (secrets go to `secrets`). */
function setRecordedValue(
  state: RecordingState,
  param: TestParameter,
  value: string,
): RecordingState {
  const recordedId = RECORDED(state.definition);
  const dataSets = state.definition.dataSets.map((d, i) =>
    i === 0
      ? { ...d, values: { ...d.values, [param.id]: param.secret ? { ...SECRET_MARKER } : value } }
      : d,
  );
  const secrets = param.secret
    ? {
        ...state.secrets,
        [recordedId]: { ...(state.secrets[recordedId] ?? {}), [param.id]: value },
      }
    : state.secrets;
  return { definition: { ...state.definition, dataSets }, secrets };
}

/**
 * Turns one event of the recorded browser into steps, keeping them clean: typing becomes a single
 * `fill` with the final value, a double click replaces the two clicks it produced, every typed or
 * chosen value becomes a parameter (secrets kept apart, encrypted by the repository).
 */
export function applyRecorderEvent(
  state: RecordingState,
  event: RecorderEvent,
  page: EventPage | null,
  newId: () => string,
): ApplyResult {
  const def = state.definition;
  const steps = def.steps;
  const last = steps.at(-1) ?? null;
  const ignored: ApplyResult = { ...state, stepId: null, change: 'ignored' };
  const add = (next: RecordingState, step: TestStep): ApplyResult => {
    if (next.definition.steps.length >= TEST_LIMITS.maxSteps) return ignored;
    return {
      ...next,
      definition: { ...next.definition, steps: [...next.definition.steps, step] },
      stepId: step.id,
      change: 'added',
    };
  };

  if (event.type === 'navigate') {
    if (last?.kind === 'goto' && last.url === event.url) return ignored;
    return add(state, {
      ...baseStep(newId(), event.at, page),
      kind: 'goto',
      url: event.url,
      target: null,
    });
  }

  const target = event.facts ? targetFromFacts(event.facts) : null;

  switch (event.type) {
    case 'click':
      if (!target || isEmptySpaceTarget(target)) return ignored;
      return add(state, { ...baseStep(newId(), event.at, page), kind: 'click', target });

    case 'dblclick': {
      if (!target || isEmptySpaceTarget(target)) return ignored;
      // the browser reports click, click, dblclick: keep only the double click
      let trimmed = steps;
      for (let i = 0; i < 2; i++) {
        const tail = trimmed.at(-1);
        if (tail?.kind === 'click' && sameElement(tail.target, target))
          trimmed = trimmed.slice(0, -1);
      }
      const next = { ...state, definition: { ...def, steps: trimmed } };
      return add(next, { ...baseStep(newId(), event.at, page), kind: 'dblclick', target });
    }

    case 'check':
    case 'uncheck':
      if (!target) return ignored;
      return add(state, { ...baseStep(newId(), event.at, page), kind: event.type, target });

    case 'press':
      return add(state, {
        ...baseStep(newId(), event.at, page),
        kind: 'press',
        key: event.key,
        target: target ?? null,
      } as TestStep);

    case 'fill':
    case 'select': {
      if (!target) return ignored;
      // typing again in the same field right after: update the value instead of a new step
      if (
        event.type === 'fill' &&
        last?.kind === 'fill' &&
        sameElement(last.target, target) &&
        last.value &&
        'param' in last.value
      ) {
        const param = def.parameters.find((p) => p.id === (last.value as { param: string }).param);
        if (param) {
          const next = setRecordedValue(state, param, event.value);
          const updated = next.definition.steps.map((s) =>
            s.id === last.id ? { ...s, at: event.at, page: page ?? s.page } : s,
          );
          return {
            ...next,
            definition: { ...next.definition, steps: updated },
            stepId: last.id,
            change: 'updated',
          };
        }
      }
      if (def.parameters.length >= TEST_LIMITS.maxParameters) {
        // too many parameters: keep the value literal (never for secrets)
        if (event.facts.secret) return ignored;
        return add(state, {
          ...baseStep(newId(), event.at, page),
          kind: event.type,
          target,
          value: { literal: event.value },
        });
      }
      const label = event.facts.label || event.facts.name || event.facts.fieldName || '';
      const param: TestParameter = {
        id: newId(),
        name: parameterName(
          label || event.facts.fieldName || 'campo',
          def.parameters.map((p) => p.name),
        ),
        label: (label || 'Campo').slice(0, 200),
        type: event.facts.secret ? 'password' : event.type === 'select' ? 'option' : 'text',
        secret: event.facts.secret,
      };
      const withParam = setRecordedValue(
        { ...state, definition: { ...def, parameters: [...def.parameters, param] } },
        param,
        event.value,
      );
      return add(withParam, {
        ...baseStep(newId(), event.at, page),
        kind: event.type,
        target,
        value: { param: param.id },
      });
    }
  }
}

/** Parameters no step refers to anymore (after deleting steps) are dropped, with their values. */
export function pruneParameters(state: RecordingState): RecordingState {
  const used = new Set<string>();
  for (const step of state.definition.steps) {
    if (step.value && 'param' in step.value) used.add(step.value.param);
    const a = step.assertion;
    if (a?.type === 'value' && 'param' in a.value) used.add(a.value.param);
  }
  const parameters = state.definition.parameters.filter((p) => used.has(p.id));
  if (parameters.length === state.definition.parameters.length) return state;
  const keep = (values: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(values).filter(([k]) => used.has(k)));
  return {
    definition: {
      ...state.definition,
      parameters,
      dataSets: state.definition.dataSets.map((d) => ({
        ...d,
        values: keep(d.values) as typeof d.values,
      })),
    },
    secrets: Object.fromEntries(
      Object.entries(state.secrets).map(([ds, values]) => [
        ds,
        keep(values) as Record<string, string>,
      ]),
    ),
  };
}

const MAX_ASSERT_TEXT = 200;

/** Page-level checks taken from the page the user is on (URL path, title). */
export function applyPageAssertion(
  state: RecordingState,
  type: 'urlContains' | 'title',
  page: EventPage,
  newId: () => string,
  at: number,
): ApplyResult {
  const def = state.definition;
  let text = page.title.trim();
  if (type === 'urlContains') {
    try {
      const url = new URL(page.url);
      text = url.pathname + url.search;
    } catch {
      text = page.url;
    }
  }
  if (!text || def.steps.length >= TEST_LIMITS.maxSteps)
    return { ...state, stepId: null, change: 'ignored' };
  const step: TestStep = {
    ...baseStep(newId(), at, page),
    kind: 'assert',
    assertion: { type, text: text.slice(0, MAX_ASSERT_TEXT * 5) },
    target: null,
  };
  return {
    ...state,
    definition: { ...def, steps: [...def.steps, step] },
    stepId: step.id,
    change: 'added',
  };
}
