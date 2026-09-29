import { unauthenticatedError } from "../shared/errors";

const PUBLIC_OPERATIONS: Record<string, ReadonlySet<string>> = {
  Query: new Set(["me"]),
  Mutation: new Set([
    "signup",
    "verifyEmail",
    "resendVerificationCode",
    "login",
    "requestPasswordReset",
    "resetPassword",
    "refreshToken",
    "logout",
  ]),
  Subscription: new Set(),
};

type Resolver = (parent: unknown, args: unknown, ctx: { userId: string | null }, info: unknown) => unknown;
type ResolverMap = Record<string, unknown>;

function guard(resolve: Resolver): Resolver {
  return (parent, args, ctx, info) => {
    if (!ctx?.userId) throw unauthenticatedError();
    return resolve(parent, args, ctx, info);
  };
}

function guardField(field: unknown): unknown {
  if (typeof field === "function") return guard(field as Resolver);
  if (field && typeof field === "object" && typeof (field as { subscribe?: unknown }).subscribe === "function") {
    const { subscribe } = field as { subscribe: Resolver };
    return { ...field, subscribe: guard(subscribe) };
  }
  return field;
}

export function withAuthGuard(resolverMaps: ResolverMap[]): ResolverMap[] {
  return resolverMaps.map((map) => {
    const guarded: ResolverMap = { ...map };
    for (const [rootType, publicFields] of Object.entries(PUBLIC_OPERATIONS)) {
      const fields = map[rootType] as Record<string, unknown> | undefined;
      if (!fields) continue;
      guarded[rootType] = Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [name, publicFields.has(name) ? field : guardField(field)])
      );
    }
    return guarded;
  });
}
