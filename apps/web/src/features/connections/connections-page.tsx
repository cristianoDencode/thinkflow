import type { ConnectionDto } from '@thinkflow/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { PageHeader, Tabs } from '../../components/ui/card';
import { useCombos, useConnections, useLogs, useProviders } from '../../lib/queries';
import { ActivityTab } from './activity-tab';
import { CombosTab } from './combos-tab';
import { ConnectionDialog } from './connection-dialog';
import { ConnectionsTab } from './connections-tab';

type Tab = 'connections' | 'combos' | 'activity';

export function ConnectionsPage() {
  const [tab, setTab] = useState<Tab>('connections');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionDto | null>(null);
  const [creatingCombo, setCreatingCombo] = useState(false);
  const { data: providers = [] } = useProviders();
  const { data: connections = [] } = useConnections();
  const { data: combos = [] } = useCombos();
  const { data: logs = [] } = useLogs();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Conexões e roteamento"
        description="Cadastre chaves de IA (de preferência gratuitas) e organize-as em combos. Quando uma conexão estoura o limite ou cai, o Thinkflow passa para a próxima automaticamente."
        actions={
          tab === 'combos' ? (
            <Button onClick={() => setCreatingCombo(true)}>
              <Plus className="h-4 w-4" /> Novo combo
            </Button>
          ) : (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Nova conexão
            </Button>
          )
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'connections', label: 'Conexões', count: connections.length },
          { value: 'combos', label: 'Combos', count: combos.length },
          { value: 'activity', label: 'Atividade' },
        ]}
      />
      {tab === 'connections' && (
        <ConnectionsTab
          connections={connections}
          onCreate={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          onEdit={(c) => {
            setEditing(c);
            setDialogOpen(true);
          }}
        />
      )}
      {tab === 'combos' && (
        <CombosTab
          combos={combos}
          connections={connections}
          providers={providers}
          creating={creatingCombo}
          onCreatingChange={setCreatingCombo}
        />
      )}
      {tab === 'activity' && <ActivityTab logs={logs} />}

      <ConnectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        providers={providers}
        editing={editing}
      />
    </div>
  );
}
