import { notify } from '../../lib/notify';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import type { ComboDto, ComboStrategy, ConnectionDto, ProviderDto } from '@thinkflow/shared';
import { ArrowRight, GripVertical, Pencil, Plus, Trash2, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton, Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys } from '../../lib/queries';

interface DraftTarget {
  key: string;
  providerId: string;
  model: string;
  connectionId: string;
}

let keySeq = 0;
const newKey = () => `t${++keySeq}`;

export function CombosTab({
  combos,
  connections,
  providers,
  creating,
  onCreatingChange,
}: {
  combos: ComboDto[];
  connections: ConnectionDto[];
  providers: ProviderDto[];
  creating: boolean;
  onCreatingChange(open: boolean): void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ComboDto | null>(null);
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  const remove = async (combo: ComboDto) => {
    try {
      await api.del(`/api/combos/${combo.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.combos });
      await queryClient.invalidateQueries({ queryKey: keys.models });
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <>
      {combos.length === 0 ? (
        <EmptyState
          icon={<Workflow className="h-6 w-6" />}
          title="Nenhum combo"
          description='Um combo é um "modelo virtual" com uma lista ordenada de provider/modelo. Se o primeiro falhar (limite, cota, fora do ar), o próximo é usado automaticamente.'
          action={<Button onClick={() => onCreatingChange(true)}>Criar combo</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {combos.map((combo) => (
            <Card key={combo.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-sm font-semibold">{combo.name}</code>
                    <Badge tone="accent">
                      {combo.strategy === 'priority' ? 'prioridade' : 'revezamento'}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    {combo.targets.map((t, i) => (
                      <span
                        key={`${t.providerId}-${t.model}-${i}`}
                        className="flex items-center gap-1.5"
                      >
                        {i > 0 && <ArrowRight className="h-3 w-3 text-subtle" aria-hidden />}
                        <span className="rounded-lg bg-surface-2 px-2 py-1">
                          {providerName(t.providerId)} ·{' '}
                          <span className="font-mono">{t.model}</span>
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing(combo)}
                    aria-label={`Editar ${combo.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <ConfirmButton
                    label={`Excluir ${combo.name}`}
                    onConfirm={() => void remove(combo)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <ComboDialog
        open={creating || !!editing}
        editing={editing}
        connections={connections}
        providers={providers}
        onClose={() => {
          setEditing(null);
          onCreatingChange(false);
        }}
      />
    </>
  );
}

function ComboDialog({
  open,
  editing,
  connections,
  providers,
  onClose,
}: {
  open: boolean;
  editing: ComboDto | null;
  connections: ConnectionDto[];
  providers: ProviderDto[];
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<ComboStrategy>('priority');
  const [targets, setTargets] = useState<DraftTarget[]>([]);
  const [saving, setSaving] = useState(false);
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const providerOptions = useMemo(() => {
    const withConnections = new Set(connections.map((c) => c.providerId));
    return providers.filter((p) => withConnections.has(p.id));
  }, [connections, providers]);

  // Initialise the draft only when the dialog opens; connections refetch in the background.
  const initRef = useRef({ connections, providers });
  initRef.current = { connections, providers };
  useEffect(() => {
    if (!open) return;
    const { connections, providers } = initRef.current;
    setName(editing?.name ?? 'thinkflow/default');
    setStrategy(editing?.strategy ?? 'priority');
    setTargets(
      editing
        ? editing.targets.map((t) => ({
            key: newKey(),
            providerId: t.providerId,
            model: t.model,
            connectionId: t.connectionId ?? '',
          }))
        : connections
            .filter((c) => c.enabled)
            .slice(0, 3)
            .map((c) => ({
              key: newKey(),
              providerId: c.providerId,
              model:
                c.defaultModel ||
                providers.find((p) => p.id === c.providerId)?.suggestedModels[0]?.id ||
                '',
              connectionId: '',
            })),
    );
  }, [open, editing]);

  const loadModels = async (providerId: string) => {
    if (liveModels[providerId]) return;
    const connection = connections.find((c) => c.providerId === providerId && c.enabled);
    if (!connection) return;
    try {
      const models = await api.get<string[]>(`/api/connections/${connection.id}/models`);
      setLiveModels((prev) => ({ ...prev, [providerId]: models }));
    } catch {
      setLiveModels((prev) => ({ ...prev, [providerId]: [] }));
    }
  };

  const update = (key: string, patch: Partial<DraftTarget>) =>
    setTargets((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setTargets((prev) => {
      const from = prev.findIndex((t) => t.key === active.id);
      const to = prev.findIndex((t) => t.key === over.id);
      return arrayMove(prev, from, to);
    });
  };

  const submit = async () => {
    setSaving(true);
    try {
      const body = {
        name,
        strategy,
        targets: targets
          .filter((t) => t.providerId && t.model.trim())
          .map((t) => ({
            providerId: t.providerId,
            model: t.model.trim(),
            connectionId: t.connectionId || null,
          })),
      };
      if (editing) await api.put(`/api/combos/${editing.id}`, body);
      else await api.post('/api/combos', body);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.combos }),
        queryClient.invalidateQueries({ queryKey: keys.models }),
      ]);
      notify.success('Combo salvo');
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? 'Editar combo' : 'Novo combo'}
      description="Arraste para definir a ordem de tentativa. Use o nome do combo como modelo no chat, no Claude Code ou em qualquer cliente OpenAI."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={targets.length === 0}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
          <Field label="Nome (usado como modelo)" htmlFor="combo-name">
            <Input
              id="combo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="thinkflow/default"
            />
          </Field>
          <Field label="Estratégia" htmlFor="combo-strategy">
            <Select
              id="combo-strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ComboStrategy)}
            >
              <option value="priority">Prioridade (ordem)</option>
              <option value="round-robin">Revezamento</option>
            </Select>
          </Field>
        </div>

        {providerOptions.length === 0 && (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            Cadastre ao menos uma conexão antes de criar um combo.
          </p>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={targets.map((t) => t.key)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-2">
              {targets.map((t, index) => (
                <SortableTarget
                  key={t.key}
                  target={t}
                  index={index}
                  providers={providerOptions}
                  connections={connections.filter((c) => c.providerId === t.providerId)}
                  models={
                    liveModels[t.providerId] ??
                    providers
                      .find((p) => p.id === t.providerId)
                      ?.suggestedModels.map((m) => m.id) ??
                    []
                  }
                  onFocusModel={() => void loadModels(t.providerId)}
                  onChange={(patch) => update(t.key, patch)}
                  onRemove={() => setTargets((prev) => prev.filter((x) => x.key !== t.key))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={providerOptions.length === 0}
          onClick={() =>
            setTargets((prev) => [
              ...prev,
              {
                key: newKey(),
                providerId: providerOptions[0]?.id ?? '',
                model: '',
                connectionId: '',
              },
            ])
          }
        >
          <Plus className="h-4 w-4" /> Adicionar alvo
        </Button>
      </div>
    </Dialog>
  );
}

function SortableTarget({
  target,
  index,
  providers,
  connections,
  models,
  onFocusModel,
  onChange,
  onRemove,
}: {
  target: DraftTarget;
  index: number;
  providers: ProviderDto[];
  connections: ConnectionDto[];
  models: string[];
  onFocusModel(): void;
  onChange(patch: Partial<DraftTarget>): void;
  onRemove(): void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: target.key,
  });
  const listId = `models-${target.key}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-col gap-2 rounded-xl border border-border bg-surface p-2.5 sm:flex-row sm:items-center ${isDragging ? 'z-10 shadow-xl' : ''}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cursor-grab touch-none rounded-md p-1 text-subtle hover:text-fg"
          aria-label={`Reordenar alvo ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="w-5 text-center text-xs font-semibold text-muted">{index + 1}</span>
      </div>
      <Select
        aria-label="Provider"
        value={target.providerId}
        onChange={(e) => onChange({ providerId: e.target.value, connectionId: '' })}
        className="h-9 sm:w-44"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Modelo"
        list={listId}
        value={target.model}
        onFocus={onFocusModel}
        onChange={(e) => onChange({ model: e.target.value })}
        placeholder="id do modelo"
        className="h-9 flex-1 font-mono text-xs"
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Select
        aria-label="Conexão"
        value={target.connectionId}
        onChange={(e) => onChange({ connectionId: e.target.value })}
        className="h-9 sm:w-40"
      >
        <option value="">Todas as chaves</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            Só {c.name}
          </option>
        ))}
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label={`Remover alvo ${index + 1}`}
      >
        <X className="h-4 w-4" />
      </Button>
    </li>
  );
}
