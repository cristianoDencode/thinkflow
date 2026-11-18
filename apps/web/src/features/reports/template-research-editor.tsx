import { TEMPLATE_LIMITS, type TemplateResearch } from '@thinkflow/shared';
import { TriangleAlert } from 'lucide-react';
import { Field, Input, Switch } from '../../components/ui/form';
import { useMcpServers } from '../../lib/queries';
import { StringListEditor } from './string-list-editor';

export function TemplateResearchEditor({
  research,
  onChange,
  readOnly,
}: {
  research: TemplateResearch;
  onChange(research: TemplateResearch): void;
  readOnly: boolean;
}) {
  const { data: servers = [] } = useMcpServers();
  const set = (patch: Partial<TemplateResearch>) => onChange({ ...research, ...patch });
  const known = new Set(servers.map((s) => s.name));
  const missing = research.mcpServers.filter((name) => !known.has(name));

  const toggleServer = (name: string) =>
    set({
      mcpServers: research.mcpServers.includes(name)
        ? research.mcpServers.filter((n) => n !== name)
        : [...research.mcpServers, name],
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Switch
            checked={research.useMcp}
            onChange={(useMcp) => set({ useMcp })}
            label="Pesquisar com ferramentas MCP"
          />
          <span className="text-sm">Pesquisar com ferramentas MCP</span>
        </div>
        {research.useMcp && (
          <>
            <div
              role="note"
              className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                A pesquisa roda sem acompanhamento: as ferramentas dos servidores selecionados são
                chamadas sem pedir confirmação e podem usar qualquer ferramenta que o servidor
                oferecer. Prefira servidores somente leitura.
              </p>
            </div>
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-1.5 text-sm font-medium">Servidores MCP permitidos</legend>
              {servers.length === 0 && missing.length === 0 ? (
                <p className="text-sm text-muted">
                  Nenhum servidor MCP cadastrado. Cadastre um na página MCP.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {servers.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked={research.mcpServers.includes(s.name)}
                        disabled={readOnly}
                        onChange={() => toggleServer(s.name)}
                      />
                      <span className="font-mono">{s.name}</span>
                      {!s.enabled && <span className="text-xs text-subtle">(desativado)</span>}
                    </label>
                  ))}
                  {missing.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked
                        disabled={readOnly}
                        onChange={() => toggleServer(name)}
                      />
                      <span className="font-mono">{name}</span>
                      <span className="text-xs text-subtle">(servidor não encontrado)</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-xs text-muted">
                Sem nenhum servidor marcado, todos os servidores MCP ativos podem ser usados.
              </p>
            </fieldset>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Switch
          checked={research.useLibrary}
          onChange={(useLibrary) => set({ useLibrary })}
          label="Consultar a Biblioteca"
        />
        <span className="text-sm">Consultar a Biblioteca</span>
      </div>

      <Field
        label="Diretrizes de pesquisa"
        hint="O que investigar antes de escrever. Pode usar variáveis como {{nome}}."
      >
        <StringListEditor
          label="Diretriz"
          items={research.directives}
          onChange={(directives) => set({ directives })}
          placeholder="Ex.: Obtenha o código-fonte e os parâmetros de {{funcao}}"
          addLabel="Adicionar diretriz"
          max={TEMPLATE_LIMITS.maxDirectives}
        />
      </Field>

      <Field
        label="Máximo de etapas de pesquisa"
        htmlFor="research-steps"
        hint="Entre 1 e 20. Mais etapas pesquisam mais fundo, mas consomem mais cota."
        className="max-w-xs"
      >
        <Input
          id="research-steps"
          type="number"
          min={1}
          max={20}
          value={research.maxSteps}
          onChange={(e) => set({ maxSteps: Number(e.target.value) })}
        />
      </Field>
    </div>
  );
}
