import { useQueryClient } from '@tanstack/react-query';
import type { TestSessionDto } from '@thinkflow/shared';
import { useState } from 'react';
import { errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';

/**
 * Runs a call that returns the updated session: the detail cache gets the fresh copy right away
 * (no flicker while the refetch happens) and every test query is refreshed.
 */
export function useSessionAction(sessionId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (
    name: string,
    fn: () => Promise<TestSessionDto | unknown>,
    success?: string,
  ): Promise<boolean> => {
    setBusy(name);
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'definition' in result) {
        queryClient.setQueryData([...keys.tests, 'detail', sessionId], result);
      }
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      if (success) notify.success(success);
      return true;
    } catch (err) {
      notify.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { busy, run };
}
