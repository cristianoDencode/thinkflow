import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import { buildIntakeMessages, parseIntakeAnswer, type GenerateArgs } from '../domain/chat-preset';
import type { ReportTemplate } from '../domain/template';
import { completeChat } from './llm';

const INTAKE_MAX_OUTPUT_TOKENS = 800;
const INTAKE_TIMEOUT_MS = 60_000;

/** Port used by `ReportService` to fill a template's variables from a chat transcript. */
export interface ReportIntakePort {
  /** `null` when the model could not be reached or did not answer with usable JSON. */
  extract(
    template: ReportTemplate,
    transcript: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<GenerateArgs | null>;
}

/** One LLM call (usage source `report-intake`) behind the "Gerar agora" button. */
export class ReportIntake implements ReportIntakePort {
  constructor(private readonly deps: { router: RouteChatRequest }) {}

  async extract(
    template: ReportTemplate,
    transcript: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<GenerateArgs | null> {
    try {
      const result = await completeChat(
        this.deps.router,
        {
          model,
          messages: buildIntakeMessages(template, transcript),
          maxTokens: INTAKE_MAX_OUTPUT_TOKENS,
          temperature: 0,
        },
        { source: 'report-intake', timeoutMs: INTAKE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      return parseIntakeAnswer(result.text);
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
  }
}
