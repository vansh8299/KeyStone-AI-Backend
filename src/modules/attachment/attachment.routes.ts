import { Router } from "express";
import cookieParser from "cookie-parser";
import { verifyAccessToken } from "../auth/auth.utils";
import { attachmentService } from "./attachment.service";
import { ErrorCode } from "../../shared/errors";
import { idSchema } from "../../shared/validate";

export const attachmentRouter = Router();

attachmentRouter.get("/attachments/:id", cookieParser(), async (req, res, next) => {
  try {
    const token = req.cookies?.access_token as string | undefined;
    const userId = token ? verifyAccessToken(token)?.userId : undefined;
    if (!userId) {
      res.status(401).json({ errors: [{ message: "Please log in to continue.", extensions: { code: ErrorCode.UNAUTHENTICATED } }] });
      return;
    }

    const id = idSchema.safeParse(req.params.id);
    const attachment = id.success ? await attachmentService.findForUser(id.data, userId) : null;
    if (!attachment) {
      res.status(404).json({ errors: [{ message: "File not found.", extensions: { code: ErrorCode.NOT_FOUND } }] });
      return;
    }

    res.set({
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.data.length),
      "Content-Disposition": `${attachment.kind === "image" ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.filename)}"`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    res.end(attachment.data);
  } catch (err) {
    next(err);
  }
});
