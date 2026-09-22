import type { GraphQLScalarType } from "graphql";
import type { RequestHandler } from "express";

let cachedScalar: GraphQLScalarType | null = null;
let cachedMiddlewareFactory: ((options?: Record<string, unknown>) => RequestHandler) | null = null;

export async function getUploadScalar(): Promise<GraphQLScalarType> {
  if (cachedScalar) return cachedScalar;
  const mod = await import("graphql-upload/GraphQLUpload.mjs");
  cachedScalar = (mod.default ?? mod) as unknown as GraphQLScalarType;
  return cachedScalar;
}

export async function getGraphqlUploadExpress(): Promise<
  (options?: Record<string, unknown>) => RequestHandler
> {
  if (cachedMiddlewareFactory) return cachedMiddlewareFactory;
  const mod = await import("graphql-upload/graphqlUploadExpress.mjs");
  cachedMiddlewareFactory = (mod.default ?? mod) as unknown as (
    options?: Record<string, unknown>
  ) => RequestHandler;
  return cachedMiddlewareFactory;
}
