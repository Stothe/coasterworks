import { randomBytes } from "node:crypto";
import { UsageError } from "./args.js";

/** The environment variable that supplies the bearer token when `--token` is not given. */
export const TOKEN_ENV = "COASTERWORKS_MCP_TOKEN";

export interface ResolvedToken {
  token: string;
  /** True when no one supplied the token and this made a random one. */
  generated: boolean;
}

/**
 * The bearer token for a server that needs one: `--token` if given, else the environment variable
 * `COASTERWORKS_MCP_TOKEN` (so it need not appear in a process list), else a random one made here
 * (32 bytes from `node:crypto`, base64url, 43 characters). An empty `--token` is a `UsageError`;
 * an empty variable counts as unset, as a shell's `FOO= cmd` usually means it.
 */
export function resolveToken(flag: string | undefined): ResolvedToken {
  if (flag === "") throw new UsageError("--token must not be empty");
  const fromEnv = process.env[TOKEN_ENV];
  const given = flag ?? (fromEnv === "" ? undefined : fromEnv);
  if (given !== undefined) return { token: given, generated: false };
  return { token: randomBytes(32).toString("base64url"), generated: true };
}
