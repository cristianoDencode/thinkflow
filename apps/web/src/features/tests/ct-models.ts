import { useQuery } from '@tanstack/react-query';
import {
  CT_DEFAULT_MODEL_ID,
  DEFAULT_CT_LAYOUT,
  type CtLayout,
  type CtModelDto,
} from '@thinkflow/shared';
import { api } from '../../lib/api';
import { keys } from '../../lib/queries';

export const CT_MODELS_URL = '/api/tests/ct-models';

/** Under `keys.tests`, next to the CT state. */
export const ctModelsKey = [...keys.tests, 'ct-models'] as const;

/** "Padrão" is always there, also while the list loads or when it fails. */
const FALLBACK: CtModelDto[] = [
  {
    id: CT_DEFAULT_MODEL_ID,
    name: 'Padrão',
    builtIn: true,
    layout: DEFAULT_CT_LAYOUT,
    createdAt: 0,
    updatedAt: 0,
  },
];

export function useCtModels() {
  const query = useQuery({
    queryKey: ctModelsKey,
    queryFn: () => api.get<CtModelDto[]>(CT_MODELS_URL),
  });
  return { ...query, models: query.data ?? FALLBACK };
}

/** What the editor works on: a saved model (id) or a new / AI draft (id null). */
export interface CtModelDraft {
  id: string | null;
  name: string;
  layout: CtLayout;
  builtIn: boolean;
  /** Short note shown above the form (e.g. the AI's explanation). */
  note?: string;
}

export const draftOf = (model: CtModelDto): CtModelDraft => ({
  id: model.id,
  name: model.name,
  layout: model.layout,
  builtIn: model.builtIn,
});

export const newDraft = (
  name = 'Novo modelo',
  layout: CtLayout = DEFAULT_CT_LAYOUT,
): CtModelDraft => ({
  id: null,
  name,
  layout,
  builtIn: false,
});
