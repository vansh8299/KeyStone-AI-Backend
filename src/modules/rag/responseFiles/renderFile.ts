import MarkdownIt from "markdown-it";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";
import { renderHtmlToPdf } from "../loaders/convertToPdf";
import type { FileFormat } from "./fileRequest";

// Raw HTML in the reply is shown as text, never rendered: the model's output isn't trusted markup.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
type Token = ReturnType<typeof md.parse>[number];

export const FILE_MIME_TYPES: Record<FileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------------------------
// PDF: Markdown → HTML → Chrome's print-to-PDF
// ---------------------------------------------------------------------------------------------

async function toPdf(markdown: string, title: string): Promise<Buffer> {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { margin: 22mm 18mm; }
      body { font-family: "Segoe UI", -apple-system, Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #1f2328; }
      h1 { font-size: 22pt; margin: 0 0 14pt; padding-bottom: 6pt; border-bottom: 1px solid #d0d7de; }
      h2 { font-size: 16pt; margin: 20pt 0 8pt; }
      h3 { font-size: 13pt; margin: 16pt 0 6pt; }
      h4, h5, h6 { font-size: 11pt; margin: 14pt 0 4pt; }
      p { margin: 0 0 9pt; }
      ul, ol { margin: 0 0 9pt; padding-left: 20pt; }
      li { margin: 2pt 0; }
      a { color: #0969da; }
      code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; background: #f2f4f7; padding: 1pt 4pt; border-radius: 3pt; }
      pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4pt; padding: 8pt 10pt; white-space: pre-wrap; word-break: break-word; }
      pre code { background: none; padding: 0; }
      blockquote { margin: 0 0 9pt; padding: 2pt 12pt; border-left: 3pt solid #d0d7de; color: #57606a; }
      table { border-collapse: collapse; width: 100%; margin: 0 0 12pt; font-size: 10pt; page-break-inside: auto; }
      th, td { border: 1px solid #d0d7de; padding: 5pt 7pt; text-align: left; vertical-align: top; }
      th { background: #f2f4f7; font-weight: 600; }
      tr { page-break-inside: avoid; }
      hr { border: none; border-top: 1px solid #d0d7de; margin: 14pt 0; }
    </style>
  </head>
  <body>${md.render(markdown)}</body>
</html>`;
  return renderHtmlToPdf(html);
}

// ---------------------------------------------------------------------------------------------
// Word: Markdown tokens → docx paragraphs and tables
// ---------------------------------------------------------------------------------------------

const HEADINGS = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
} as const;

const MONO = "Consolas";

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

/** The runs of one inline token: text with bold/italic/strikethrough/code, line breaks and links. */
function inlineRuns(token: Token | undefined, base: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  const style: RunStyle = { ...base };
  let link: { href: string; runs: TextRun[] } | null = null;

  const text = (value: string, extra: RunStyle = {}) => {
    const s = { ...style, ...extra };
    const run = new TextRun({
      text: value,
      bold: s.bold,
      italics: s.italics,
      strike: s.strike,
      ...(s.code ? { font: MONO, shading: { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" } } : {}),
      ...(link ? { style: "Hyperlink" } : {}),
    });
    if (link) link.runs.push(run);
    else out.push(run);
  };

  for (const child of token?.children ?? []) {
    switch (child.type) {
      case "text":
        text(child.content);
        break;
      case "code_inline":
        text(child.content, { code: true });
        break;
      case "softbreak":
        text(" ");
        break;
      case "hardbreak":
        out.push(new TextRun({ break: 1 }));
        break;
      case "strong_open":
        style.bold = true;
        break;
      case "strong_close":
        style.bold = base.bold;
        break;
      case "em_open":
        style.italics = true;
        break;
      case "em_close":
        style.italics = base.italics;
        break;
      case "s_open":
        style.strike = true;
        break;
      case "s_close":
        style.strike = base.strike;
        break;
      case "link_open":
        link = { href: String(child.attrGet("href") ?? ""), runs: [] };
        break;
      case "link_close":
        if (link) {
          const href = link.href;
          // Only web and mail links become clickable; anything else stays plain text.
          if (/^(https?:|mailto:)/i.test(href)) out.push(new ExternalHyperlink({ link: href, children: link.runs }));
          else out.push(...link.runs);
          link = null;
        }
        break;
      default:
        if (child.content) text(child.content);
    }
  }
  return out;
}

function codeParagraphs(content: string): Paragraph[] {
  const lines = content.replace(/\n$/, "").split("\n");
  return lines.map(
    (line, i) =>
      new Paragraph({
        children: [new TextRun({ text: line || " ", font: MONO, size: 19 })],
        shading: { type: ShadingType.CLEAR, fill: "F6F8FA", color: "auto" },
        spacing: { before: i === 0 ? 60 : 0, after: i === lines.length - 1 ? 160 : 0 },
      })
  );
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D0D7DE" };

/** Builds a table from tokens starting at table_open; returns it and the index after table_close. */
function buildTable(tokens: Token[], start: number): { table: Table; next: number } {
  const rows: TableRow[] = [];
  let cells: TableCell[] = [];
  let header = false;
  let i = start + 1;
  for (; i < tokens.length && tokens[i].type !== "table_close"; i++) {
    const t = tokens[i];
    if (t.type === "thead_open") header = true;
    else if (t.type === "thead_close") header = false;
    else if (t.type === "tr_open") cells = [];
    else if (t.type === "tr_close") rows.push(new TableRow({ children: cells, tableHeader: header }));
    else if (t.type === "th_open" || t.type === "td_open") {
      const inline = tokens[i + 1]?.type === "inline" ? tokens[i + 1] : undefined;
      cells.push(
        new TableCell({
          children: [new Paragraph({ children: inlineRuns(inline, { bold: t.type === "th_open" }) })],
          shading: t.type === "th_open" ? { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER },
        })
      );
    }
  }
  return { table: new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }), next: i + 1 };
}

async function toDocx(markdown: string, title: string): Promise<Buffer> {
  const tokens = md.parse(markdown, {});
  const blocks: (Paragraph | Table)[] = [];
  const lists: { ordered: boolean; instance: number }[] = [];
  let orderedInstances = 0;
  let quoteDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open": {
        const level = HEADINGS[t.tag as keyof typeof HEADINGS] ?? HeadingLevel.HEADING_6;
        blocks.push(new Paragraph({ heading: level, children: inlineRuns(tokens[i + 1]) }));
        i += 2;
        break;
      }
      case "bullet_list_open":
        lists.push({ ordered: false, instance: 0 });
        break;
      case "ordered_list_open":
        lists.push({ ordered: true, instance: ++orderedInstances });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        break;
      case "blockquote_open":
        quoteDepth++;
        break;
      case "blockquote_close":
        quoteDepth--;
        break;
      case "paragraph_open": {
        const inline = tokens[i + 1];
        const list = lists[lists.length - 1];
        // A list item's first paragraph carries its bullet or number; later ones are indented under it.
        const firstInItem = tokens[i - 1]?.type === "list_item_open";
        const options: IParagraphOptions = {
          children: inlineRuns(inline, quoteDepth > 0 ? { italics: true } : {}),
          spacing: { after: list ? 60 : 160 },
          ...(list && firstInItem
            ? list.ordered
              ? { numbering: { reference: "ordered", level: Math.min(lists.length - 1, 8), instance: list.instance } }
              : { bullet: { level: Math.min(lists.length - 1, 8) } }
            : list
              ? { indent: { left: 720 * lists.length } }
              : quoteDepth > 0
                ? { indent: { left: 567 * quoteDepth }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "D0D7DE", space: 8 } } }
                : {}),
        };
        blocks.push(new Paragraph(options));
        i += 2;
        break;
      }
      case "fence":
      case "code_block":
        blocks.push(...codeParagraphs(t.content));
        break;
      case "hr":
        blocks.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D7DE", space: 1 } } }));
        break;
      case "table_open": {
        const { table, next } = buildTable(tokens, i);
        blocks.push(table, new Paragraph({ children: [] }));
        i = next - 1;
        break;
      }
      default:
        break;
    }
  }

  const doc = new Document({
    title,
    creator: "AI Chatbot",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks.length > 0 ? blocks : [new Paragraph({ children: [new TextRun(" ")] })] }],
  });
  return Packer.toBuffer(doc);
}

/** Renders a Markdown reply as a downloadable file. */
export function renderResponseFile(format: FileFormat, markdown: string, title: string): Promise<Buffer> {
  return format === "pdf" ? toPdf(markdown, title) : toDocx(markdown, title);
}

/** The reply's first heading, if it starts with one. */
export function firstHeading(markdown: string): string | null {
  const tokens = md.parse(markdown, {});
  const heading = tokens.findIndex((t) => t.type === "heading_open");
  if (heading === -1) return null;
  const text = tokens[heading + 1]?.content ?? "";
  return text.replace(/[*_`~]/g, "").trim() || null;
}
