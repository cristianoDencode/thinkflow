import type {
  DatabaseAiAccess,
  DatabaseConnectionDto,
  DatabaseConnectionInput,
  DatabaseConnectionUpdateInput,
  DatabaseSslMode,
} from '@thinkflow/shared';
import { DATABASE_LIMITS } from '@thinkflow/shared';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useMetadataProjects, useMetadataServers } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { AiRulesSection } from './ai-rules-section';

interface Draft {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: DatabaseSslMode;
  schemas: string;
  aiAccess: DatabaseAiAccess;
  sampleRows: string;
  statementTimeoutSec: string;
  maxRows: string;
  isDefault: boolean;
  /** '' = none (catalog suggestions only). */
  metadataMcpServerId: string;
  metadataMcpProject: string;
}

const EMPTY: Draft = {
  name: '',
  host: '',
  port: '5432',
  database: '',
  user: '',
  password: '',
  sslMode: 'disable',
  schemas: '',
  aiAccess: 'schema',
  sampleRows: String(DATABASE_LIMITS.defaultSampleRows),
  statementTimeoutSec: String(DATABASE_LIMITS.defaultStatementTimeoutSec),
  maxRows: String(DATABASE_LIMITS.defaultMaxRows),
  isDefault: false,
  metadataMcpServerId: '',
  metadataMcpProject: '',
};

const SSL_LABELS: Record<DatabaseSslMode, string> = {
  disable: 'Desativado',
  require: 'Exigir (sem verificar o certificado)',
  'verify-full': 'Exigir e verificar o certificado',
};

const ACCESS_OPTIONS: { value: DatabaseAiAccess; title: string; description: string }[] = [
  {
    value: 'schema',
    title: 'Só a estrutura',
    description: 'Tabelas, colunas e estatísticas, sem nenhum valor de texto dos registros.',
  },
  {
    value: 'masked',
    title: 'Amostra mascarada',
    description:
      'Até N linhas por tabela, com os dados pessoais (CPF, e-mail, nomes…) trocados por tokens reversíveis, como [CPF_1].',
  },
];

const splitList = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

function fromConnection(c: DatabaseConnectionDto): Draft {
  return {
    name: c.name,
    host: c.host,
    port: String(c.port),
    database: c.database,
    user: c.user,
    password: '',
    sslMode: c.sslMode,
    schemas: c.schemas.join(', '),
    aiAccess: c.aiAccess,
    sampleRows: String(c.sampleRows),
    statementTimeoutSec: String(c.statementTimeoutSec),
    maxRows: String(c.maxRows),
    isDefault: c.isDefault,
    metadataMcpServerId: c.metadataMcpServerId ?? '',
    metadataMcpProject: c.metadataMcpProject ?? '',
  };
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="border-b border-border pb-1.5 text-xs font-semibold tracking-wide text-subtle uppercase">
      {children}
    </h3>
  );
}

/**
 * Optional data dictionary: an MCP server that exposes `field_search` (e-Cidade's "Mapeamento").
 * When the AI's SQL names a table/column that does not exist, only the identifier words are sent
 * to it to suggest real ones; never any data.
 */
function DictionarySection({
  serverId,
  project,
  onChange,
}: {
  serverId: string;
  project: string;
  onChange(serverId: string, project: string): void;
}) {
  const servers = useMetadataServers(true);
  const projects = useMetadataProjects(serverId);
  const serverList = Array.isArray(servers.data) ? servers.data : [];
  const projectList = useMemo(
    () => (Array.isArray(projects.data) ? projects.data : []),
    [projects.data],
  );

  // a single project needs no choice
  useEffect(() => {
    if (serverId && !project && projectList.length === 1) onChange(serverId, projectList[0]!);
  }, [serverId, project, projectList, onChange]);

  const savedServerGone =
    serverId !== '' && servers.isSuccess && !serverList.some((s) => s.id === serverId);
  const savedProjectGone = project !== '' && projects.isSuccess && !projectList.includes(project);

  return (
    <section className="flex flex-col gap-3" aria-label="Dicionário de dados (MCP)">
      <SectionTitle>Dicionário de dados (MCP)</SectionTitle>
      <p className="text-xs text-muted">
        Opcional. Quando a SQL da IA (ou a sua) cita uma tabela ou coluna que não existe, o
        Thinkflow sugere nomes parecidos do catálogo do banco e, se houver um servidor MCP com o
        dicionário do sistema (ferramenta <code className="font-mono">field_search</code>, como o
        &quot;Mapeamento&quot; do e-Cidade, por exemplo), consulta-o só com as palavras do nome —
        nunca com dados.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Servidor MCP" htmlFor="db-meta-server">
          <Select
            id="db-meta-server"
            value={serverId}
            onChange={(e) => onChange(e.target.value, '')}
          >
            <option value="">Nenhum (só o catálogo do banco)</option>
            {savedServerGone && <option value={serverId}>Servidor indisponível (salvo)</option>}
            {serverList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Projeto"
          htmlFor="db-meta-project"
          hint={
            serverId && projects.isSuccess && projectList.length === 0
              ? 'O servidor não devolveu projetos (está no ar?).'
              : undefined
          }
        >
          <Select
            id="db-meta-project"
            value={project}
            disabled={!serverId}
            onChange={(e) => onChange(serverId, e.target.value)}
          >
            <option value="">{serverId ? 'Escolha o projeto' : '—'}</option>
            {savedProjectGone && <option value={project}>{project} (salvo)</option>}
            {projectList.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {servers.isSuccess && serverList.length === 0 && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          Nenhum servidor MCP ativo expõe <code className="font-mono">field_search</code>. Cadastre
          o servidor em MCP e volte aqui.
        </p>
      )}
    </section>
  );
}

export function DatabaseDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: DatabaseConnectionDto | null;
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(editing ? fromConnection(editing) : EMPTY);
    setShowPassword(false);
  }, [open, editing]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const canSave =
    draft.name.trim() !== '' &&
    draft.host.trim() !== '' &&
    draft.database.trim() !== '' &&
    draft.user.trim() !== '';

  const submit = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: Number(draft.port) || 5432,
        database: draft.database.trim(),
        user: draft.user.trim(),
        sslMode: draft.sslMode,
        schemas: splitList(draft.schemas),
        aiAccess: draft.aiAccess,
        sampleRows: Number(draft.sampleRows) || DATABASE_LIMITS.defaultSampleRows,
        statementTimeoutSec:
          Number(draft.statementTimeoutSec) || DATABASE_LIMITS.defaultStatementTimeoutSec,
        maxRows: Number(draft.maxRows) || DATABASE_LIMITS.defaultMaxRows,
        isDefault: draft.isDefault,
        metadataMcpServerId: draft.metadataMcpServerId || null,
        metadataMcpProject: draft.metadataMcpServerId ? draft.metadataMcpProject || null : null,
        // when editing, an empty field keeps the stored password
        ...(editing && !draft.password ? {} : { password: draft.password }),
      };
      if (editing)
        await api.put(`/api/databases/${editing.id}`, body satisfies DatabaseConnectionUpdateInput);
      else await api.post('/api/databases', body satisfies DatabaseConnectionInput);
      notify.success('Conexão salva');
      onSaved();
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
      title={editing ? `Editar ${editing.name}` : 'Nova conexão Postgres'}
      description="O Thinkflow só executa leitura: cada consulta roda em uma transação somente leitura."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!canSave}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && !saving) void submit();
        }}
      >
        <section className="flex flex-col gap-3" aria-label="Conexão">
          <SectionTitle>Conexão</SectionTitle>
          <Field
            label="Nome"
            htmlFor="db-name"
            hint="Como a conexão aparece na lista e em Dados com IA."
          >
            <Input
              id="db-name"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Ex.: Tributos — produção (leitura)"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
            <Field label="Host" htmlFor="db-host">
              <Input
                id="db-host"
                value={draft.host}
                onChange={(e) => set('host', e.target.value)}
                className="font-mono"
                placeholder="servidor.exemplo.com"
                autoComplete="off"
              />
            </Field>
            <Field label="Porta" htmlFor="db-port">
              <Input
                id="db-port"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => set('port', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Banco de dados" htmlFor="db-database">
            <Input
              id="db-database"
              value={draft.database}
              onChange={(e) => set('database', e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Usuário" htmlFor="db-user">
              <Input
                id="db-user"
                value={draft.user}
                onChange={(e) => set('user', e.target.value)}
                className="font-mono"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Senha"
              htmlFor="db-password"
              hint={
                editing
                  ? editing.passwordSet
                    ? 'Deixe em branco para manter a senha atual.'
                    : 'Nenhuma senha salva.'
                  : 'Armazenada criptografada.'
              }
            >
              <div className="relative">
                <Input
                  id="db-password"
                  type={showPassword ? 'text' : 'password'}
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                  autoComplete="new-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-muted hover:text-fg"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>
          <Field label="SSL" htmlFor="db-ssl">
            <Select
              id="db-ssl"
              value={draft.sslMode}
              onChange={(e) => set('sslMode', e.target.value as DatabaseSslMode)}
            >
              {(Object.keys(SSL_LABELS) as DatabaseSslMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {SSL_LABELS[mode]}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="flex flex-col gap-3" aria-label="Escopo">
          <SectionTitle>Escopo</SectionTitle>
          <Field
            label="Schemas permitidos"
            htmlFor="db-schemas"
            hint="Separados por vírgula. Vazio = todos (menos os do sistema do Postgres)."
          >
            <Input
              id="db-schemas"
              value={draft.schemas}
              onChange={(e) => set('schemas', e.target.value)}
              className="font-mono"
              placeholder="public, tributos"
            />
          </Field>
        </section>

        <section className="flex flex-col gap-3" aria-label="Privacidade">
          <SectionTitle>Privacidade — O que a IA pode ver</SectionTitle>
          <div
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            role="radiogroup"
            aria-label="O que a IA pode ver"
          >
            {ACCESS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={draft.aiAccess === option.value}
                onClick={() => set('aiAccess', option.value)}
                className={cn(
                  'cursor-pointer rounded-xl border p-3 text-left transition-colors',
                  draft.aiAccess === option.value
                    ? 'border-accent bg-accent-soft'
                    : 'border-border hover:bg-surface-hover',
                )}
              >
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
              </button>
            ))}
          </div>

          {draft.aiAccess === 'masked' && (
            <Field
              label="Linhas de amostra por tabela"
              htmlFor="db-sample"
              hint={`De 1 a ${DATABASE_LIMITS.maxSampleRows}.`}
            >
              <Input
                id="db-sample"
                type="number"
                min={1}
                max={DATABASE_LIMITS.maxSampleRows}
                value={draft.sampleRows}
                onChange={(e) => set('sampleRows', e.target.value)}
                className="sm:w-40"
              />
            </Field>
          )}

          <p
            className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted"
            aria-label="Exemplo de tokenização"
          >
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden />
            <span>
              Exemplo de tokenização: CPF <code className="font-mono">529.982.247-25</code> →{' '}
              <code className="font-mono">[CPF_1]</code> · e-mail{' '}
              <code className="font-mono">ana@dominio.com</code> →{' '}
              <code className="font-mono">[EMAIL_1]</code> · nome{' '}
              <code className="font-mono">Maria da Silva</code> →{' '}
              <code className="font-mono">[NOME_1]</code>. O mesmo valor sempre recebe o mesmo
              token, e nas respostas você vê os valores reais.
            </span>
          </p>

          {editing ? (
            <AiRulesSection connectionId={editing.id} />
          ) : (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              Salve a conexão para gerenciar as regras de privacidade por coluna (o chat também
              pergunta sobre colunas novas e guarda suas decisões).
            </p>
          )}
          <p className="text-xs text-muted">
            Você sempre vê os resultados completos na tela, e nada é gravado no banco: toda consulta
            roda em transação somente leitura.
          </p>
        </section>

        <DictionarySection
          serverId={draft.metadataMcpServerId}
          project={draft.metadataMcpProject}
          onChange={(serverId, project) =>
            setDraft((d) => ({ ...d, metadataMcpServerId: serverId, metadataMcpProject: project }))
          }
        />

        <section className="flex flex-col gap-3" aria-label="Limites">
          <SectionTitle>Limites</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Tempo máximo por consulta (s)"
              htmlFor="db-timeout"
              hint={`De 1 a ${DATABASE_LIMITS.maxStatementTimeoutSec} segundos.`}
            >
              <Input
                id="db-timeout"
                type="number"
                min={1}
                max={DATABASE_LIMITS.maxStatementTimeoutSec}
                value={draft.statementTimeoutSec}
                onChange={(e) => set('statementTimeoutSec', e.target.value)}
              />
            </Field>
            <Field
              label="Máximo de linhas por consulta"
              htmlFor="db-maxrows"
              hint={`De 1 a ${DATABASE_LIMITS.maxRows}. O que passar disso é cortado.`}
            >
              <Input
                id="db-maxrows"
                type="number"
                min={1}
                max={DATABASE_LIMITS.maxRows}
                value={draft.maxRows}
                onChange={(e) => set('maxRows', e.target.value)}
              />
            </Field>
          </div>
        </section>

        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
          <span className="text-sm">
            Conexão padrão
            <span className="block text-xs text-muted">Já vem selecionada em Dados com IA.</span>
          </span>
          <Switch
            checked={draft.isDefault}
            onChange={(v) => set('isDefault', v)}
            label="Conexão padrão"
          />
        </div>
        {/* lets Enter submit from the text fields */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
