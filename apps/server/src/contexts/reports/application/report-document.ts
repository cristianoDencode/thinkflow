import {
  assembleBodyMarkdown,
  assembleMarkdown,
  buildToc,
  buildTocHtml,
  formatDate,
  headingIds,
  pdfTemplates,
  renderDocumentHtml,
  type AssemblyInput,
} from '../domain/assembly';
import { artifactVersion } from '../domain/artifact-keys';
import { assemblePrototype, screenSlugs } from '../domain/prototype';
import type { Report, ReportMeta, ReportSection } from '../domain/report';
import type { MarkdownToHtml, PdfOptions } from '../domain/render-ports';
import { renderTemplateText } from '../domain/template';
import type { DiagramService } from './diagram-service';

export interface BuiltDocument {
  markdown: string;
  html: string;
  /** `artifactVersion(html)`: the version segment of the object keys. */
  htmlHash: string;
  meta: ReportMeta;
}

type DocumentSource = Pick<
  Report,
  'title' | 'kind' | 'templateName' | 'templateSnapshot' | 'variables'
>;

export interface ReportDocumentDeps {
  markdown: MarkdownToHtml;
  diagrams: DiagramService;
}

/** Turns the finished sections into the Markdown and the self-contained HTML of the report. */
export class ReportDocumentBuilder {
  constructor(private readonly deps: ReportDocumentDeps) {}

  async build(
    report: DocumentSource,
    sections: ReportSection[],
    meta: ReportMeta,
    generatedAt: number,
    signal?: AbortSignal,
  ): Promise<BuiltDocument> {
    const { spec, layout } = this.parts(report);
    // diagrams of every finished section: SVG for the HTML and the real counts for the appendix
    const written = sections.filter((s) => s.role === 'section' && s.status === 'done');
    const rendered = await this.deps.diagrams.renderAll(
      written.map((s) => s.markdown).join('\n\n'),
      signal,
    );
    const finalMeta: ReportMeta = {
      ...meta,
      diagrams: {
        total: rendered.total,
        rendered: rendered.rendered,
        repaired: meta.diagrams.repaired,
        failed: rendered.failed,
        unvalidated: rendered.unvalidated,
      },
      generatedAt,
    };
    const input: AssemblyInput = {
      title: report.title,
      templateName: report.templateName,
      variables: report.variables,
      variableLabels: Object.fromEntries(spec.variables.map((v) => [v.name, v.label])),
      meta: finalMeta,
      generatedAt,
    };
    const markdown = assembleMarkdown(input, sections);
    const bodyHtml = this.deps.markdown.render(assembleBodyMarkdown(input, sections), {
      svgByHash: rendered.svgByHash,
      headingIds: headingIds(sections),
    });
    const metaLine = `${report.templateName} · ${formatDate(generatedAt)}`;

    if (report.kind === 'prototype') {
      const screens = sections.filter((s) => s.role === 'screen' && s.status === 'done' && s.html);
      const slugs = screenSlugs(sections.filter((s) => s.role === 'screen').map((s) => s.title));
      const slugByOrdinal = new Map(
        sections.filter((s) => s.role === 'screen').map((s, i) => [s.ordinal, slugs[i]!]),
      );
      const html = assemblePrototype({
        title: report.title,
        metaLine,
        layout,
        specHtml: bodyHtml,
        screens: screens.map((s) => ({
          slug: slugByOrdinal.get(s.ordinal)!,
          title: s.title,
          html: s.html!,
        })),
      });
      return { markdown, html, htmlHash: artifactVersion(html), meta: finalMeta };
    }

    const html = renderDocumentHtml({
      title: report.title,
      metaLine,
      layout,
      subtitle: renderTemplateText(layout.coverSubtitle, report.variables),
      tocHtml: buildTocHtml(buildToc(sections)),
      bodyHtml,
    });
    return { markdown, html, htmlHash: artifactVersion(html), meta: finalMeta };
  }

  /** Header/footer and page size of the PDF. */
  pdfOptions(report: DocumentSource): PdfOptions {
    const { layout } = this.parts(report);
    return {
      ...pdfTemplates(layout, report.title, {
        header: renderTemplateText(layout.headerText, report.variables),
        footer: renderTemplateText(layout.footerText, report.variables),
      }),
      pageSize: layout.pageSize,
    };
  }

  private parts(report: DocumentSource) {
    return { spec: report.templateSnapshot, layout: report.templateSnapshot.layout };
  }
}
