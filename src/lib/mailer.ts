import { lookup } from "dns/promises";
import { isIP } from "net";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { serviceUnavailableError } from "../shared/errors";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The SMTP server's IPv4 address. Nodemailer also tries IPv6 whenever the machine has any IPv6
 * interface, but serverless hosts (Vercel, Lambda) often have one with no route out, so the send
 * fails with ENETUNREACH. Falls back to the hostname if there is no IPv4 record.
 */
async function resolveSmtpHost(host: string): Promise<string> {
  if (isIP(host)) return host;
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return host;
  }
}

async function createTransporter(): Promise<Transporter | null> {
  const host = env.smtp.host;
  if (!host) return null;
  return nodemailer.createTransport({
    host: await resolveSmtpHost(host),
    port: env.smtp.port,
    secure: env.smtp.secure,
    // Connecting by IP: still verify the certificate against the real hostname.
    tls: { servername: host },
    // Nodemailer waits up to 2 minutes by default; fail fast so the user isn't left on a spinner.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
}

/** The display name from MAIL_FROM ("Name <address>"); the trigger always sends from its own Gmail account. */
function senderName(from: string): string | undefined {
  return /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1];
}

/**
 * Sends through a Google Apps Script web app (backend/mail-trigger/Code.gs) that emails from the
 * Gmail account it's deployed under. It only needs outbound HTTPS, which hosts such as Render's
 * free tier and many office networks allow while blocking the SMTP ports.
 */
async function sendViaMailTrigger(trigger: { url: string; secret: string }, message: MailMessage): Promise<void> {
  const res = await fetch(trigger.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: trigger.secret, fromName: senderName(env.mailFrom), ...message }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text().catch(() => "");
  let ok = false;
  try {
    ok = (JSON.parse(text) as { ok?: unknown }).ok === true;
  } catch {
    // Apps Script answers with an HTML page when the script throws or the deployment is wrong.
  }
  if (!res.ok || !ok) throw new Error(`Mail trigger responded ${res.status}: ${text.slice(0, 300)}`);
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (env.mailTrigger) {
    try {
      await sendViaMailTrigger(env.mailTrigger, message);
    } catch (err) {
      console.error("[mail] Failed to send email via mail trigger:", err);
      throw serviceUnavailableError("We couldn't send the email. Please try again in a moment.");
    }
    return;
  }

  const transport = await createTransporter();
  if (!transport) {
    if (env.isProd) throw serviceUnavailableError("Email isn't configured on this server. Please try again later.");
    // Development without SMTP: print the message so the flow can still be completed locally.
    console.info(`[mail] SMTP not configured — would send to ${message.to}: ${message.subject}\n${message.text}`);
    return;
  }
  try {
    await transport.sendMail({ from: env.mailFrom, ...message });
  } catch (err) {
    console.error("[mail] Failed to send email:", err);
    throw serviceUnavailableError("We couldn't send the email. Please try again in a moment.");
  } finally {
    transport.close();
  }
}
