import { useCallback, useState } from 'react';

/** "Lista" = the steps with their comments; "Imagens" = a gallery of every step's print. */
export type StepsView = 'list' | 'images';
/** "Só verificações" keeps the `checkpoint` steps ("Verificar" while recording). */
export type StepsFilter = 'all' | 'checks';

export interface StepsViewState {
  view: StepsView;
  filter: StepsFilter;
}

const KEY = 'thinkflow-steps-view';
const DEFAULT: StepsViewState = { view: 'list', filter: 'all' };

/** Per browser; a blocked or corrupt storage just means the defaults. */
export function readStepsView(): StepsViewState {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<StepsViewState> | null;
    return {
      view: stored?.view === 'images' ? 'images' : 'list',
      filter: stored?.filter === 'checks' ? 'checks' : 'all',
    };
  } catch {
    return DEFAULT;
  }
}

function writeStepsView(state: StepsViewState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // the choice just does not persist
  }
}

export function useStepsView() {
  const [state, setState] = useState<StepsViewState>(readStepsView);
  const update = useCallback((patch: Partial<StepsViewState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeStepsView(next);
      return next;
    });
  }, []);
  return {
    ...state,
    setView: (view: StepsView) => update({ view }),
    setFilter: (filter: StepsFilter) => update({ filter }),
  };
}
