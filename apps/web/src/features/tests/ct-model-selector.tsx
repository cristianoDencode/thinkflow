import { useQueryClient } from '@tanstack/react-query';
import type { CtStateDto } from '@thinkflow/shared';
import { Palette } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { CtModelsDialog } from './ct-models-dialog';
import { useCtModels } from './ct-models';
import { ctBase, ctKey } from './ct-state';

/** Picks the model (look) of the session's document and opens the "Modelos" manager. */
export function CtModelSelector({
  sessionId,
  modelId,
  disabled,
  onChanged,
}: {
  sessionId: string;
  modelId: string;
  disabled: boolean;
  onChanged(): void;
}) {
  const queryClient = useQueryClient();
  const { models } = useCtModels();
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async (id: string) => {
    setBusy(true);
    try {
      const state = await api.put<CtStateDto>(`${ctBase(sessionId)}/model`, { modelId: id });
      queryClient.setQueryData(ctKey(sessionId), state);
      onChanged();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="ct-model-select" className="text-sm font-medium">
        Modelo
      </label>
      <Select
        id="ct-model-select"
        className="h-10 w-auto min-w-40"
        value={models.some((m) => m.id === modelId) ? modelId : 'default'}
        disabled={disabled || busy}
        onChange={(e) => void choose(e.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </Select>
      <Button variant="secondary" onClick={() => setManaging(true)}>
        <Palette className="h-4 w-4" /> Modelos…
      </Button>
      {managing && (
        <CtModelsDialog
          open
          currentId={modelId}
          onClose={() => {
            setManaging(false);
            // the model in use may have been edited or deleted
            void queryClient.invalidateQueries({ queryKey: ctKey(sessionId) });
            onChanged();
          }}
        />
      )}
    </div>
  );
}
