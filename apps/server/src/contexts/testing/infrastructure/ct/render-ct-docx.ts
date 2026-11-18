import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { DEFAULT_CT_LAYOUT, type CtLayout } from '@thinkflow/shared';
import {
  CtImageMissingError,
  ctAnalysisTitle,
  ctLines,
  ctMissingImageKeys,
  ctUseCaseTitle,
  fitImage,
  type CtDocument,
  type CtImageItem,
  type CtItem,
  type CtUseCase,
} from '../../domain/ct-document';
import { ctLogoOf } from './ct-logo';
import {
  CT_FONT_SIZES,
  CT_SECTION_NUMBERS,
  CT_TEXTS,
  CT_VERSION_COLS,
  CtImageFormatError,
  ctDocumentTitleForFile,
  ctPalette,
  sniffImage,
  type CtPalette,
} from './ct-style';

/*
 * DOCX of the "Caso de Teste CT": A4, 2 cm side margins, real header / footer (logo,
 * PAGE / NUMPAGES fields); font, colors, texts and logo come from the document model. Everything is plain WordprocessingML (no text boxes, floating
 * drawings or macros), so it opens in Word Online as well as in Word and LibreOffice.
 */

/** What the builders need of the model: palette and font. */
interface Look {
  c: CtPalette;
  font: string;
}

const TWIPS_PER_PT = 20;
/** Content width: A4 (11906) minus 2 x 1134 twips (2 cm) margins. */
const CONTENT_TWIPS = 9638;
const PAGE_MARGIN = 1134;
/** Cell padding of the template (5.25 pt). */
const PAD = 105;
const hp = (pt: number): number => Math.round(pt * 2);
const tw = (pt: number): number => Math.round(pt * TWIPS_PER_PT);
const PX_PER_PT = 96 / 72;
/** Usable image width inside a bordered block: content minus both paddings (pt -> px). */
const IMAGE_MAX_W_PX = Math.floor(((CONTENT_TWIPS - 2 * PAD) / TWIPS_PER_PT) * PX_PER_PT);
const IMAGE_MAX_H_PX = Math.floor(640 * PX_PER_PT);

const THIN = (color: string, size = 6) => ({ style: BorderStyle.SINGLE, size, color });
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;

function textRuns(
  text: string,
  run: { size?: number; bold?: boolean; italics?: boolean; color?: string; font?: string } = {},
): TextRun[] {
  return ctLines(text).map(
    (line, i) =>
      new TextRun({
        text: line,
        break: i === 0 ? undefined : 1,
        size: run.size === undefined ? undefined : hp(run.size),
        bold: run.bold,
        italics: run.italics,
        color: run.color,
        font: run.font,
      }),
  );
}

/** "1." in blue + " Cabeçalho"; the text is also the heading text for Word's navigation pane. */
function sectionHeading(k: Look, number: string, title: string, firstOnPage = false): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: firstOnPage ? { before: tw(20) } : undefined,
    children: [new TextRun({ text: `${number}.`, color: k.c.blue }), new TextRun(` ${title}`)],
  });
}

function subHeading(label: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(label)] });
}

function cellParagraphs(text: string, run: Parameters<typeof textRuns>[1] = {}): Paragraph[] {
  return [new Paragraph({ children: textRuns(text, run) })];
}

function labelCell(k: Look, text: string, columnSpan = 1): TableCell {
  return new TableCell({
    columnSpan,
    verticalAlign: VerticalAlign.CENTER,
    shading: { type: ShadingType.CLEAR, fill: k.c.labelBg, color: 'auto' },
    children: cellParagraphs(text, {
      size: CT_FONT_SIZES.label,
      bold: true,
      color: k.c.heading,
    }),
  });
}

function valueCell(text: string, columnSpan = 1): TableCell {
  return new TableCell({
    columnSpan,
    verticalAlign: VerticalAlign.CENTER,
    children: cellParagraphs(text, { size: CT_FONT_SIZES.body }),
  });
}

function headerTable(k: Look, doc: CtDocument): Table {
  const q = CONTENT_TWIPS / 4;
  const l = CT_TEXTS.labels;
  const border = THIN(k.c.tableBorder);
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: [Math.floor(q), Math.floor(q), Math.floor(q), CONTENT_TWIPS - 3 * Math.floor(q)],
    layout: TableLayoutType.FIXED,
    margins: { top: 30, bottom: 30, left: PAD, right: PAD },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: [
      new TableRow({ children: [labelCell(k, l.title), valueCell(doc.title, 3)] }),
      new TableRow({
        children: [
          labelCell(k, l.ticketId),
          valueCell(doc.ticketId),
          labelCell(k, l.priority),
          valueCell(doc.priority),
        ],
      }),
      new TableRow({ children: [labelCell(k, l.systemModule), valueCell(doc.systemModule, 3)] }),
      new TableRow({ children: [labelCell(k, l.author), valueCell(doc.author, 3)] }),
    ],
  });
}

function contextBox(k: Look, context: string): Table {
  const side = THIN(k.c.blockBorder);
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: [CONTENT_TWIPS],
    layout: TableLayoutType.FIXED,
    margins: { top: 60, bottom: 60, left: PAD, right: PAD },
    borders: {
      top: side,
      left: side,
      right: side,
      bottom: THIN(k.c.rule, 12),
      insideHorizontal: NONE,
      insideVertical: NONE,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: cellParagraphs(context, { size: CT_FONT_SIZES.body }),
          }),
        ],
      }),
    ],
  });
}

function imageParagraph(k: Look, item: CtImageItem, bytes: Uint8Array, n: number): Paragraph[] {
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new CtImageFormatError(item.key);
  const size = fitImage(item.width, item.height, IMAGE_MAX_W_PX, IMAGE_MAX_H_PX);
  const out: Paragraph[] = [
    new Paragraph({
      keepNext: Boolean(item.caption),
      spacing: { before: tw(2), after: tw(3) },
      children: [
        new ImageRun({
          type: sniffed.type === 'bmp' ? 'bmp' : sniffed.type,
          data: bytes,
          transformation: size,
          altText: {
            name: `Imagem ${n}`,
            title: item.caption?.trim() || `Evidência ${n}`,
            description: item.caption?.trim() || `Captura de tela ${n}`,
          },
        }),
      ],
    }),
  ];
  if (item.caption?.trim()) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: tw(3) },
        children: textRuns(item.caption.trim(), {
          size: CT_FONT_SIZES.label,
          italics: true,
          color: k.c.gray,
        }),
      }),
    );
  }
  return out;
}

function itemParagraphs(
  k: Look,
  item: CtItem,
  images: Map<string, Uint8Array>,
  counter: { n: number },
): Paragraph[] {
  switch (item.kind) {
    case 'text':
      return [new Paragraph({ children: textRuns(item.text, { size: CT_FONT_SIZES.body }) })];
    case 'code':
      // one paragraph per line: Word keeps the monospace run alignment and long lines wrap
      return ctLines(item.text).map(
        (line) =>
          new Paragraph({
            children: [new TextRun({ text: line, font: k.font, size: hp(CT_FONT_SIZES.code) })],
          }),
      );
    case 'image': {
      const bytes = images.get(item.key);
      if (!bytes) throw new CtImageMissingError([item.key]);
      counter.n += 1;
      return imageParagraph(k, item, bytes, counter.n);
    }
  }
}

function useCaseBlock(
  k: Look,
  useCase: CtUseCase,
  index: number,
  images: Map<string, Uint8Array>,
  counter: { n: number },
): Table {
  const side = THIN(k.c.blockBorder);
  const left = Math.round(CONTENT_TWIPS * 0.48);
  const body = useCase.items.flatMap((item) => itemParagraphs(k, item, images, counter));
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: [left, CONTENT_TWIPS - left],
    layout: TableLayoutType.FIXED,
    margins: { top: 40, bottom: 40, left: PAD, right: PAD },
    borders: {
      top: side,
      bottom: side,
      left: side,
      right: side,
      insideHorizontal: side,
      insideVertical: NONE,
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: k.c.labelBg, color: 'auto' },
            children: [
              new Paragraph({
                keepNext: true,
                children: textRuns(ctUseCaseTitle(useCase, index), {
                  size: CT_FONT_SIZES.useCaseTitle,
                  bold: true,
                  color: k.c.heading,
                }),
              }),
            ],
          }),
          new TableCell({
            children: [
              new Paragraph({
                keepNext: true,
                children: textRuns(useCase.status, {
                  size: CT_FONT_SIZES.status,
                  italics: true,
                  color: k.c.green,
                }),
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            columnSpan: 2,
            children: body.length > 0 ? body : [new Paragraph({})],
          }),
        ],
      }),
    ],
  });
}

function versionsTable(k: Look, doc: CtDocument): Table {
  const widths = CT_VERSION_COLS.map((c) => Math.round((CONTENT_TWIPS * c) / 10_000));
  widths[3] = CONTENT_TWIPS - widths[0]! - widths[1]! - widths[2]!;
  const side = THIN(k.c.blockBorder);
  const cell = (text: string, col: number, opts: { header?: boolean }): TableCell =>
    new TableCell({
      width: { size: widths[col]!, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      shading: opts.header
        ? { type: ShadingType.CLEAR, fill: k.c.labelBg, color: 'auto' }
        : undefined,
      children: [
        new Paragraph({
          alignment: opts.header || col < 2 ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: textRuns(text, {
            size: CT_FONT_SIZES.version,
            bold: opts.header,
            color: opts.header ? k.c.heading : undefined,
          }),
        }),
      ],
    });
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    margins: { top: 60, bottom: 60, left: PAD, right: PAD },
    borders: {
      top: side,
      bottom: side,
      left: side,
      right: side,
      insideHorizontal: side,
      insideVertical: side,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: CT_TEXTS.versionHeaders.map((h, i) => cell(h, i, { header: true })),
      }),
      ...doc.versions.map(
        (v) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(v.version, 0, {}),
              cell(v.date, 1, {}),
              cell(v.description, 2, {}),
              cell(v.author, 3, {}),
            ],
          }),
      ),
    ],
  });
}

/** Header: text and logo on opposite sides of a right-aligned tab; null when off or empty. */
function pageHeader(k: Look, layout: CtLayout): Header | null {
  if (!layout.showHeader) return null;
  const logo = ctLogoOf(layout);
  const text = layout.headerText
    ? new TextRun({ text: layout.headerText, size: hp(CT_FONT_SIZES.header), color: k.c.gray })
    : null;
  if (!text && !logo) return null;
  const image = logo
    ? new ImageRun({
        type: logo.type,
        data: logo.bytes,
        transformation: { width: logo.widthPx, height: logo.heightPx },
        altText: { name: 'Logo', title: 'Logotipo', description: 'Logotipo do documento' },
      })
    : null;
  const tab = new TextRun({ text: '\t' });
  const children: ParagraphChild[] = (
    layout.logoPosition === 'left' ? [image, tab, text] : [text, tab, image]
  ).filter((child): child is NonNullable<typeof child> => child !== null);
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIPS }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: k.c.rule, space: 4 } },
        children,
      }),
    ],
  });
}

function pageFooter(k: Look, layout: CtLayout): Footer | null {
  if (!layout.showFooter) return null;
  const gray = { size: hp(CT_FONT_SIZES.footer), color: k.c.gray };
  const children: ParagraphChild[] = [
    new TextRun({
      text: layout.footerText ? `${layout.footerText}   ·   Página ` : 'Página ',
      ...gray,
    }),
    new TextRun({ children: [PageNumber.CURRENT], ...gray }),
    new TextRun({ text: ' de ', ...gray }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], ...gray }),
  ];
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: k.c.rule, space: 4 } },
        children,
      }),
    ],
  });
}

function spacer(pt = 4): Paragraph {
  return new Paragraph({ spacing: { before: 0, after: 0, line: tw(pt), lineRule: 'exact' } });
}

function styleDefs(k: Look) {
  const heading = (id: string, size: number, before: number, after: number) => ({
    id,
    name: id === 'Heading1' ? 'heading 1' : 'heading 2',
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { font: k.font, size: hp(size), bold: true, color: k.c.heading },
    paragraph: {
      keepNext: true,
      spacing: { before: tw(before), after: tw(after) },
      ...(id === 'Heading1'
        ? {
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: k.c.rule, space: 5 },
            },
          }
        : {}),
    },
  });
  return {
    default: {
      document: {
        run: {
          font: k.font,
          size: hp(CT_FONT_SIZES.body),
          color: k.c.text,
          language: { value: 'pt-BR' },
        },
        paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' as const } },
      },
    },
    paragraphStyles: [
      {
        id: 'Title',
        name: 'Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: k.font, size: hp(CT_FONT_SIZES.title), bold: true, color: k.c.heading },
        paragraph: { spacing: { before: 0, after: 0 } },
      },
      heading('Heading1', CT_FONT_SIZES.h1, 34, 8),
      heading('Heading2', CT_FONT_SIZES.h2, 13, 4),
    ],
  };
}

/** Builds the .docx; `images` maps the `key` of every image item to its bytes (PNG/JPEG/GIF). */
export async function renderCtDocx(
  doc: CtDocument,
  images: Map<string, Uint8Array>,
  layout: CtLayout = DEFAULT_CT_LAYOUT,
): Promise<Uint8Array> {
  const missing = ctMissingImageKeys(doc, (key) => images.has(key));
  if (missing.length > 0) throw new CtImageMissingError(missing);

  const k: Look = { c: ctPalette(layout), font: layout.fontFamily };
  const n = CT_SECTION_NUMBERS;
  const counter = { n: 0 };
  const plano: (Paragraph | Table)[] = [];
  doc.useCases.forEach((useCase, i) => {
    if (i > 0) plano.push(spacer());
    plano.push(useCaseBlock(k, useCase, i, images, counter));
  });

  const children: (Paragraph | Table)[] = [
    ...(layout.kicker
      ? [
          new Paragraph({
            spacing: { before: tw(17), after: tw(4) },
            children: [
              new TextRun({
                text: layout.kicker,
                size: hp(CT_FONT_SIZES.kicker),
                color: k.c.blue,
              }),
            ],
          }),
        ]
      : []),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: layout.kicker ? undefined : { before: tw(17) },
      children: [new TextRun(layout.title)],
    }),
    sectionHeading(k, n.header, CT_TEXTS.s1, true),
    headerTable(k, doc),
    sectionHeading(k, n.analysis, ctAnalysisTitle(doc)),
    subHeading(`${n.context}. ${CT_TEXTS.s2sub}`),
    contextBox(k, doc.context),
    sectionHeading(k, n.plan, CT_TEXTS.s3),
    subHeading(`${n.criteria}. ${CT_TEXTS.s3sub}`),
    ...(plano.length > 0 ? plano : [spacer()]),
    sectionHeading(k, n.versions, CT_TEXTS.versions),
    versionsTable(k, doc),
    spacer(),
  ];

  const header = pageHeader(k, layout);
  const footer = pageFooter(k, layout);
  const file = new Document({
    creator: doc.author.trim() || 'Thinkflow',
    title: ctDocumentTitleForFile(doc),
    subject: layout.title,
    styles: styleDefs(k),
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
              right: PAGE_MARGIN,
              header: tw(21.6),
              footer: tw(33),
            },
          },
        },
        ...(header ? { headers: { default: header } } : {}),
        ...(footer ? { footers: { default: footer } } : {}),
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(file));
}
