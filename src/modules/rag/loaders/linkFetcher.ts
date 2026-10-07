import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";
import { limits } from "../../../config/limits";
import { moduleLogger } from "../../../lib/logger";
import { launchBrowser } from "../../../lib/browser";

const log = moduleLogger("link-fetcher");

export type LinkErrorKind = "private" | "not_found" | "unsupported" | "too_large" | "unreachable";

/** A link that couldn't be read; `message` is safe to show the user. */
export class LinkReadError extends Error {
  constructor(
    readonly kind: LinkErrorKind,
    message: string
  ) {
    super(message);
  }
}

export interface FetchedLink {
  filename: string;
  data: Buffer;
  /** The address that was finally downloaded (after rewrites and redirects). */
  finalUrl: string;
}

const NOT_PUBLIC = "This link isn't publicly accessible.";
const GOOGLE_SHARING_HINT = ' To share it, set General access to "Anyone with the link" in Google\'s Share settings.';

// ---------------------------------------------------------------------------------------------
// Safety: the server fetches whatever link a user gives it, so it must never reach addresses on
// its own network (localhost, the database, cloud metadata at 169.254.169.254, …). Every
// connection, including each redirect, is pinned to an address checked against this list.
// ---------------------------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

function isBlockedAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

const unreachable = () => new LinkReadError("unreachable", "This link points to an address that can't be reached.");

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, family: options.family as number | undefined }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(unreachable() as NodeJS.ErrnoException, "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

// ---------------------------------------------------------------------------------------------
// Share links → direct downloads
// ---------------------------------------------------------------------------------------------

type Provider = "google" | "dropbox" | "github" | "web";

interface Target {
  url: URL;
  provider: Provider;
}

function driveDownload(id: string): URL {
  return new URL(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
}

/** Turns the "view" link people share into the address of the file itself. */
export function directDownload(raw: string): Target {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();

  if (host === "docs.google.com") {
    const m = url.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([\w-]+)/);
    if (m) {
      const [, kind, id] = m;
      const base = `https://docs.google.com/${kind}/d/${id}`;
      // Docs and Slides as PDF (keeps images and page numbers); Sheets as .xlsx (every tab).
      const exported =
        kind === "spreadsheets" ? `${base}/export?format=xlsx` : kind === "presentation" ? `${base}/export/pdf` : `${base}/export?format=pdf`;
      return { url: new URL(exported), provider: "google" };
    }
    return { url, provider: "google" };
  }

  if (host === "drive.google.com") {
    if (/^\/drive\/(?:u\/\d+\/)?folders\//.test(url.pathname)) {
      throw new LinkReadError("unsupported", "This is a Google Drive folder. Share a link to a single file instead.");
    }
    const id = url.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] ?? url.searchParams.get("id");
    if (id) return { url: driveDownload(id), provider: "google" };
    return { url, provider: "google" };
  }

  if (host === "dropbox.com" || host === "www.dropbox.com") {
    url.searchParams.delete("dl");
    url.searchParams.set("dl", "1");
    return { url, provider: "dropbox" };
  }

  if (host === "github.com") {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return { url: new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`), provider: "github" };
  }

  return { url, provider: "web" };
}

// ---------------------------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------------------------

/** Where the big providers send visitors who aren't allowed to see something. */
const LOGIN_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "www.dropbox.com/login",
  "github.com/login",
];

function isLoginUrl(url: URL): boolean {
  const target = `${url.hostname}${url.pathname}`.toLowerCase();
  return LOGIN_HOSTS.some((h) => target.startsWith(h)) || /\/(signin|sign-in|login|servicelogin)\b/i.test(url.pathname);
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: URL;
}

function requestOnce(url: URL, maxBytes: number, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        signal,
        headers: {
          // A normal browser identity: some hosts refuse unknown clients.
          "User-Agent": "Mozilla/5.0 (compatible; AIChatbotLinkReader/1.0)",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0), url });
        }
        const declared = Number(res.headers["content-length"]);
        if (declared > maxBytes) {
          res.destroy();
          return reject(tooLarge(maxBytes));
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(tooLarge(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url }));
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function tooLarge(maxBytes: number) {
  return new LinkReadError("too_large", `This file is too large to read from a link (the limit is ${Math.round(maxBytes / 1024 / 1024)} MB).`);
}

async function download(start: URL, maxBytes: number): Promise<Response> {
  const signal = AbortSignal.timeout(limits.linkFetchTimeoutMs);
  let url = start;
  for (let hop = 0; hop <= limits.linkMaxRedirects; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new LinkReadError("unsupported", "Only http and https links can be read.");
    }
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw unreachable();
    }
    let res: Response;
    try {
      res = await requestOnce(url, maxBytes, signal);
    } catch (err) {
      if (err instanceof LinkReadError) throw err;
      if ((err as { cause?: unknown }).cause instanceof LinkReadError) throw (err as { cause: LinkReadError }).cause;
      const timedOut = signal.aborted || /abort|timeout/i.test(String((err as Error)?.name ?? ""));
      log.info({ err, host: url.hostname }, "downloading a link failed");
      throw new LinkReadError(
        "unreachable",
        timedOut ? "This link took too long to respond." : "This link couldn't be reached. Check the address and try again."
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new LinkReadError("unreachable", "This link redirects nowhere.");
      url = new URL(location, url);
      if (isLoginUrl(url)) throw new LinkReadError("private", NOT_PUBLIC);
      continue;
    }
    return res;
  }
  throw new LinkReadError("unreachable", "This link redirects too many times.");
}

// ---------------------------------------------------------------------------------------------
// What was downloaded
// ---------------------------------------------------------------------------------------------

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function sniffExtension(data: Buffer, contentType: string, nameHint: string): string | null {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8) return "jpg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // Office files are zips; the first entry names tell them apart.
    const index = data.subarray(0, Math.min(data.length, 64 * 1024)).toString("latin1");
    if (index.includes("word/")) return "docx";
    if (index.includes("xl/")) return "xlsx";
    if (index.includes("ppt/")) return "pptx";
    return /\.(docx|xlsx|pptx)$/i.exec(nameHint)?.[1].toLowerCase() ?? "zip";
  }
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return /\.doc$/i.test(nameHint) || contentType.includes("msword") ? "doc" : "xls";
  }
  if (IMAGE_EXT[contentType]) return IMAGE_EXT[contentType];
  if (contentType.includes("html") || /^\s*(<!doctype html|<html)/i.test(data.subarray(0, 512).toString("utf8"))) return "html";
  if (contentType.includes("csv")) return "csv";
  if (contentType.includes("markdown")) return "md";
  if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
    return /\.(md|markdown|csv|txt)$/i.exec(nameHint)?.[1].toLowerCase() ?? "txt";
  }
  return null;
}

function filenameFrom(res: Response): string {
  const disposition = String(res.headers["content-disposition"] ?? "");
  const encoded = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)?.[1];
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/)?.[1];
  let name = "";
  try {
    name = encoded ? decodeURIComponent(encoded) : plain ?? decodeURIComponent(res.url.pathname.split("/").pop() ?? "");
  } catch {
    name = plain ?? "";
  }
  return name.replace(/[\\/\p{Cc}]/gu, "").trim().slice(0, 150);
}

function withExtension(name: string, ext: string, fallback: string): string {
  const base = (name || fallback).replace(/\.[a-z0-9]{1,5}$/i, "");
  return `${base || fallback}.${ext}`;
}

/** A page that asks for a password (or Google's sign-in) rather than showing content. */
function looksLikeLoginPage(html: string): boolean {
  return /type=["']?password/i.test(html) || /accounts\.google\.com\/(ServiceLogin|v3\/signin)/i.test(html);
}

/** Readable text of a web page: its main content without menus, scripts or styles. */
async function pageText(html: string): Promise<{ title: string; text: string }> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Only the downloaded HTML is rendered: no scripts, and no requests (images, frames, …) leave the server.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => (request.url().startsWith("data:") ? request.continue() : request.abort("blockedbyclient")));
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: limits.linkFetchTimeoutMs });
    // Runs in the page (as a string: the backend isn't compiled with browser types).
    return (await page.evaluate(`(() => {
      document
        .querySelectorAll("script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, [aria-hidden='true']")
        .forEach((el) => el.remove());
      const root = document.querySelector("article") || document.querySelector("main") || document.body;
      return { title: document.title.trim(), text: root ? root.innerText.trim() : "" };
    })()`)) as { title: string; text: string };
  } finally {
    await browser.close();
  }
}

/**
 * Downloads a public link the way a signed-out visitor would and returns it as a file: documents
 * (PDF, Word, Excel, CSV, text, Markdown), images, Google Docs/Sheets/Slides (exported), Google
 * Drive and Dropbox files, GitHub files, or a web page's readable text as Markdown. Links that need
 * signing in fail with "This link isn't publicly accessible."
 */
export async function fetchLink(raw: string, maxBytes: number): Promise<FetchedLink> {
  let target: Target;
  try {
    target = directDownload(raw.trim());
  } catch (err) {
    if (err instanceof LinkReadError) throw err;
    throw new LinkReadError("unsupported", "That isn't a valid link.");
  }
  const notPublic = () =>
    new LinkReadError("private", NOT_PUBLIC + (target.provider === "google" ? GOOGLE_SHARING_HINT : ""));

  let res: Response;
  try {
    res = await download(target.url, maxBytes);
  } catch (err) {
    if (err instanceof LinkReadError && err.kind === "private") throw notPublic();
    throw err;
  }

  if (res.status === 401 || res.status === 403) throw notPublic();
  if (res.status === 404 || res.status === 410) {
    // Google answers 404 for files the visitor isn't allowed to see, as well as for missing ones.
    if (target.provider === "google") throw notPublic();
    throw new LinkReadError("not_found", "Nothing was found at this link. Check the address and try again.");
  }
  if (res.status === 429) throw new LinkReadError("unreachable", "This site is limiting requests right now. Try again in a minute.");
  if (res.status < 200 || res.status >= 300) {
    throw new LinkReadError("unreachable", `This link couldn't be downloaded (the site answered ${res.status}).`);
  }
  if (res.body.length === 0) throw new LinkReadError("not_found", "This link returned an empty file.");

  const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const name = filenameFrom(res);
  const ext = sniffExtension(res.body, contentType, name);

  if (ext === "html") {
    const html = res.body.toString("utf8");
    // A share link should have produced the file itself; a page instead means a sign-in wall.
    if (target.provider !== "web" || looksLikeLoginPage(html)) throw notPublic();
    const { title, text } = await pageText(html);
    if (text.replace(/\s/g, "").length < limits.linkPageMinTextChars) {
      throw new LinkReadError(
        "unsupported",
        "This page has no readable text without running its scripts, so it couldn't be read. Try a direct link to the document."
      );
    }
    const heading = title || res.url.hostname;
    return {
      filename: withExtension(heading, "md", res.url.hostname),
      data: Buffer.from(`# ${heading}\n\nSource: ${res.url.href}\n\n${text}\n`, "utf8"),
      finalUrl: res.url.href,
    };
  }

  if (!ext || ext === "zip" || ext === "pptx") {
    throw new LinkReadError(
      "unsupported",
      ext === "pptx"
        ? "PowerPoint files can't be read from a link. Share it as a PDF or a Google Slides link instead."
        : "This link doesn't point to a file type that can be read (PDF, Word, Excel, CSV, text, Markdown, images or a web page)."
    );
  }
  return { filename: withExtension(name, ext, res.url.hostname), data: res.body, finalUrl: res.url.href };
}
