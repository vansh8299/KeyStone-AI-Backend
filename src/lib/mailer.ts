import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { serviceUnavailableError } from "../shared/errors";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtp.host) return null;
  transporter ??= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    // Nodemailer waits up to 2 minutes by default; fail fast so the user isn't left on a spinner.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const transport = getTransporter();
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
  }
}
