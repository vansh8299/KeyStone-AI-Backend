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

export async function sendMail(message: MailMessage): Promise<void> {
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
