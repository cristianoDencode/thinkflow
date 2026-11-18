import {
  SECRET_MARKER,
  type TestDataSet,
  type TestDataUpdateInput,
  type TestDefinition,
  type TestStepValue,
} from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';
import type { SessionSecrets } from './session';
import type { RecordingState } from './step-builder';

const isMarker = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as { $secret?: unknown }).$secret === true;

/**
 * Applies the "Dados" table: parameters can be renamed, relabeled or marked secret (they are
 * created and removed with the steps), data sets can be added, renamed, removed and filled.
 * Secret values never stay in the definition: a string sets the secret, the marker keeps it,
 * and a parameter that stops being secret gets its value back in clear text.
 */
export function updateData(state: RecordingState, input: TestDataUpdateInput): RecordingState {
  const current = state.definition;
  const byId = new Map(current.parameters.map((p) => [p.id, p]));
  const ids = input.parameters.map((p) => p.id);
  if (
    ids.length !== byId.size ||
    ids.some((id) => !byId.has(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new DomainError(
      'Os parâmetros vêm dos passos gravados: altere nome, rótulo ou sigilo, sem incluir nem remover.',
      'bad_parameters',
      400,
    );
  }
  const names = input.parameters.map((p) => p.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new DomainError(`Nome de parâmetro repetido: ${dup}`, 'duplicate_parameter', 400);

  const recordedId = current.dataSets[0]!.id;
  if (input.dataSets[0]?.id !== recordedId) {
    throw new DomainError(
      'O conjunto "Gravado" deve continuar sendo o primeiro.',
      'bad_data_sets',
      400,
    );
  }
  const dsIds = input.dataSets.map((d) => d.id);
  if (new Set(dsIds).size !== dsIds.length) {
    throw new DomainError('Conjuntos de dados com o mesmo id.', 'bad_data_sets', 400);
  }

  const secretIds = new Set(input.parameters.filter((p) => p.secret).map((p) => p.id));
  const secrets: SessionSecrets = {};
  const dataSets: TestDataSet[] = input.dataSets.map((ds) => {
    const previous = current.dataSets.find((d) => d.id === ds.id);
    const values: TestDataSet['values'] = {};
    for (const param of input.parameters) {
      const incoming = ds.values[param.id];
      const oldClear = previous?.values[param.id];
      const oldSecret = state.secrets[ds.id]?.[param.id];
      // what the value is now, whatever form it had before
      let value: string | undefined;
      if (typeof incoming === 'string') value = incoming;
      else if (isMarker(incoming))
        value = oldSecret ?? (typeof oldClear === 'string' ? oldClear : undefined);
      if (value === undefined) continue; // falls back to the recorded value at run time
      if (secretIds.has(param.id)) {
        values[param.id] = { ...SECRET_MARKER };
        (secrets[ds.id] ??= {})[param.id] = value;
      } else {
        values[param.id] = value;
      }
    }
    return { id: ds.id, name: ds.name.trim(), values };
  });

  return {
    definition: { ...current, parameters: input.parameters, dataSets },
    secrets,
  };
}

/** parameter id → value for one data set (missing values come from the recorded set). */
export function resolveValues(
  def: TestDefinition,
  secrets: SessionSecrets,
  dataSetId: string | null,
): Record<string, string> {
  const recorded = def.dataSets[0];
  const chosen = def.dataSets.find((d) => d.id === dataSetId) ?? recorded;
  const out: Record<string, string> = {};
  for (const param of def.parameters) {
    const pick = (ds: TestDataSet | undefined): string | undefined => {
      if (!ds) return undefined;
      const v = ds.values[param.id];
      if (typeof v === 'string') return v;
      if (isMarker(v)) return secrets[ds.id]?.[param.id];
      return undefined;
    };
    out[param.id] = pick(chosen) ?? pick(recorded) ?? '';
  }
  return out;
}

export const valueOf = (value: TestStepValue, values: Record<string, string>): string =>
  'literal' in value ? value.literal : (values[value.param] ?? '');
