import { z } from "zod";

export const HitlMetadataSchema = z.object({
  type: z.literal("clarification"),
  status: z.enum(["pending", "resolved"]),
  threadId: z.string().min(1),
});
export type HitlMetadata = z.infer<typeof HitlMetadataSchema>;

const MessageMetadataSchema = z.object({ hitl: HitlMetadataSchema }).passthrough();

export function getHitl(metadata: unknown): HitlMetadata | undefined {
  const result = MessageMetadataSchema.safeParse(metadata);
  return result.success ? result.data.hitl : undefined;
}
