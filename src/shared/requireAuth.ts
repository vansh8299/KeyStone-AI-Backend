import { GraphQLContext } from "../context";
import { unauthenticatedError } from "./errors";

export function requireAuth(ctx: GraphQLContext): string {
  if (!ctx.userId) {
    throw unauthenticatedError();
  }
  return ctx.userId;
}
