/**
 * The files the assistant can make from a reply. Each format belongs to a kind, which decides how
 * the model is asked to write the reply and how the file is built from it:
 * - document: the whole reply (Markdown) is the file's content;
 * - spreadsheet: the reply's Markdown tables become the rows;
 * - slides: "#" is the title slide and each "##" section a slide;
 * - code: the one fenced code block in the reply is the file, as written.
 */
export type FileKind = "document" | "spreadsheet" | "slides" | "code";

interface FormatInfo {
  label: string;
  mime: string;
  kind: FileKind;
  /** Code formats: the fence language the model should use (```json). */
  language?: string;
}

const text = (mime: string) => `${mime}; charset=utf-8`;
const code = (label: string, language: string, mime = "text/plain"): FormatInfo => ({
  label,
  mime: text(mime),
  kind: "code",
  language,
});

export const FILE_TYPES = {
  // Documents
  pdf: { label: "PDF", mime: "application/pdf", kind: "document" },
  docx: { label: "Word document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  html: { label: "HTML page", mime: text("text/html"), kind: "document" },
  md: { label: "Markdown file", mime: text("text/markdown"), kind: "document" },
  txt: { label: "text file", mime: text("text/plain"), kind: "document" },
  // Spreadsheets
  xlsx: { label: "Excel spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheet" },
  csv: { label: "CSV file", mime: text("text/csv"), kind: "spreadsheet" },
  tsv: { label: "TSV file", mime: text("text/tab-separated-values"), kind: "spreadsheet" },
  // Presentations
  pptx: { label: "PowerPoint presentation", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "slides" },
  // Data and code
  json: code("JSON file", "json", "application/json"),
  xml: code("XML file", "xml", "application/xml"),
  yaml: code("YAML file", "yaml", "application/yaml"),
  py: code("Python file", "python", "text/x-python"),
  js: code("JavaScript file", "javascript", "text/javascript"),
  ts: code("TypeScript file", "typescript"),
  java: code("Java file", "java", "text/x-java-source"),
  c: code("C file", "c", "text/x-c"),
  cpp: code("C++ file", "cpp", "text/x-c++src"),
  cs: code("C# file", "csharp"),
  go: code("Go file", "go"),
  rb: code("Ruby file", "ruby", "text/x-ruby"),
  php: code("PHP file", "php", "text/x-php"),
  sql: code("SQL file", "sql", "application/sql"),
  sh: code("shell script", "bash", "application/x-sh"),
  css: code("CSS file", "css", "text/css"),
  kt: code("Kotlin file", "kotlin"),
  swift: code("Swift file", "swift"),
  rs: code("Rust file", "rust"),
} as const satisfies Record<string, FormatInfo>;

export type FileFormat = keyof typeof FILE_TYPES;
export const FILE_FORMATS = Object.keys(FILE_TYPES) as [FileFormat, ...FileFormat[]];

export const fileKind = (format: FileFormat): FileKind => FILE_TYPES[format].kind;

/** Names people (and models) use instead of the extension, after lower-casing and dropping symbols. */
export const FORMAT_ALIASES: Record<string, FileFormat> = {
  word: "docx",
  doc: "docx",
  excel: "xlsx",
  xls: "xlsx",
  spreadsheet: "xlsx",
  sheet: "xlsx",
  powerpoint: "pptx",
  ppt: "pptx",
  slides: "pptx",
  presentation: "pptx",
  deck: "pptx",
  markdown: "md",
  text: "txt",
  plaintext: "txt",
  htm: "html",
  webpage: "html",
  yml: "yaml",
  python: "py",
  javascript: "js",
  node: "js",
  typescript: "ts",
  csharp: "cs",
  golang: "go",
  ruby: "rb",
  bash: "sh",
  shell: "sh",
  kotlin: "kt",
  rust: "rs",
  cplusplus: "cpp",
};

/** How the model must write its reply so it can become this file. */
export function fileInstruction(format: FileFormat): string {
  const { label, kind } = FILE_TYPES[format] as FormatInfo;
  const never = `Never say you can't create, attach or send files.`;
  switch (kind) {
    case "spreadsheet":
      return (
        `The user asked for this as a ${label}. It is built automatically from the Markdown ` +
        `table${format === "xlsx" ? "s" : ""} in your reply and offered to them as a download, so put ` +
        `the data in ${format === "xlsx" ? `Markdown tables — one table per worksheet, each right after a "## <sheet name>" heading` : "ONE Markdown table"}. ` +
        `The first row holds the column headers. Keep cells plain values: numbers without currency ` +
        `symbols or thousands separators, dates as YYYY-MM-DD, no formulas or formatting. For dummy ` +
        `or sample data, invent realistic, varied rows (at least 10 unless they say how many). If they ` +
        `refer to data already in the conversation ("this", "that table"), reproduce it exactly. You ` +
        `may add one short sentence before the table. ${never}`
      );
    case "slides":
      return (
        `The user asked for this as a ${label}. It is built automatically from your reply and offered ` +
        `to them as a download, so write the deck in Markdown: a "#" heading is the title slide (an ` +
        `optional short line under it is the subtitle), and each "##" heading starts a new slide ` +
        `whose content is 3-6 short bullet points (sub-bullets allowed) or one small table. Keep ` +
        `bullets brief — slides, not paragraphs. Make 5-10 slides unless they say how many. If they ` +
        `refer to content already in the conversation ("this", "the above"), turn THAT content into ` +
        `the slides. Don't add chat around the deck. ${never}`
      );
    case "code": {
      const language = (FILE_TYPES[format] as FormatInfo).language;
      return (
        `The user asked for this as a ${label} (.${format}). The file is the content of the ONE ` +
        `fenced code block in your reply (\`\`\`${language}), saved exactly as written, so put the ` +
        `complete, working file in it — ${format === "json" ? "valid JSON (no comments or trailing commas)" : "nothing left out or abbreviated"}. ` +
        `If they refer to something already in the conversation, the file must contain THAT. You may ` +
        `add one short sentence before the code block and nothing else. ${never}`
      );
    }
    default:
      return (
        `The user asked for this as a ${label}. Your reply is turned into that file automatically ` +
        `and offered to them as a download, so write the complete document itself in Markdown: a ` +
        `title as a "#" heading, then the content with "##" sections, lists and tables as needed. If ` +
        `they refer to something already in the conversation ("this", "that", "the above", "your ` +
        `last answer"), the file must be built from THAT content: reproduce your earlier answer ` +
        `faithfully (same items, same order, same facts), completing it if it was cut off — unless ` +
        `they ask for it changed (a short version, a summary, translated, reformatted), in which case ` +
        `make that change to the same content without adding new facts. The same goes for attached ` +
        `or remembered content they ask for as a file. ` +
        `${never} Don't add chat around the document (no "Here is your ${label}").`
      );
  }
}
