/**
 * Keystone AI mail trigger — a Google Apps Script web app that sends the OTP emails from your Gmail.
 * The backend POSTs { secret, to, subject, text, html, fromName } to it over HTTPS.
 *
 * Setup (once, free):
 *   1. Signed in as the Gmail account that should send the emails, open https://script.google.com
 *      and click "New project". Replace the editor contents with this file.
 *   2. Set SECRET below to the same value as MAIL_TRIGGER_SECRET in backend/.env.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as: Me        Who has access: Anyone
 *      Click Deploy and allow the permissions it asks for ("Advanced → Go to … (unsafe)" is
 *      expected for your own script).
 *   4. Copy the Web app URL (ends in /exec) into MAIL_TRIGGER_URL in backend/.env and restart.
 *
 * After editing this file, use Deploy → Manage deployments → Edit → Version: New version, so the
 * URL stays the same. Consumer Gmail accounts can send to about 100 recipients a day this way.
 */
const SECRET = "paste MAIL_TRIGGER_SECRET here";

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET.indexOf("paste") === 0 || body.secret !== SECRET) {
      return reply({ ok: false, error: "unauthorized" });
    }
    MailApp.sendEmail({
      to: body.to,
      subject: body.subject,
      body: body.text,
      htmlBody: body.html,
      name: body.fromName || "Keystone AI",
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
