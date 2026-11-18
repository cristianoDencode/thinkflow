import { Plus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { PageHeader, Tabs } from '../../components/ui/card';
import { ReportsList } from './reports-list';
import { TemplatesTab } from './templates-tab';

type Tab = 'generated' | 'templates';

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'modelos' ? 'templates' : 'generated';

  const changeTab = (next: Tab) =>
    setParams(next === 'templates' ? { tab: 'modelos' } : {}, { replace: true });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Relatórios"
        description="Documentos gerados pela IA a partir de modelos, com pesquisa nas suas fontes (MCP e Biblioteca)."
        actions={
          tab === 'templates' ? (
            <Link to="/reports/templates/new">
              <Button tabIndex={-1}>
                <Plus className="h-4 w-4" /> Novo modelo
              </Button>
            </Link>
          ) : undefined
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={changeTab}
        items={[
          { value: 'generated', label: 'Relatórios gerados' },
          { value: 'templates', label: 'Modelos' },
        ]}
      />
      {tab === 'generated' ? <ReportsList /> : <TemplatesTab />}
    </div>
  );
}
