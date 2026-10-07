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
import * as XLSX from "xlsx";
import PptxGenJS from "pptxgenjs";
import { renderHtmlToPdf } from "../loaders/convertToPdf";
import { FILE_FORMATS, FILE_TYPES, FORMAT_ALIASES, type FileFormat } from "./formats";

// Raw HTML in the reply is shown as text, never rendered: the model's output isn't trusted markup.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
type Token = ReturnType<typeof md.parse>[number];

export const FILE_MIME_TYPES = Object.fromEntries(FILE_FORMATS.map((f) => [f, FILE_TYPES[f].mime])) as Record<
  FileFormat,
  string
>;

/** The reply can't become the requested file; `message` is safe to show the user. */
export class ResponseFileError extends Error {}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------------------------
// PDF and HTML: Markdown → styled HTML (→ Chrome's print-to-PDF)
// ---------------------------------------------------------------------------------------------

/** A self-contained page: for print (PDF), or as a downloadable .html centred on screen. */
function styledHtml(markdown: string, title: string, forScreen = false): string {
  return `<!DOCTYPE html>
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
      ${forScreen ? "body { max-width: 820px; margin: 40px auto; padding: 0 24px; }" : ""}
    </style>
  </head>
  <body>${md.render(markdown)}</body>
</html>
`;
}

function toPdf(markdown: string, title: string): Promise<Buffer> {
  return renderHtmlToPdf(styledHtml(markdown, title));
}

// ---------------------------------------------------------------------------------------------
// Plain text: Markdown without its syntax
// ---------------------------------------------------------------------------------------------

/** An inline token's text: formatting dropped, links kept as "text (url)". */
function inlineText(token: Token | undefined): string {
  let out = "";
  let href = "";
  let linkText = "";
  for (const c of token?.children ?? []) {
    if (c.type === "link_open") {
      href = String(c.attrGet("href") ?? "");
      linkText = "";
    } else if (c.type === "link_close") {
      out += href && href !== linkText ? ` (${href})` : "";
      href = "";
    } else {
      const piece = c.type === "text" || c.type === "code_inline" ? c.content : c.type === "softbreak" ? " " : c.type === "hardbreak" ? "\n" : "";
      out += piece;
      if (href) linkText += piece;
    }
  }
  return out;
}

function toText(markdown: string): string {
  const tokens = md.parse(markdown, {});
  const lines: string[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let row: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open": {
        const text = inlineText(tokens[i + 1]);
        lines.push("", text);
        if (t.tag === "h1" || t.tag === "h2") lines.push((t.tag === "h1" ? "=" : "-").repeat(Math.min(text.length, 80)));
        lines.push("");
        i += 2;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open":
        lists.push({ ordered: t.type === "ordered_list_open", n: 0 });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        if (lists.length === 0) lines.push("");
        break;
      case "paragraph_open": {
        const text = inlineText(tokens[i + 1]);
        const list = lists[lists.length - 1];
        if (list && tokens[i - 1]?.type === "list_item_open") {
          list.n++;
          lines.push(`${"  ".repeat(lists.length - 1)}${list.ordered ? `${list.n}.` : "•"} ${text}`);
        } else if (list) {
          lines.push(`${"  ".repeat(lists.length)}${text}`);
        } else {
          lines.push(text, "");
        }
        i += 2;
        break;
      }
      case "fence":
      case "code_block":
        lines.push(...t.content.replace(/\n$/, "").split("\n").map((l) => `    ${l}`), "");
        break;
      case "hr":
        lines.push("----------------------------------------", "");
        break;
      case "tr_open":
        row = [];
        break;
      case "th_open":
      case "td_open":
        row.push(inlineText(tokens[i + 1]));
        break;
      case "tr_close":
        lines.push(row.join(" | "));
        break;
      case "table_close":
        lines.push("");
        break;
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
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

// ---------------------------------------------------------------------------------------------
// Excel / CSV: the reply's Markdown tables → worksheets
// ---------------------------------------------------------------------------------------------

type Cell = string | number;

/** A cell's text without Markdown formatting; plain numbers become numbers so Excel can sum/sort them. */
function cellValue(inline: Token | undefined): Cell {
  const text = (inline?.children ?? [])
    .map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : c.type === "softbreak" ? " " : ""))
    .join("")
    .trim();
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^-?0\d/.test(text)) return Number(text); // not "007" or phone-like ids
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replace(/,/g, ""));
  return text;
}

/** Every Markdown table in the reply, named after the heading just above it. */
function markdownTables(markdown: string): { name: string; rows: Cell[][] }[] {
  const tokens = md.parse(markdown, {});
  const tables: { name: string; rows: Cell[][] }[] = [];
  let heading = "";
  let rows: Cell[][] | null = null;
  let row: Cell[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open") heading = tokens[i + 1]?.content.replace(/[*_`~]/g, "").trim() ?? "";
    else if (t.type === "table_open") rows = [];
    else if (t.type === "tr_open") row = [];
    else if ((t.type === "th_open" || t.type === "td_open") && rows) row.push(cellValue(tokens[i + 1]));
    else if (t.type === "tr_close" && rows) rows.push(row);
    else if (t.type === "table_close" && rows) {
      tables.push({ name: heading, rows });
      rows = null;
    }
  }
  return tables.filter((t) => t.rows.length > 0);
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, and unique in the workbook. */
function sheetName(wanted: string, index: number, used: Set<string>): string {
  const base = (wanted.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || `Sheet ${index + 1}`).slice(0, 31);
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

function tablesOrThrow(markdown: string) {
  const tables = markdownTables(markdown);
  if (tables.length === 0) throw new ResponseFileError("The reply had no table to put in a spreadsheet. Ask again for the data as a table.");
  return tables;
}

async function toXlsx(markdown: string, title: string): Promise<Buffer> {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: title };
  const used = new Set<string>();
  tablesOrThrow(markdown).forEach((table, i) => {
    const sheet = XLSX.utils.aoa_to_sheet(table.rows);
    // Columns as wide as their longest value (within reason), so nothing shows as ####.
    const widths = table.rows[0].map((_, col) =>
      Math.min(50, Math.max(8, ...table.rows.map((r) => String(r[col] ?? "").length + 2)))
    );
    sheet["!cols"] = widths.map((wch) => ({ wch }));
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: table.rows.length - 1, c: widths.length - 1 } }) };
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName(table.name, i, used));
  });
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function toDelimited(markdown: string, separator: "," | "\t"): Promise<Buffer> {
  const [table] = tablesOrThrow(markdown);
  const text = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(table.rows), { FS: separator });
  // The byte-order mark makes Excel read the file as UTF-8 (₹, accents, non-Latin text).
  return Buffer.from(`\uFEFF${text}\n`, "utf8");
}

// ---------------------------------------------------------------------------------------------
// PowerPoint: "#" title slide, then one slide per "##" section
// ---------------------------------------------------------------------------------------------

interface SlideBullet {
  text: string;
  level: number;
  ordered?: boolean;
  bold?: boolean;
  plain?: boolean;
}

interface SlideContent {
  title: string;
  bullets: SlideBullet[];
  tables: string[][][];
  code: string[];
}

function slidesFrom(markdown: string, fallbackTitle: string): { title: string; subtitle: string; slides: SlideContent[] } {
  const tokens = md.parse(markdown, {});
  let deckTitle = "";
  let subtitle = "";
  const slides: SlideContent[] = [];
  let current: SlideContent | null = null;
  const lists: { ordered: boolean }[] = [];
  let table: string[][] | null = null;
  let row: string[] = [];
  const slide = () => {
    if (!current) {
      current = { title: deckTitle || fallbackTitle, bullets: [], tables: [], code: [] };
      slides.push(current);
    }
    return current;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open": {
        const text = inlineText(tokens[i + 1]);
        if (t.tag === "h1" && !deckTitle && slides.length === 0) deckTitle = text;
        else if (t.tag === "h1" || t.tag === "h2") {
          current = { title: text, bullets: [], tables: [], code: [] };
          slides.push(current);
        } else slide().bullets.push({ text, level: 0, bold: true, plain: true });
        i += 2;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open":
        lists.push({ ordered: t.type === "ordered_list_open" });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        break;
      case "paragraph_open": {
        const text = inlineText(tokens[i + 1]);
        const list = lists[lists.length - 1];
        if (!current && deckTitle && !list && !subtitle) subtitle = text; // a line under the title
        else if (list && tokens[i - 1]?.type === "list_item_open") {
          slide().bullets.push({ text, level: Math.min(lists.length - 1, 4), ordered: list.ordered });
        } else slide().bullets.push({ text, level: Math.min(lists.length, 4), plain: true });
        i += 2;
        break;
      }
      case "fence":
      case "code_block":
        slide().code.push(t.content.replace(/\n$/, ""));
        break;
      case "table_open":
        table = [];
        break;
      case "tr_open":
        row = [];
        break;
      case "th_open":
      case "td_open":
        row.push(inlineText(tokens[i + 1]));
        break;
      case "tr_close":
        table?.push(row);
        break;
      case "table_close":
        if (table?.length) slide().tables.push(table);
        table = null;
        break;
    }
  }
  return { title: deckTitle || fallbackTitle, subtitle, slides };
}

const SLIDE = { w: 13.333, h: 7.5, margin: 0.6, ink: "1F2328", dim: "57606A", accent: "2563EB", line: "D0D7DE" };

async function toPptx(markdown: string, title: string): Promise<Buffer> {
  const deck = slidesFrom(markdown, title);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  const width = SLIDE.w - 2 * SLIDE.margin;

  const cover = pptx.addSlide();
  cover.background = { color: SLIDE.ink };
  cover.addText(deck.title, { x: SLIDE.margin, y: 2.4, w: width, h: 1.5, fontSize: 40, bold: true, color: "FFFFFF", fit: "shrink" });
  cover.addShape("rect", { x: SLIDE.margin, y: 3.95, w: 1.4, h: 0.07, fill: { color: SLIDE.accent }, line: { color: SLIDE.accent } });
  if (deck.subtitle) cover.addText(deck.subtitle, { x: SLIDE.margin, y: 4.2, w: width, h: 1, fontSize: 20, color: "C9D1D9", fit: "shrink" });

  deck.slides.forEach((content, index) => {
    const s = pptx.addSlide();
    s.addText(content.title, { x: SLIDE.margin, y: 0.35, w: width, h: 0.9, fontSize: 28, bold: true, color: SLIDE.ink, fit: "shrink" });
    s.addShape("rect", { x: SLIDE.margin, y: 1.25, w: 1.2, h: 0.06, fill: { color: SLIDE.accent }, line: { color: SLIDE.accent } });
    s.addText(String(index + 2), { x: SLIDE.w - 1.2, y: SLIDE.h - 0.55, w: 0.6, h: 0.3, fontSize: 10, color: SLIDE.dim, align: "right" });

    // The body (y 1.55 to 6.85) is shared between bullets, tables and code, in that order.
    const parts = [content.bullets.length > 0, ...content.tables.map(() => true), ...content.code.map(() => true)].filter(Boolean).length;
    let y = 1.55;
    const share = (5.3 - 0.15 * Math.max(0, parts - 1)) / Math.max(1, parts);

    if (content.bullets.length > 0) {
      s.addText(
        content.bullets.map((b) => ({
          text: b.text,
          options: {
            bullet: b.plain ? false : b.ordered ? { type: "number" as const } : true,
            indentLevel: b.level,
            bold: b.bold,
            breakLine: true,
            paraSpaceAfter: 6,
          },
        })),
        { x: SLIDE.margin, y, w: width, h: share, fontSize: 18, color: SLIDE.ink, valign: "top", fit: "shrink" }
      );
      y += share + 0.15;
    }
    for (const rows of content.tables) {
      s.addTable(
        rows.map((r, i) => r.map((cell) => ({ text: cell, options: i === 0 ? { bold: true, fill: { color: "F2F4F7" } } : {} }))),
        { x: SLIDE.margin, y, w: width, fontSize: rows.length > 8 ? 11 : 13, color: SLIDE.ink, border: { type: "solid", pt: 1, color: SLIDE.line }, valign: "middle" }
      );
      y += share + 0.15;
    }
    for (const snippet of content.code) {
      s.addText(snippet, {
        x: SLIDE.margin, y, w: width, h: share, fontFace: "Consolas", fontSize: 12, color: SLIDE.ink,
        fill: { color: "F6F8FA" }, line: { color: SLIDE.line, width: 1 }, valign: "top", fit: "shrink", margin: 8,
      });
      y += share + 0.15;
    }
  });

  if (deck.slides.length === 0) throw new ResponseFileError("The reply had no slide content. Ask again for the presentation.");
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

// ---------------------------------------------------------------------------------------------
// Data and code: the reply's code block, saved as written
// ---------------------------------------------------------------------------------------------

function codeFile(markdown: string, format: FileFormat): Buffer {
  const fences = md.parse(markdown, {}).filter((t) => t.type === "fence" || t.type === "code_block");
  const { label } = FILE_TYPES[format];
  if (fences.length === 0) {
    throw new ResponseFileError(`The reply had no code block to save as a ${label}. Ask again for the file.`);
  }
  // The block labelled with this language, else the longest one.
  const language = "language" in FILE_TYPES[format] ? (FILE_TYPES[format] as { language: string }).language : format;
  const named = fences.find((f) => {
    const info = f.info.trim().toLowerCase().split(/\s+/)[0] ?? "";
    return info === language || info === format || FORMAT_ALIASES[info] === format;
  });
  let content = (named ?? fences.reduce((a, b) => (b.content.length > a.content.length ? b : a))).content;
  if (format === "json") {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      throw new ResponseFileError("The reply's JSON wasn't valid, so the file wasn't made. Ask again for the JSON file.");
    }
  }
  return Buffer.from(content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

/** Renders a Markdown reply as a downloadable file. */
export async function renderResponseFile(format: FileFormat, markdown: string, title: string): Promise<Buffer> {
  switch (format) {
    case "pdf":
      return toPdf(markdown, title);
    case "docx":
      return toDocx(markdown, title);
    case "html":
      return Buffer.from(styledHtml(markdown, title, true), "utf8");
    case "md":
      return Buffer.from(markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
    case "txt":
      return Buffer.from(toText(markdown), "utf8");
    case "xlsx":
      return toXlsx(markdown, title);
    case "csv":
      return toDelimited(markdown, ",");
    case "tsv":
      return toDelimited(markdown, "\t");
    case "pptx":
      return toPptx(markdown, title);
    default:
      return codeFile(markdown, format);
  }
}

/** The reply's first heading, if it starts with one. */
export function firstHeading(markdown: string): string | null {
  const tokens = md.parse(markdown, {});
  const heading = tokens.findIndex((t) => t.type === "heading_open");
  if (heading === -1) return null;
  const text = tokens[heading + 1]?.content ?? "";
  return text.replace(/[*_`~]/g, "").trim() || null;
}
