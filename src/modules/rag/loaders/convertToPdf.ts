import mammoth from "mammoth";
import MarkdownIt from "markdown-it";
import { getExtension } from "./fileType";

const md = new MarkdownIt();

export async function convertToPdfBuffer(fileBuffer: Buffer, filename: string): Promise<Buffer> {
  const html = await toHtml(fileBuffer, filename);
  return renderHtmlToPdf(html);
}

async function toHtml(fileBuffer: Buffer, filename: string): Promise<string> {
  const ext = getExtension(filename);

  switch (ext) {
    case ".docx":
    case ".doc": {
      const { value } = await mammoth.convertToHtml({ buffer: fileBuffer });
      return wrapHtml(value);
    }

    case ".md":
    case ".markdown": {
      const rendered = md.render(fileBuffer.toString("utf-8"));
      return wrapHtml(rendered);
    }

    case ".txt":
    case ".rtf": {
      const text = fileBuffer.toString("utf-8");
      const escaped = escapeHtml(text);
      return wrapHtml(`<pre style="white-space: pre-wrap; font-family: monospace;">${escaped}</pre>`);
    }

    default:
      throw new Error(`convertToPdfBuffer: unsupported extension "${ext}"`);
  }
}

function wrapHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, Arial, sans-serif; font-size: 12pt; line-height: 1.5; padding: 32px; }
      h1, h2, h3 { margin-top: 1.2em; }
      pre { font-size: 10pt; }
    </style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { default: puppeteer } = await import("puppeteer");

  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const browser = await puppeteer.launch({
    headless: true,
    args: runningAsRoot ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith("data:")) request.continue();
      else request.abort("blockedbyclient");
    });
    page.setDefaultTimeout(PDF_RENDER_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: ["load", "domcontentloaded"], timeout: PDF_RENDER_TIMEOUT_MS });
    const pdf = await page.pdf({ format: "A4", printBackground: true, timeout: PDF_RENDER_TIMEOUT_MS });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

const PDF_RENDER_TIMEOUT_MS = 60_000;
