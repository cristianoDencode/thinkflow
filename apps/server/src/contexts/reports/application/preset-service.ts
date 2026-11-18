import type { ChatPreset, ReportDto } from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';
import type {
  CreatedDocument,
  DocumentPresetPort,
  PresetChatTools,
} from '../../chat/domain/conversation';
import {
  GENERATE_TOOL_NAME,
  buildPresetSystemNote,
  generateToolParameters,
  normalizeGenerateArgs,
  parseGenerateDirective,
  type GenerateArgs,
} from '../domain/chat-preset';
import { missingVariables, type ReportTemplate } from '../domain/template';

export interface PresetServiceDeps {
  templates: { find(id: string): Promise<ReportTemplate | null> };
  reports: { create(body: unknown): Promise<ReportDto> };
}

/**
 * Chat modes: turns a conversation preset ({kind, templateId}) into the interview instructions and
 * the `gerar_documento` tool of ONE turn. The instructions come from the stored template only.
 */
export class PresetService implements DocumentPresetPort {
  constructor(private readonly deps: PresetServiceDeps) {}

  async chatTools(
    preset: ChatPreset,
    ctx: { conversationId: string; model: string; libraryId: string | null; useMcp: boolean },
  ): Promise<PresetChatTools | null> {
    const template = await this.deps.templates.find(preset.templateId);
    if (!template || template.kind !== preset.kind) return null;

    const created: CreatedDocument[] = [];
    const start = async (args: GenerateArgs): Promise<CreatedDocument> => {
      // one document per turn: a repeated request answers with the first one
      if (created[0]) return created[0];
      const missing = missingVariables(template.spec, args.variables);
      if (missing.length > 0) {
        const labels = missing.map(
          (name) => template.spec.variables.find((v) => v.name === name)?.label ?? name,
        );
        throw new DomainError(`Faltam: ${labels.join(', ')}`, 'report_missing_variables', 422);
      }
      const report = await this.deps.reports.create({
        templateId: template.id,
        variables: args.variables,
        brief: args.brief,
        model: ctx.model,
        libraryId: ctx.libraryId,
        // the template decides; the chat only turns MCP off
        ...(ctx.useMcp ? {} : { useMcp: false }),
        conversationId: ctx.conversationId,
        ...(args.title ? { title: args.title } : {}),
      });
      const document = { id: report.id, title: report.title, kind: report.kind };
      created.push(document);
      return document;
    };

    return {
      templateName: template.name,
      systemNote: buildPresetSystemNote(template),
      tools: [
        {
          name: GENERATE_TOOL_NAME,
          description:
            'Inicia a geração do documento em segundo plano. Chame SOMENTE depois que o usuário confirmar as informações e o escopo.',
          parameters: generateToolParameters(template),
        },
      ],
      created: () => [...created],
      async call(name, args) {
        if (name !== GENERATE_TOOL_NAME)
          return { text: `Ferramenta desconhecida: ${name}`, isError: true };
        const repeated = created.length > 0;
        try {
          const document = await start(normalizeGenerateArgs(args));
          return {
            text: repeated
              ? `A geração de «${document.title}» já foi iniciada neste turno.`
              : `Geração iniciada: «${document.title}». O usuário acompanha o andamento no cartão do chat e em Relatórios.`,
            isError: false,
          };
        } catch (err) {
          return { text: errorText(err), isError: true };
        }
      },
      async fromText(text) {
        const directive = parseGenerateDirective(text);
        if (!directive) return { document: null, text, notice: null };
        if (!directive.args)
          return {
            document: null,
            text: directive.stripped,
            notice:
              'Não consegui iniciar a geração: o pedido veio em formato inválido. Confirme as informações e peça de novo.',
          };
        try {
          const document = await start(directive.args);
          return { document, text: directive.stripped, notice: null };
        } catch (err) {
          return {
            document: null,
            text: directive.stripped,
            notice: `Não consegui iniciar a geração: ${errorText(err)}`,
          };
        }
      },
    };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
