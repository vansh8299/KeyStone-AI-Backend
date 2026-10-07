import { z } from "zod";
import { urlSchema } from "../../shared/validate";

export const LinkArgsSchema = z.object({ url: urlSchema });
