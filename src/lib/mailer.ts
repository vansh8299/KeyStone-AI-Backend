import { env } from "../config/env";
import { serviceUnavailableError } from "../shared/errors";
import { moduleLogger } from "./logger";

const log = moduleLogger("mail");

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
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
  if (!env.mailTrigger) {
    if (env.isProd) throw serviceUnavailableError("Email isn't configured on this server. Please try again later.");
    // Development without the mail trigger: print the message so the flow can still be completed locally.
    log.info(`MAIL_TRIGGER_URL not set — email not sent (development). To ${message.to}: ${message.subject}\n${message.text}`);
    return;
  }
  try {
    await sendViaMailTrigger(env.mailTrigger, message);
  } catch (err) {
    log.error({ err, subject: message.subject }, "sending email via the mail trigger failed");
    throw serviceUnavailableError("We couldn't send the email. Please try again in a moment.");
  }
}
