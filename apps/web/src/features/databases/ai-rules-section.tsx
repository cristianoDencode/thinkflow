import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnRuleAction, ColumnRuleDto } from '@thinkflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { Input, Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';
import { formatTime } from '../../lib/utils';

const ACTION_LABELS: Record<ColumnRuleAction, string> = {
  reveal: 'Liberar',
  tokenize: 'Tokenizar',
  omit: 'Omitir',
};
const ACTIONS = Object.keys(ACTION_LABELS) as ColumnRuleAction[];

const refLabel = (r: Pick<ColumnRuleDto, 'schema' | 'table' | 'column'>): string =>
  `${r.schema}.${r.table}.${r.column}`;

/**
 * "Regras de privacidade da IA" of one connection: what the AI gets of each column
 * (schema.tabela.coluna; `*` = qualquer). Decisions made in the review card land here too.
 */
export function AiRulesSection({ connectionId }: { connectionId: string }) {
  const queryClient = useQueryClient();
  const queryKey = keys.databaseRules(connectionId);
  const rulesQuery = useQuery({
    queryKey,
    queryFn: () => api.get<ColumnRuleDto[]>(`/api/databases/${connectionId}/ai-rules`),
  });
  const rules = rulesQuery.data ?? [];
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    schema: '',
    table: '',
    column: '',
    action: 'tokenize' as ColumnRuleAction,
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changeAction = (rule: ColumnRuleDto, action: ColumnRuleAction) =>
    run(() =>
      api.put(`/api/databases/${connectionId}/ai-rules`, {
        schema: rule.schema,
        table: rule.table,
        column: rule.column,
        action,
        kind: action === 'tokenize' ? rule.kind : null,
      }),
    );

  const remove = (rule: ColumnRuleDto) =>
    run(() => api.del(`/api/databases/${connectionId}/ai-rules/${rule.id}`));

  const canAdd = draft.column.trim() !== '';
  const add = () => {
    if (!canAdd || busy) return;
    void run(async () => {
      await api.put(`/api/databases/${connectionId}/ai-rules`, {
        schema: draft.schema.trim() || '*',
        table: draft.table.trim() || '*',
        column: draft.column.trim(),
        action: draft.action,
      });
      setDraft((d) => ({ ...d, schema: '', table: '', column: '' }));
    });
  };
  const onEnter = (e: React.KeyboardEvent) => {
    // the dialog is a form: Enter here adds the rule instead of saving the connection
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  };

  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Regras de privacidade da IA">
      <div>
        <h4 className="text-sm font-medium">Regras de privacidade da IA</h4>
        <p className="mt-0.5 text-xs text-muted">
          O que a IA recebe de cada coluna: <strong>Liberar</strong> (valores reais),{' '}
          <strong>Tokenizar</strong> (códigos como <code className="font-mono">[CPF_1]</code>) ou{' '}
          <strong>Omitir</strong>. Você sempre vê os valores reais na tela. Use <code>*</code> para
          qualquer schema ou tabela. Colunas novas de texto são perguntadas no chat.
        </p>
      </div>

      {rulesQuery.isLoading ? (
        <p className="text-xs text-muted">Carregando regras…</p>
      ) : rules.length === 0 ? (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          Nenhuma regra ainda. As decisões que você marcar com “Lembrar” no chat aparecem aqui.
        </p>
      ) : (
        <div className="scrollbar-thin max-h-64 overflow-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-surface-2 text-left text-muted">
                <th scope="col" className="px-3 py-2 font-medium">
                  Coluna (schema.tabela.coluna)
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Ação
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Origem
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Atualizada em
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Remover</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-t border-border/60">
                  <td className="px-3 py-1.5 font-mono">{refLabel(rule)}</td>
                  <td className="px-3 py-1.5">
                    <Select
                      aria-label={`Ação para ${refLabel(rule)}`}
                      value={rule.action}
                      disabled={busy}
                      onChange={(e) => void changeAction(rule, e.target.value as ColumnRuleAction)}
                      className="h-8 w-auto rounded-lg py-0 text-xs"
                    >
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {ACTION_LABELS[a]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone={rule.origin === 'analyst' ? 'accent' : 'neutral'}>
                      {rule.origin === 'analyst' ? 'Analista' : 'Automática'}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">
                    {formatTime(rule.updatedAt)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => void remove(rule)}
                      aria-label={`Remover regra ${refLabel(rule)}`}
                      title="Remover regra"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto_auto]">
        <Input
          aria-label="Schema da regra"
          placeholder="schema (*)"
          className="font-mono"
          value={draft.schema}
          onChange={(e) => setDraft((d) => ({ ...d, schema: e.target.value }))}
          onKeyDown={onEnter}
        />
        <Input
          aria-label="Tabela da regra"
          placeholder="tabela (*)"
          className="font-mono"
          value={draft.table}
          onChange={(e) => setDraft((d) => ({ ...d, table: e.target.value }))}
          onKeyDown={onEnter}
        />
        <Input
          aria-label="Coluna da regra"
          placeholder="coluna"
          className="font-mono"
          value={draft.column}
          onChange={(e) => setDraft((d) => ({ ...d, column: e.target.value }))}
          onKeyDown={onEnter}
        />
        <Select
          aria-label="Ação da nova regra"
          value={draft.action}
          onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as ColumnRuleAction }))}
        >
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={add} disabled={!canAdd || busy}>
          <Plus className="h-4 w-4" aria-hidden /> Adicionar regra
        </Button>
      </div>
    </div>
  );
}
