import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDto, ConversationOrigin } from '@thinkflow/shared';
import { History as HistoryIcon, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, PageHeader, Tabs } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import {
  keys,
  useConversations,
  useDatabases,
  useLibraries,
  type ConversationParams,
} from '../../lib/queries';
import { groupByDate } from './group-by-date';
import { ConversationRow, ORIGIN_LABELS } from './history-parts';
import { PERIOD_LABELS, periodRange, type Period } from './period';

type OriginFilter = 'all' | ConversationOrigin;

const PAGE_SIZE = 50;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function HistoryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [databaseId, setDatabaseId] = useState('');
  const [period, setPeriod] = useState<Period>('any');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [renaming, setRenaming] = useState<ConversationDto | null>(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const q = useDebounced(search.trim(), 300);

  const { data: databases = [] } = useDatabases();
  const { data: libraries = [] } = useLibraries();
  const databaseNames = useMemo(() => new Map(databases.map((d) => [d.id, d.name])), [databases]);
  const libraryNames = useMemo(() => new Map(libraries.map((l) => [l.id, l.name])), [libraries]);

  // recomputed only when the choice changes, so the query key stays stable between renders
  const range = useMemo(() => periodRange(period, custom), [period, custom]);
  const connection = origin === 'data' && databaseId ? databaseId : '';

  useEffect(() => setLimit(PAGE_SIZE), [q, origin, connection, range, pinnedOnly]);

  const params: ConversationParams = {
    ...(q ? { q } : {}),
    ...(origin !== 'all' ? { origin } : {}),
    ...(connection ? { databaseId: connection } : {}),
    ...range,
    ...(pinnedOnly ? { pinned: true } : {}),
    limit,
  };
  const { data = [], isLoading, error } = useConversations(params);
  const groups = useMemo(() => groupByDate(data), [data]);
  const filtered = q !== '' || origin !== 'all' || period !== 'any' || pinnedOnly;
  const clearFilters = () => {
    setSearch('');
    setOrigin('all');
    setDatabaseId('');
    setPeriod('any');
    setCustom({ from: '', to: '' });
    setPinnedOnly(false);
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.conversations });

  const openRename = (c: ConversationDto) => {
    setRenaming(c);
    setTitle(c.title);
  };

  const saveRename = async () => {
    if (!renaming || !title.trim()) return;
    setSaving(true);
    try {
      await api.patch(`/api/conversations/${renaming.id}`, { title: title.trim() });
      notify.success('Conversa renomeada');
      setRenaming(null);
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (c: ConversationDto) => {
    try {
      await api.patch(`/api/conversations/${c.id}`, { pinned: !c.pinned });
      notify.success(c.pinned ? 'Conversa desafixada' : 'Conversa fixada');
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const remove = async (c: ConversationDto) => {
    try {
      await api.del(`/api/conversations/${c.id}`);
      notify.success('Conversa excluída');
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Histórico"
        description="Retome uma conversa de onde parou ou derive uma nova."
      />

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por título ou conteúdo…"
          aria-label="Buscar conversas"
          className="pl-9"
        />
      </div>

      <div className="overflow-x-auto">
        <Tabs<OriginFilter>
          value={origin}
          onChange={setOrigin}
          items={[
            { value: 'all', label: 'Todas' },
            { value: 'chat', label: ORIGIN_LABELS.chat },
            { value: 'document', label: 'Documentos' },
            { value: 'agent', label: ORIGIN_LABELS.agent },
            { value: 'data', label: ORIGIN_LABELS.data },
          ]}
        />
      </div>

      <div
        role="group"
        aria-label="Filtros do histórico"
        className="-mt-2 mb-5 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          Período
          <Select
            aria-label="Período"
            className="h-9 w-44"
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </Select>
        </label>
        {period === 'custom' && (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted">
              De
              <Input
                type="date"
                aria-label="Data inicial"
                className="h-9 w-40"
                value={custom.from}
                max={custom.to || undefined}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Até
              <Input
                type="date"
                aria-label="Data final"
                className="h-9 w-40"
                value={custom.to}
                min={custom.from || undefined}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </label>
          </>
        )}
        {origin === 'data' && databases.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Conexão
            <Select
              aria-label="Conexão de banco"
              className="h-9 w-48"
              value={databaseId}
              onChange={(e) => setDatabaseId(e.target.value)}
            >
              <option value="">Todas as conexões</option>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={pinnedOnly} onChange={setPinnedOnly} label="Só fixadas" />
          Só fixadas
        </label>
        {filtered && (
          <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
            <X className="h-3.5 w-3.5" /> Limpar filtros
          </Button>
        )}
      </div>

      {error ? (
        <Card className="p-5 text-sm text-danger">{errorMessage(error)}</Card>
      ) : isLoading ? (
        <Card className="p-5 text-sm text-muted">Carregando…</Card>
      ) : data.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-6 w-6" />}
          title={filtered ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}
          description={
            filtered
              ? 'Tente outro termo de busca, outra origem ou outro período.'
              : 'Suas conversas com o chat, o agente e os dados aparecem aqui para você retomar depois.'
          }
          {...(!filtered && {
            action: <Button onClick={() => navigate('/')}>Iniciar uma conversa</Button>,
          })}
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                {group.label}
              </h2>
              <div className="flex flex-col gap-2">
                {group.items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    databaseName={c.databaseId ? databaseNames.get(c.databaseId) : null}
                    libraryName={c.libraryId ? libraryNames.get(c.libraryId) : null}
                    onContinue={() =>
                      navigate(c.mode === 'data' ? `/dados?c=${c.id}` : `/?c=${c.id}`)
                    }
                    onRename={() => openRename(c)}
                    onTogglePin={() => void togglePin(c)}
                    onDelete={() => void remove(c)}
                  />
                ))}
              </div>
            </section>
          ))}
          {data.length >= limit && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Renomear conversa"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void saveRename()} loading={saving} disabled={!title.trim()}>
              Salvar
            </Button>
          </>
        }
      >
        <Field label="Título" htmlFor="rename-title">
          <Input
            id="rename-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveRename()}
          />
        </Field>
      </Dialog>
    </div>
  );
}
