/** The command line was malformed: exit code 2, with the usage text. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Runs `parse`, which calls `parseArgs`, and turns the errors `parseArgs` throws for a bad command
 * line (an unknown option, a missing option value, a stray positional) into a `UsageError`.
 */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (err instanceof Error && typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")) {
      throw new UsageError(err.message);
    }
    throw err;
  }
}

/** The value of a required `--name` option, or a `UsageError` if it was not given. */
export function requireOption(name: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`missing required option --${name}`);
  return value;
}

export interface IntegerRange {
  min?: number;
  max?: number;
}

/**
 * The integer value of `--name`, or undefined if it was not given. Anything else (text, a
 * fraction, a number out of `range`) is an ordinary error, not a usage error: the command line is
 * well formed but its value is wrong.
 */
export function integerOption(
  name: string,
  value: string | undefined,
  range: IntegerRange = {},
): number | undefined {
  if (value === undefined) return undefined;
  const { min = -Infinity, max = Infinity } = range;
  const parsed = /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const expected =
      Number.isFinite(min) && Number.isFinite(max)
        ? `an integer from ${min} to ${max}`
        : "an integer";
    throw new Error(`--${name} must be ${expected}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * The parsed value of a `--input` option, or `{}` if it was not given. Text that is not JSON is an
 * ordinary error, not a usage error: the command line is well formed but its value is wrong.
 */
export function jsonInputOption(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    throw new Error("--input is not valid JSON");
  }
}
