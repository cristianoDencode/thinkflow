import { LIBRARY_TURN_LIMIT_TEXT } from '../../library/domain/tool-format';
import { estimateRequestTokens, resolveContextBudget } from '../../chat/domain/context-window';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  OUTLINE_MAX_TOKENS,
  buildOutline,
  buildOutlineMessages,
  noteAliases,
  parseOutline,
  type OutlineParse,
} from '../domain/outline';
import {
  SCREEN_PLAN_MAX_TOKENS,
  buildScreenMessages,
  buildScreenPlanMessages,
  extractScreen,
  fallbackScreens,
  parseScreenPlan,
  screenSlugs,
  type PlannedScreen,
} from '../domain/prototype';
import {
  NOTE_MAX_CHARS,
  mergeUnique,
  NEW_VERSION_STORAGE_STATE,
  nextPhase,
  progressLabel,
  sourcesFromNotes,
  waitLabel,
  type Report,
  type ReportJobSpec,
  type ReportNote,
  type ReportProgress,
  type ReportSection,
  type ReportSettings,
  type ReportStatus,
  type ResearchStep,
} from '../domain/report';
import type { ReportRepository, ResearchTools, ResearchToolsPort } from '../domain/report-ports';
import type { MarkdownToHtml } from '../domain/render-ports';
import {
  PLAN_MAX_TOKENS,
  STEP_SYNTHESIS_MAX_CHARS,
  buildPlanMessages,
  buildStepMessages,
  fallbackPlan,
  parsePlan,
  toolQueryText,
} from '../domain/research';
import {
  MIN_NOTES_CHARS,
  buildSectionMessages,
  noteLabel,
  prepareSectionMarkdown,
  previousDigest,
  selectNotes,
  type PromptNote,
} from '../domain/section-writer';
import { renderTemplateText } from '../domain/template';
import type { DiagramService } from './diagram-service';
import type { ReportDocumentBuilder } from './report-document';
import {
  LlmError,
  completeChat,
  sleepWithSignal,
  withProviderRetry,
  type LlmResult,
  type Sleep,
} from './llm';

/** The runner aborts with this reason when the server shuts down: the job must stay resumable. */
export const STOP_REASON = 'server-stop';

const SECTION_NOTES_SHARE = 0.9;
const STEP_STOP_SHARE = 0.9;
const MAX_STEP_OUTPUT_TOKENS = 700;
const MAX_CONSECUTIVE_SECTION_FAILURES = 3;
const TOOL_OUTPUT_CAP_CHARS = 8_000;
const TOOL_OUTPUT_BUDGET_SHARE = 0.25;
/** NotebookLM answers count against a small daily quota: research is limited per report. */
const REMOTE_LIBRARY_CALLS_PER_REPORT = 6;

export interface ReportPipelineDeps {
  repo: ReportRepository;
  router: RouteChatRequest;
  research: ResearchToolsPort;
  settings: () => ReportSettings;
  /** `contextBudgetTokens` of the chat history settings. */
  contextBudget: () => number;
  inputLimitHint?: (model: string) => Promise<number | undefined>;
  /** Validates/repairs the Mermaid diagrams of each section. */
  diagrams: DiagramService;
  /** Builds the final Markdown + HTML (and the prototype page). */
  documents: ReportDocumentBuilder;
  /** Sanitizes the HTML fragments of prototype screens. */
  markdown: MarkdownToHtml;
  clock: Clock;
  ids: IdGenerator;
  /** Provider-wait timer (tests make it instant). */
  sleep?: Sleep;
  onError?: (err: unknown, reportId: string) => void;
  /** A new document was saved in the staging column: the object-store sync picks it up. */
  onAssembled?: (reportId: string) => void;
}

interface Run {
  report: Report;
  signal: AbortSignal;
  settings: ReportSettings;
  model: string;
  budget: number;
  notes: ReportNote[];
  /** Current non-waiting progress label (restored after a provider wait). */
  progress: ReportProgress;
  tools: ResearchTools | null;
  phase: ReportStatus;
}

/** Runs the stages of one report; every stage saves its result, so a job resumes where it stopped. */
export class ReportPipeline {
  private readonly sleep: Sleep;

  constructor(private readonly deps: ReportPipelineDeps) {
    this.sleep = deps.sleep ?? sleepWithSignal;
  }

  /** Runs one job to its end state (done / error / canceled). Never throws for job failures. */
  async run(reportId: string, job: ReportJobSpec, signal: AbortSignal): Promise<void> {
    const { repo } = this.deps;
    const report = await repo.findById(reportId);
    if (!report) return;
    const settings = this.deps.settings();
    const model = (job.type === 'section' && job.model) || report.model;
    const run: Run = {
      report,
      signal,
      settings,
      model,
      budget: 0,
      notes: await repo.notes(reportId),
      progress: report.progress,
      tools: null,
      phase: report.status,
    };
    try {
      this.checkpoint(run);
      if (report.cancelRequested && job.type === 'generate') throw cancelSignal();
      run.budget = resolveContextBudget({
        configured: this.deps.contextBudget(),
        learnedLimit: await this.deps.inputLimitHint?.(model),
      });
      if (job.type === 'generate') await this.generate(run);
      else await this.rewriteSection(run, job);
    } catch (err) {
      await this.handleFailure(run, job, err);
    }
  }

  /* ------------------------------ generation ------------------------------ */

  private async generate(run: Run): Promise<void> {
    const { report } = run;
    await this.patch(run, {
      startedAt: report.startedAt ?? this.deps.clock.now(),
      finishedAt: null,
      error: null,
      failedPhase: null,
    });
    await this.researchPhase(run);
    await this.outlinePhase(run);
    await this.writePhase(run);
    await this.assemble(run);
  }

  /* -------- research -------- */

  private async researchPhase(run: Run): Promise<void> {
    const { report } = run;
    const phase = nextPhase(report);
    if (phase !== 'researching') return;
    const { spec } = this.snapshot(run);
    const maxSteps = Math.min(spec.research.maxSteps, run.settings.maxResearchSteps);
    await this.setProgress(run, 'researching', report.researchDone, report.plan?.length ?? 0);

    const wantsTools = report.useMcp || (!!report.libraryId && spec.research.useLibrary);
    if (report.plan === null) {
      let plan: ResearchStep[] = [];
      if (wantsTools && maxSteps > 0) {
        await this.openTools(run);
        if (run.tools) plan = await this.makePlan(run, maxSteps);
      }
      if (wantsTools && maxSteps > 0 && !run.tools)
        await this.addWarning(
          run,
          'Nenhuma ferramenta de pesquisa ficou disponível (servidor MCP ou biblioteca); o documento foi escrito sem consulta às fontes.',
        );
      report.plan = plan;
      await this.patch(run, { plan });
    } else if (report.plan.length > report.researchDone) {
      await this.openTools(run);
    }

    const plan = report.plan ?? [];
    if (plan.length > 0 && !run.tools) {
      // resumed (or opened) without any usable tool: the remaining steps cannot run
      await this.addWarning(
        run,
        'Nenhuma ferramenta de pesquisa ficou disponível; a pesquisa foi pulada.',
      );
      report.researchDone = plan.length;
      await this.patch(run, { researchDone: plan.length });
      return;
    }

    for (let i = report.researchDone; i < plan.length; i++) {
      this.checkpoint(run);
      const step = plan[i]!;
      await this.setProgress(run, 'researching', i + 1, plan.length, shortText(step.objective, 60));
      // a step cut off by a restart or cancellation is redone from scratch
      await this.deps.repo.deleteNotesFromStep(report.id, i + 1);
      run.notes = run.notes.filter((n) => n.step <= i);
      try {
        await this.researchStep(run, step, i + 1, plan.length);
      } catch (err) {
        if (run.signal.aborted || !(err instanceof LlmError) || !err.soft) throw err;
        await this.addWarning(
          run,
          `A etapa de pesquisa ${i + 1} falhou (${err.message}) e foi pulada.`,
        );
      }
      report.researchDone = i + 1;
      await this.patch(run, { researchDone: i + 1 });
    }
    if (plan.length > 0 && !run.notes.some((n) => n.source === 'mcp' || n.source === 'library')) {
      await this.addWarning(
        run,
        'O modelo não chamou ferramentas (pode não suportar tool calling); o conteúdo foi gerado sem consulta às fontes.',
      );
    }
  }

  private async openTools(run: Run): Promise<void> {
    const { report, settings } = run;
    const { spec } = this.snapshot(run);
    const maxSteps = Math.min(spec.research.maxSteps, settings.maxResearchSteps);
    const perCall = this.toolOutputCap(run);
    run.tools = await this.deps.research.open({
      useMcp: report.useMcp,
      mcpServers: spec.research.mcpServers,
      libraryId: spec.research.useLibrary ? report.libraryId : null,
      maxOutputChars: perCall,
      libraryMaxCalls: Math.max(1, maxSteps * settings.maxToolCallsPerStep),
      libraryMaxTotalChars: Math.max(perCall, maxSteps * perCall),
      remoteLibraryMaxCalls: REMOTE_LIBRARY_CALLS_PER_REPORT,
    });
    for (const e of run.tools?.mcpErrors ?? [])
      await this.addWarning(
        run,
        `Servidor MCP "${e.server}" indisponível: ${shortText(e.message, 120)}`,
      );
  }

  private async makePlan(run: Run, maxSteps: number): Promise<ResearchStep[]> {
    const { report } = run;
    const { spec } = this.snapshot(run);
    const input = { spec, vars: report.variables, brief: report.brief, maxSteps };
    let error: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer: LlmResult;
      try {
        answer = await this.ask(run, {
          source: 'report-research',
          maxTokens: PLAN_MAX_TOKENS,
          temperature: 0.2,
          build: () => buildPlanMessages(input, error),
        });
      } catch (err) {
        if (run.signal.aborted || !(err instanceof LlmError) || !err.soft) throw err;
        error = err.message;
        continue;
      }
      const parsed = parsePlan(answer.text, spec.sections.length, maxSteps);
      if (parsed.ok) return parsed.steps;
      error = parsed.error;
    }
    await this.addWarning(
      run,
      'Não foi possível ler o plano de pesquisa do modelo; usei as diretrizes do modelo de documento.',
    );
    return fallbackPlan(spec, report.variables, maxSteps);
  }

  private async researchStep(
    run: Run,
    step: ResearchStep,
    index: number,
    total: number,
  ): Promise<void> {
    const { report, settings } = run;
    const tools = run.tools!;
    const { spec } = this.snapshot(run);
    const previous = run.notes;
    const messages: OAIMessage[] = buildStepMessages({
      spec,
      vars: report.variables,
      step,
      index,
      total,
      previous,
      toolsNote: tools.systemNote,
      sectionTitles: spec.sections.map((s) => renderTemplateText(s.title, report.variables)),
    });
    const cap = this.toolOutputCap(run);
    const fresh: ReportNote[] = [];
    let ordinal = 0;
    const addNote = (
      note: Omit<ReportNote, 'id' | 'reportId' | 'step' | 'ordinal' | 'createdAt' | 'sectionHints'>,
    ) => {
      fresh.push({
        ...note,
        id: this.deps.ids.next(),
        reportId: report.id,
        step: index,
        ordinal: ordinal++,
        sectionHints: step.sections,
        createdAt: this.deps.clock.now(),
      });
    };

    try {
      const rounds = settings.maxToolCallsPerStep;
      for (let round = 0; round <= rounds; round++) {
        this.checkpoint(run);
        const withTools = round < rounds;
        const result = await this.ask(run, {
          source: 'report-research',
          maxTokens: MAX_STEP_OUTPUT_TOKENS,
          temperature: 0.2,
          build: (scale) => (scale < 1 ? shrinkToolMessages(messages, scale) : messages),
          ...(withTools ? { tools: tools.defs } : {}),
        });
        if (result.toolCalls.length === 0 || !withTools) {
          const synthesis = result.text.trim();
          if (synthesis)
            addNote({
              source: 'model',
              toolName: null,
              query: null,
              content: shortText(synthesis, STEP_SYNTHESIS_MAX_CHARS),
            });
          break;
        }
        messages.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls,
        });
        for (const call of result.toolCalls) {
          this.checkpoint(run);
          const args = safeJsonParse(call.function.arguments);
          let output: { text: string; isError: boolean };
          try {
            output = await tools.call(call.function.name, args, run.signal);
          } catch (err) {
            if (run.signal.aborted) throw err;
            output = { text: err instanceof Error ? err.message : String(err), isError: true };
          }
          const text = output.text.trim();
          if (!output.isError && text && text !== LIBRARY_TURN_LIMIT_TEXT) {
            addNote({
              source: tools.libraryToolNames.has(call.function.name) ? 'library' : 'mcp',
              toolName: call.function.name,
              query: toolQueryText(args),
              content: shortText(text, NOTE_MAX_CHARS),
            });
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: shortText(output.text, cap) || '(sem saída)',
          });
        }
        if (estimateRequestTokens(messages, tools.defs) > run.budget * STEP_STOP_SHARE) break;
      }
    } finally {
      // keep what the step already collected, also when it was cut off (cancel, failure)
      if (fresh.length > 0) {
        await this.deps.repo.addNotes(fresh).catch(() => undefined);
        run.notes = [...run.notes, ...fresh];
      }
    }
  }

  /* -------- outline -------- */

  private async outlinePhase(run: Run): Promise<void> {
    const { report } = run;
    if (report.outline !== null) {
      await this.ensureSections(run);
      return;
    }
    this.checkpoint(run);
    const { spec } = this.snapshot(run);
    await this.setProgress(run, 'outlining', 0, spec.sections.length);
    const notes = run.notes;
    let parsed: OutlineParse | null = null;
    if (notes.length > 0) {
      const aliases = noteAliases(notes);
      const fixed = estimateRequestTokens(
        buildOutlineMessages({ spec, vars: report.variables, notes: [], indexChars: 0 }),
      );
      const indexChars = Math.max(
        1_000,
        Math.floor((run.budget - fixed - OUTLINE_MAX_TOKENS) * 4 * 0.8),
      );
      let error: string | undefined;
      for (let attempt = 0; attempt < 2 && !parsed?.ok; attempt++) {
        try {
          const answer = await this.ask(run, {
            source: 'report-outline',
            maxTokens: OUTLINE_MAX_TOKENS,
            temperature: 0.2,
            build: (scale) =>
              buildOutlineMessages(
                { spec, vars: report.variables, notes, indexChars: Math.floor(indexChars * scale) },
                error,
              ),
          });
          parsed = parseOutline(answer.text, spec.sections.length, aliases);
          if (!parsed.ok) error = parsed.error;
        } catch (err) {
          if (run.signal.aborted || !(err instanceof LlmError) || !err.soft) throw err;
          error = err.message;
        }
      }
      if (!parsed?.ok)
        await this.addWarning(
          run,
          'Não foi possível ler o roteiro do modelo; as notas foram distribuídas por afinidade com cada seção.',
        );
    }
    report.outline = buildOutline(spec, report.variables, notes, parsed);
    await this.patch(run, { outline: report.outline });
    await this.ensureSections(run);
  }

  private async ensureSections(run: Run): Promise<void> {
    const { report } = run;
    const { spec } = this.snapshot(run);
    const now = this.deps.clock.now();
    await this.deps.repo.addSections(
      spec.sections.map((section, i) => ({
        reportId: report.id,
        ordinal: i + 1,
        title: renderTemplateText(section.title, report.variables),
        requirements: renderTemplateText(section.requirements, report.variables),
        role: 'section' as const,
        status: 'pending' as const,
        markdown: '',
        html: null,
        noteIds: [],
        model: null,
        providerId: null,
        warnings: [],
        error: null,
        updatedAt: now,
      })),
    );
    if (report.kind === 'prototype') await this.planScreens(run);
  }

  /** Prototype: plans the screens (one extra call, then a deterministic fallback) as `screen` rows. */
  private async planScreens(run: Run): Promise<void> {
    const { report } = run;
    const { spec } = this.snapshot(run);
    const existing = await this.deps.repo.sections(report.id);
    if (existing.some((s) => s.role === 'screen')) return;
    const docTitles = existing.filter((s) => s.role === 'section').map((s) => s.title);
    let screens: PlannedScreen[] | null = null;
    let error: string | undefined;
    for (let attempt = 0; attempt < 2 && !screens; attempt++) {
      this.checkpoint(run);
      try {
        const answer = await this.ask(run, {
          source: 'report-outline',
          maxTokens: SCREEN_PLAN_MAX_TOKENS,
          temperature: 0.3,
          build: () => buildScreenPlanMessages(spec, report.variables, docTitles, error),
        });
        const parsed = parseScreenPlan(answer.text);
        if (parsed.ok) screens = parsed.screens;
        else error = parsed.error;
      } catch (err) {
        if (run.signal.aborted || !(err instanceof LlmError) || !err.soft) throw err;
        error = err.message;
      }
    }
    if (!screens) {
      await this.addWarning(
        run,
        'Não foi possível ler o plano de telas do modelo; usei a lista informada no pedido.',
      );
      screens = fallbackScreens(report.variables);
    }
    const now = this.deps.clock.now();
    await this.deps.repo.addSections(
      screens.map((screen, i) => ({
        reportId: report.id,
        ordinal: existing.length + i + 1,
        title: screen.title,
        requirements: screen.objective,
        role: 'screen' as const,
        status: 'pending' as const,
        markdown: '',
        html: null,
        noteIds: [],
        model: null,
        providerId: null,
        warnings: [],
        error: null,
        updatedAt: now,
      })),
    );
  }

  /* -------- writing -------- */

  private async writePhase(run: Run): Promise<void> {
    const { repo } = this.deps;
    const { report } = run;
    const sections = await repo.sections(report.id);
    const total = sections.length;
    let consecutive = 0;
    for (const section of sections) {
      if (section.status === 'done') continue;
      this.checkpoint(run);
      await this.setProgress(run, 'writing', section.ordinal, total, section.title);
      await repo.updateSection(report.id, section.ordinal, {
        status: 'writing',
        error: null,
        updatedAt: this.deps.clock.now(),
      });
      try {
        const all = await repo.sections(report.id);
        const done = all.filter((s) => s.status === 'done' && s.ordinal !== section.ordinal);
        const written =
          section.role === 'screen'
            ? await this.writeScreen(run, section, all, {})
            : await this.writeSection(run, section, total, {
                previous: done.filter((s) => s.role === 'section'),
              });
        await repo.updateSection(report.id, section.ordinal, {
          status: 'done',
          error: null,
          updatedAt: this.deps.clock.now(),
          ...written,
        });
        consecutive = 0;
      } catch (err) {
        if (run.signal.aborted) {
          await repo
            .updateSection(report.id, section.ordinal, { status: 'pending' })
            .catch(() => undefined);
          throw err;
        }
        if (err instanceof LlmError && !err.soft) {
          // provider-level failure: keep the section for the next try and end the job
          await repo.updateSection(report.id, section.ordinal, { status: 'pending' });
          throw err;
        }
        const message =
          err instanceof LlmError ? err.message : 'Falha inesperada ao escrever a seção';
        if (!(err instanceof LlmError)) this.deps.onError?.(err, report.id);
        await repo.updateSection(report.id, section.ordinal, {
          status: 'error',
          error: shortText(message, 300),
          updatedAt: this.deps.clock.now(),
        });
        consecutive += 1;
        if (consecutive >= MAX_CONSECUTIVE_SECTION_FAILURES)
          throw new LlmError(
            `Várias seções falharam em sequência (${shortText(message, 160)}). Use Retomar ou escolha outro modelo.`,
            'repeated_failures',
          );
      }
    }
    const final = await repo.sections(report.id);
    if (final.length > 0 && final.every((s) => s.status === 'error'))
      throw new LlmError(
        'Nenhuma seção pôde ser gerada. Use Retomar ou escolha outro modelo.',
        'no_sections',
      );
  }

  private async writeSection(
    run: Run,
    section: ReportSection,
    total: number,
    options: { previous: ReportSection[]; instructions?: string; currentText?: string },
  ): Promise<Pick<ReportSection, 'markdown' | 'model' | 'providerId' | 'warnings' | 'noteIds'>> {
    const { report, settings } = run;
    const { spec } = this.snapshot(run);
    const templateSection = spec.sections[section.ordinal - 1] ?? spec.sections[0]!;
    const entry = report.outline?.find((o) => o.ordinal === section.ordinal);
    const byId = new Map(run.notes.map((n) => [n.id, n]));
    const noteIds = (entry?.noteIds ?? []).filter((id) => byId.has(id));
    const prompt: PromptNote[] = noteIds.map((id, i) => {
      const note = byId.get(id)!;
      return {
        id: `n${i + 1}`,
        source: note.source,
        label: noteLabel(note),
        content: note.content,
      };
    });
    const base = {
      spec,
      vars: report.variables,
      documentTitle: report.title,
      section: templateSection,
      title: section.title,
      requirements: section.requirements,
      index: section.ordinal,
      total,
      points: entry?.points ?? [],
      previous: previousDigest(
        options.previous.map((s) => ({ title: s.title, markdown: s.markdown })),
      ),
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.currentText ? { currentText: options.currentText } : {}),
    };
    const fixed = estimateRequestTokens(
      buildSectionMessages({ ...base, notes: [], notesChars: 0 }),
    );
    const notesChars = Math.max(
      MIN_NOTES_CHARS,
      Math.floor((run.budget - fixed - settings.sectionMaxTokens) * 4 * SECTION_NOTES_SHARE),
    );

    let used: string[] = [];
    let result: LlmResult | null = null;
    let text = '';
    for (let attempt = 0; attempt < 2 && !text.trim(); attempt++) {
      result = await this.ask(run, {
        source: 'report-section',
        maxTokens: settings.sectionMaxTokens,
        temperature: 0.3,
        build: (scale) => {
          const chars = Math.max(500, Math.floor(notesChars * scale));
          used = selectNotes(prompt, chars).used;
          return buildSectionMessages({ ...base, notes: prompt, notesChars: chars });
        },
      });
      text = result.text;
    }
    if (!result || !text.trim())
      throw new LlmError('O modelo devolveu uma resposta vazia', 'empty');
    const prepared = prepareSectionMarkdown(text, section.title, templateSection);
    if (!prepared.markdown.trim())
      throw new LlmError('O modelo devolveu uma resposta vazia', 'empty');
    const checked = await this.deps.diagrams.prepare(prepared.markdown, {
      model: run.model,
      label: `seção "${section.title}"`,
      signal: run.signal,
    });
    await this.countRepairs(run, checked.repaired);
    const usedIds = used
      .map((alias) => noteIds[Number(alias.slice(1)) - 1])
      .filter((id): id is string => !!id);
    return {
      markdown: checked.markdown,
      model: result.model,
      providerId: result.providerId,
      warnings: [...prepared.warnings, ...checked.warnings],
      noteIds: usedIds,
    };
  }

  /** Remembers (in the report meta) how many diagrams the model had to repair. */
  private async countRepairs(run: Run, repaired: number): Promise<void> {
    if (repaired <= 0) return;
    const { meta } = run.report;
    run.report.meta = {
      ...meta,
      diagrams: { ...meta.diagrams, repaired: meta.diagrams.repaired + repaired },
    };
    await this.deps.repo.update(run.report.id, { meta: run.report.meta });
  }

  /** Prototype screen: a Markdown description plus a sanitized HTML fragment. */
  private async writeScreen(
    run: Run,
    section: ReportSection,
    all: ReportSection[],
    options: { instructions?: string },
  ): Promise<
    Pick<ReportSection, 'markdown' | 'html' | 'model' | 'providerId' | 'warnings' | 'noteIds'>
  > {
    const { report, settings } = run;
    const { spec } = this.snapshot(run);
    const screens = all.filter((s) => s.role === 'screen');
    const slugs = screenSlugs(screens.map((s) => s.title));
    const base = {
      spec,
      vars: report.variables,
      documentTitle: report.title,
      title: section.title,
      objective: section.requirements,
      screens: screens.map((s, i) => ({ title: s.title, slug: slugs[i]! })),
      digest: previousDigest(
        all
          .filter((s) => s.role === 'section' && s.status === 'done')
          .map((s) => ({ title: s.title, markdown: s.markdown })),
        2_500,
      ),
      ...(options.instructions ? { instructions: options.instructions } : {}),
    };
    const maxTokens = Math.min(8_000, Math.max(2_000, Math.floor(settings.sectionMaxTokens * 1.5)));
    let result: LlmResult | null = null;
    let html = '';
    let description = '';
    for (let attempt = 0; attempt < 2 && !html; attempt++) {
      result = await this.ask(run, {
        source: 'report-section',
        maxTokens,
        temperature: 0.4,
        build: () => buildScreenMessages(base),
      });
      const extracted = extractScreen(result.text);
      if (extracted) {
        html = this.deps.markdown.sanitizePrototype(extracted.html);
        description = extracted.description;
      }
    }
    if (!result || !html.trim())
      throw new LlmError('O modelo não devolveu o HTML da tela', 'empty');
    return {
      markdown: description,
      html,
      model: result.model,
      providerId: result.providerId,
      warnings: [],
      noteIds: [],
    };
  }

  /* -------- assembly -------- */

  private async assemble(run: Run, restore?: { finishedAt: number | null }): Promise<void> {
    const { repo } = this.deps;
    const { report } = run;
    this.checkpoint(run);
    await this.setProgress(run, 'assembling', 0, 0);
    const sections = await repo.sections(report.id);
    const notes = await repo.notes(report.id);
    const now = this.deps.clock.now();
    const models = mergeUnique(
      report.meta.models,
      sections.map((s) => s.model ?? '').filter(Boolean),
    );
    const built = await this.deps.documents.build(
      report,
      sections,
      { ...report.meta, models, sources: sourcesFromNotes(notes) },
      now,
      run.signal,
    );
    this.checkpoint(run);
    report.meta = built.meta;
    report.status = 'done';
    await this.patch(run, {
      status: 'done',
      progress: { phase: 'done', current: 0, total: 0, label: progressLabel('done', 0, 0) },
      markdown: built.markdown,
      // the PDF of an older version is stale (it is rendered again on the next download)
      html: built.html,
      htmlHash: built.htmlHash,
      ...NEW_VERSION_STORAGE_STATE,
      pdfKey: null,
      pdfAt: null,
      meta: built.meta,
      error: null,
      failedPhase: null,
      cancelRequested: false,
      finishedAt: restore?.finishedAt ?? now,
    });
    this.deps.onAssembled?.(report.id);
  }

  /* -------- rewrite one section -------- */

  private async rewriteSection(
    run: Run,
    job: Extract<ReportJobSpec, { type: 'section' }>,
  ): Promise<void> {
    const { repo } = this.deps;
    const { report } = run;
    const sections = await repo.sections(report.id);
    const section = sections.find((s) => s.ordinal === job.ordinal);
    if (!section) throw new LlmError('Seção não encontrada', 'not_found');
    const finishedAt = report.finishedAt;
    await this.setProgress(
      run,
      'writing',
      section.ordinal,
      sections.length,
      `reescrevendo "${section.title}"`,
      job,
    );
    await repo.updateSection(report.id, section.ordinal, {
      status: 'writing',
      updatedAt: this.deps.clock.now(),
    });
    try {
      const others = sections.filter(
        (s) => s.role === 'section' && s.status === 'done' && s.ordinal !== section.ordinal,
      );
      const written = await this.writeSection(run, section, sections.length, {
        previous: others,
        instructions: job.instructions,
        ...(section.status === 'done' && section.markdown ? { currentText: section.markdown } : {}),
      });
      await repo.updateSection(report.id, section.ordinal, {
        status: 'done',
        error: null,
        updatedAt: this.deps.clock.now(),
        ...written,
      });
    } catch (err) {
      // the section keeps its previous text: a failed rewrite never destroys a finished document
      if (!isStop(run.signal)) {
        const reason = run.signal.aborted
          ? null
          : err instanceof LlmError
            ? err.message
            : 'falha inesperada';
        await repo.updateSection(report.id, section.ordinal, {
          status:
            section.status === 'done'
              ? 'done'
              : section.status === 'writing'
                ? 'error'
                : section.status,
          warnings: reason
            ? mergeUnique(section.warnings, [
                `Não foi possível reescrever esta seção: ${shortText(reason, 200)}`,
              ])
            : section.warnings,
          updatedAt: this.deps.clock.now(),
        });
        if (reason && !(err instanceof LlmError)) this.deps.onError?.(err, report.id);
      }
      if (isStop(run.signal)) throw err;
    }
    await this.assemble(run, { finishedAt });
  }

  /* ------------------------------ plumbing ------------------------------ */

  private snapshot(run: Run): { spec: Report['templateSnapshot'] } {
    return { spec: run.report.templateSnapshot };
  }

  private toolOutputCap(run: Run): number {
    return Math.max(
      500,
      Math.min(TOOL_OUTPUT_CAP_CHARS, Math.floor(run.budget * 4 * TOOL_OUTPUT_BUDGET_SHARE)),
    );
  }

  private checkpoint(run: Run): void {
    if (run.signal.aborted) throw run.signal.reason ?? cancelSignal();
  }

  /** One LLM call with provider-wait retries (progress label) and one smaller retry on context overflow. */
  private async ask(
    run: Run,
    request: {
      source: string;
      maxTokens: number;
      temperature: number;
      build: (scale: number) => OAIMessage[];
      tools?: ResearchTools['defs'];
    },
  ): Promise<LlmResult> {
    let scale = 1;
    for (let attempt = 0; ; attempt++) {
      let waited = false;
      try {
        const result = await withProviderRetry(
          () =>
            completeChat(
              this.deps.router,
              {
                model: run.model,
                messages: request.build(scale),
                maxTokens: request.maxTokens,
                temperature: request.temperature,
                ...(request.tools ? { tools: request.tools } : {}),
              },
              { source: request.source, signal: run.signal, scope: run.report.id },
            ),
          {
            signal: run.signal,
            sleep: this.sleep,
            onWait: async (next, max) => {
              waited = true;
              await this.deps.repo
                .update(run.report.id, {
                  progress: { ...run.progress, label: waitLabel(next, max) },
                  updatedAt: this.deps.clock.now(),
                })
                .catch(() => undefined);
            },
          },
        );
        if (waited) await this.writeProgress(run);
        this.checkpoint(run);
        await this.recordModel(run, result.model);
        return result;
      } catch (err) {
        if (run.signal.aborted) throw err;
        if (waited) await this.writeProgress(run);
        if (err instanceof LlmError && err.reason === 'context_length' && attempt === 0) {
          scale = 0.5;
          continue;
        }
        throw err;
      }
    }
  }

  private async recordModel(run: Run, model: string): Promise<void> {
    if (run.report.meta.models.includes(model)) return;
    run.report.meta = { ...run.report.meta, models: mergeUnique(run.report.meta.models, [model]) };
    await this.deps.repo.update(run.report.id, { meta: run.report.meta });
  }

  private async addWarning(run: Run, warning: string): Promise<void> {
    const warnings = mergeUnique(run.report.meta.warnings, [warning]);
    if (warnings.length === run.report.meta.warnings.length) return;
    run.report.meta = { ...run.report.meta, warnings };
    await this.deps.repo.update(run.report.id, { meta: run.report.meta });
  }

  private async patch(run: Run, patch: Partial<Omit<Report, 'id'>>): Promise<void> {
    await this.deps.repo.update(run.report.id, { ...patch, updatedAt: this.deps.clock.now() });
  }

  private async setProgress(
    run: Run,
    phase: ReportStatus,
    current: number,
    total: number,
    extra = '',
    job?: ReportProgress['job'],
  ): Promise<void> {
    run.phase = phase;
    run.report.status = phase;
    run.progress = {
      phase,
      current,
      total,
      label: progressLabel(phase, current, total, extra),
      ...(job ? { job } : {}),
    };
    run.report.progress = run.progress;
    await this.patch(run, { status: phase, progress: run.progress });
  }

  private async writeProgress(run: Run): Promise<void> {
    await this.patch(run, { progress: run.progress }).catch(() => undefined);
  }

  /* ------------------------------ end states ------------------------------ */

  private async handleFailure(run: Run, job: ReportJobSpec, err: unknown): Promise<void> {
    const { report } = run;
    if (isStop(run.signal)) return; // server shutdown: stays active, resumed at next boot
    const now = this.deps.clock.now();
    try {
      if (run.signal.aborted || isCancel(err)) {
        if (job.type === 'section') {
          // a canceled rewrite leaves the finished document as it was
          await this.restoreAfterRewrite(run);
          return;
        }
        await this.patch(run, {
          status: 'canceled',
          progress: {
            phase: 'canceled',
            current: 0,
            total: 0,
            label: progressLabel('canceled', 0, 0),
          },
          cancelRequested: false,
          finishedAt: now,
        });
        return;
      }
      const message =
        err instanceof LlmError ? err.message : 'Falha inesperada na geração do documento.';
      if (!(err instanceof LlmError)) this.deps.onError?.(err, report.id);
      if (job.type === 'section') {
        await this.restoreAfterRewrite(run);
        return;
      }
      await this.patch(run, {
        status: 'error',
        progress: {
          phase: 'error',
          current: run.progress.current,
          total: run.progress.total,
          label: progressLabel('error', 0, 0, shortText(message, 120)),
        },
        error: shortText(message, 500),
        failedPhase: run.phase,
        finishedAt: now,
      });
    } catch (inner) {
      // the report may have been deleted while the job was ending
      this.deps.onError?.(inner, report.id);
    }
  }

  /** After a rewrite that did not finish: back to the finished state (the previous text stays). */
  private async restoreAfterRewrite(run: Run): Promise<void> {
    const { report } = run;
    await this.patch(run, {
      status: 'done',
      progress: { phase: 'done', current: 0, total: 0, label: progressLabel('done', 0, 0) },
      cancelRequested: false,
    });
    const sections = await this.deps.repo.sections(report.id);
    for (const s of sections)
      if (s.status === 'writing')
        await this.deps.repo.updateSection(report.id, s.ordinal, {
          status: s.markdown ? 'done' : 'error',
        });
  }
}

/* ------------------------------ helpers ------------------------------ */

const CANCEL = Symbol('report-cancel');
function cancelSignal(): unknown {
  return CANCEL;
}
const isCancel = (err: unknown): boolean => err === CANCEL;
const isStop = (signal: AbortSignal): boolean => signal.aborted && signal.reason === STOP_REASON;

/** Halves (by `scale`) the tool outputs of a conversation: the retry after a context overflow. */
function shrinkToolMessages(messages: OAIMessage[], scale: number): OAIMessage[] {
  return messages.map((m) =>
    m.role === 'tool' && typeof m.content === 'string'
      ? { ...m, content: shortText(m.content, Math.max(300, Math.floor(m.content.length * scale))) }
      : m,
  );
}

function shortText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
