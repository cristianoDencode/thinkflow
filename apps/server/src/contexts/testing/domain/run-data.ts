import type { TestDefinition, TestRunDataDto, TestRunRerunDto } from '@thinkflow/shared';
import { resolveValues } from './data';
import type { RunDataSnapshot, SessionSecrets, TestRun } from './session';

/** The data of `dataSetId` as it is right now (what a run starting now will use). */
export function snapshotRunData(
  def: TestDefinition,
  secrets: SessionSecrets,
  dataSetId: string | null,
): RunDataSnapshot {
  const resolved = resolveValues(def, secrets, dataSetId);
  const dataSet = def.dataSets.find((d) => d.id === dataSetId) ?? def.dataSets[0];
  const snapshot: RunDataSnapshot = {
    dataSetName: dataSet?.name ?? '',
    parameters: def.parameters.map((p) => ({ id: p.id, label: p.label, secret: p.secret })),
    values: {},
    secrets: {},
  };
  for (const p of def.parameters) {
    (p.secret ? snapshot.secrets : snapshot.values)[p.id] = resolved[p.id] ?? '';
  }
  return snapshot;
}

/** parameter id → value, as the runner wants them. */
export const snapshotValues = (s: RunDataSnapshot): Record<string, string> => ({
  ...s.values,
  ...s.secrets,
});

/** The data for the screen: secret values masked. */
export function toRunDataDto(s: RunDataSnapshot): TestRunDataDto {
  return {
    dataSetName: s.dataSetName,
    entries: s.parameters.map((p) => ({
      paramId: p.id,
      label: p.label,
      secret: p.secret,
      value: p.secret ? null : (s.values[p.id] ?? ''),
    })),
  };
}

export interface RerunPlan {
  /** What the reproduction will use (the run's snapshot, or today's data of its data set). */
  snapshot: RunDataSnapshot | null;
  /** Today's values filling parameters the snapshot does not know. */
  values: Record<string, string>;
  dto: TestRunRerunDto;
}

const list = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');

/**
 * What reproducing `run` means today. With a snapshot the run's own data is used, whatever was
 * edited since (the differences are reported as warnings); without one (old runs) the current
 * values of the run's data set are used, which the screen says.
 */
export function planRerun(run: TestRun, def: TestDefinition, secrets: SessionSecrets): RerunPlan {
  const current = def.dataSets.find((d) => d.id === run.dataSetId);
  if (!run.snapshot) {
    if (!current) {
      return {
        snapshot: null,
        values: {},
        dto: {
          source: 'current',
          possible: false,
          notice:
            'A execução original não guardou os dados e o conjunto de dados dela foi removido: não há como reproduzi-la.',
          warnings: [],
        },
      };
    }
    const snapshot = snapshotRunData(def, secrets, current.id);
    return {
      snapshot,
      values: snapshotValues(snapshot),
      dto: {
        source: 'current',
        possible: true,
        notice: `Valores atuais do conjunto "${current.name}": a execução original não guardou os dados.`,
        warnings: [],
      },
    };
  }

  const snap = run.snapshot;
  const now = snapshotRunData(def, secrets, current ? current.id : null);
  const nowIds = new Set(now.parameters.map((p) => p.id));
  const snapIds = new Set(snap.parameters.map((p) => p.id));
  const warnings: string[] = [];
  if (!current) {
    warnings.push(
      `O conjunto "${snap.dataSetName}" foi removido desde esta execução; a reprodução usa os dados que ela tinha.`,
    );
  } else if (current.name !== snap.dataSetName) {
    warnings.push(`O conjunto "${snap.dataSetName}" agora se chama "${current.name}".`);
  }
  const removed = snap.parameters.filter((p) => !nowIds.has(p.id)).map((p) => p.label);
  if (removed.length > 0) {
    warnings.push(`Dados que não existem mais nos passos: ${list(removed)} (valores da execução).`);
  }
  const added = now.parameters.filter((p) => !snapIds.has(p.id)).map((p) => p.label);
  if (added.length > 0) {
    warnings.push(`Dados novos desde esta execução, que usam o valor atual: ${list(added)}.`);
  }
  if (current) {
    const nowValues = snapshotValues(now);
    const nowSecretIds = new Set(now.parameters.filter((p) => p.secret).map((p) => p.id));
    const snapValues = snapshotValues(snap);
    const changed = snap.parameters
      .filter(
        (p) =>
          nowIds.has(p.id) &&
          (snapValues[p.id] ?? '') !== (nowValues[p.id] ?? '') &&
          nowSecretIds.has(p.id) === p.secret,
      )
      .map((p) => p.label);
    if (changed.length > 0) {
      warnings.push(
        `Valores alterados desde esta execução: ${list(changed)}; a reprodução usa os da execução.`,
      );
    }
  }
  return {
    snapshot: snap,
    // parameters created after the run have no snapshot value: today's one fills in
    values: { ...snapshotValues(now), ...snapshotValues(snap) },
    dto: { source: 'snapshot', possible: true, notice: null, warnings },
  };
}
