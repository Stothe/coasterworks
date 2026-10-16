import { z } from "zod";
import type { ExecResult } from "@coasterworks/sim";

/** Version of the wire protocol. The host refuses a `hello` that names any other. */
export const PROTOCOL_VERSION = 1;

/** Thrown for anything wrong on the wire: a bad frame, a refused request, a closed connection. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Same shape as the sim's `QueryResult`, with the result typed for whoever asked. */
export type QueryResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

/** Game speed: 0 is paused, the rest multiply the 40 ticks per second of 1x. */
export const SpeedSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(4),
  z.literal(8),
]);
export type Speed = z.infer<typeof SpeedSchema>;

/** Ids are chosen by the client and echoed by the host to pair a reply with its request. */
const IdSchema = z.number().int().positive();
const NameSchema = z.string();

// Client to host.

export const HelloMessageSchema = z.object({ t: z.literal("hello"), protocol: z.number().int() });
export const CommandMessageSchema = z.object({
  t: z.literal("command"),
  id: IdSchema,
  name: NameSchema,
  // A JSON frame cannot carry `undefined`, so a missing `input` is how it arrives.
  input: z.unknown().optional(),
});
export const QueryMessageSchema = z.object({
  t: z.literal("query"),
  id: IdSchema,
  name: NameSchema,
  input: z.unknown().optional(),
});
export const UndoMessageSchema = z.object({ t: z.literal("undo"), id: IdSchema });
export const RedoMessageSchema = z.object({ t: z.literal("redo"), id: IdSchema });
export const SpeedMessageSchema = z.object({
  t: z.literal("speed"),
  id: IdSchema,
  speed: SpeedSchema,
});
export const SnapshotMessageSchema = z.object({ t: z.literal("snapshot"), id: IdSchema });

export const ClientMessageSchema = z.discriminatedUnion("t", [
  HelloMessageSchema,
  CommandMessageSchema,
  QueryMessageSchema,
  UndoMessageSchema,
  RedoMessageSchema,
  SpeedMessageSchema,
  SnapshotMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type QueryMessage = z.infer<typeof QueryMessageSchema>;
export type UndoMessage = z.infer<typeof UndoMessageSchema>;
export type RedoMessage = z.infer<typeof RedoMessageSchema>;
export type SpeedMessage = z.infer<typeof SpeedMessageSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Host to client.

export const WelcomeMessageSchema = z.object({
  t: z.literal("welcome"),
  protocol: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string(),
  speed: SpeedSchema,
});

/** What a `result` carries: a command's `ExecResult`, a query's `QueryResult`, or a bare ack. */
export const ResultPayloadSchema = z.union([
  z.object({ ok: z.literal(true), id: z.number().int(), cost: z.number().int() }),
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ResultPayload = ExecResult | QueryResult | { ok: true };

export const ResultMessageSchema = z.object({
  t: z.literal("result"),
  id: IdSchema,
  result: ResultPayloadSchema,
});

/** A log entry as clients see it: the `undo` data stays on the host. */
export const LogEntryPublicSchema = z.object({
  id: z.number().int(),
  tick: z.number().int().nonnegative(),
  client: z.enum(["player", "agent", "replay", "system"]),
  name: z.string(),
  input: z.unknown().optional(),
  cost: z.number().int(),
  undoneBy: z.number().int().optional(),
});
export type LogEntryPublic = z.infer<typeof LogEntryPublicSchema>;

export const EventMessageSchema = z.object({
  t: z.literal("event"),
  kind: z.literal("log"),
  entry: LogEntryPublicSchema,
});

export const ErrorMessageSchema = z.object({
  t: z.literal("error"),
  id: IdSchema.optional(),
  message: z.string(),
});

export const HostMessageSchema = z.discriminatedUnion("t", [
  WelcomeMessageSchema,
  ResultMessageSchema,
  EventMessageSchema,
  ErrorMessageSchema,
]);

export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type ResultMessage = z.infer<typeof ResultMessageSchema>;
export type EventMessage = z.infer<typeof EventMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;

/**
 * What a parse failure carries. `id` is the request id, when the frame was an object that had a
 * valid one, so the sender of the bad frame can be told which request failed.
 */
export type ParseFailure = { error: string; id?: number };

const MAX_ECHOED_TYPE = 40;

function parseMessage<T>(
  text: string,
  schema: z.ZodType<T>,
  known: readonly string[],
): T | ParseFailure {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "Message is not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "Message must be a JSON object" };
  }
  const fields = value as Record<string, unknown>;
  const id = IdSchema.safeParse(fields.id);
  const fail = (error: string): ParseFailure => (id.success ? { error, id: id.data } : { error });

  const kind = fields.t;
  if (typeof kind !== "string") return fail("Message needs a string field t");
  if (!known.includes(kind)) return fail(`Unknown message type: ${kind.slice(0, MAX_ECHOED_TYPE)}`);

  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return fail(`Invalid ${kind} message${where}`);
}

const CLIENT_KINDS = ClientMessageSchema.options.map((option) => option.shape.t.value);
const HOST_KINDS = HostMessageSchema.options.map((option) => option.shape.t.value);

/** Parses a text frame sent by a client. Never throws: a bad frame comes back as `{ error }`. */
export function parseClientMessage(text: string): ClientMessage | ParseFailure {
  return parseMessage(text, ClientMessageSchema, CLIENT_KINDS);
}

/** Parses a text frame sent by the host. Never throws: a bad frame comes back as `{ error }`. */
export function parseHostMessage(text: string): HostMessage | ParseFailure {
  return parseMessage(text, HostMessageSchema, HOST_KINDS);
}
