import { badUserInputError, payloadTooLargeError, serviceUnavailableError } from "../../../shared/errors";
import { LinkReadError } from "./linkFetcher";

/** A link that couldn't be read, as an error the client shows as-is. */
export function toLinkClientError(err: unknown): unknown {
  if (!(err instanceof LinkReadError)) return err;
  switch (err.kind) {
    case "too_large":
      return payloadTooLargeError(err.message);
    case "unreachable":
      return serviceUnavailableError(err.message);
    default:
      return badUserInputError(err.message, { field: "url" });
  }
}
