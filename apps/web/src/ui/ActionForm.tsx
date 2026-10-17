import type { ExecResult } from "@coasterworks/sim";
import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { fieldsFor } from "../actions/schema";
import type { Action, ActionContext, FormField } from "../actions/types";
import { formatCents } from "./format";
import { Field } from "./kit";

/** What a command that ran gives back. */
export type ExecSuccess = Extract<ExecResult, { ok: true }>;

export interface ActionFormProps {
  /** The action whose input the form asks for. */
  action: Action;
  ctx: ActionContext;
  /** Runs the sim command `name`. It resolves with the sim's answer; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Called once the command has run and was accepted. */
  onDone(result: ExecSuccess): void;
  /** Called by Back and by Escape. */
  onCancel(): void;
  /**
   * True for a form that sits in a panel among other things rather than being the thing the
   * player is doing: it does not take the focus when it appears, and has no Back button.
   */
  inline?: boolean;
}

/** What a field holds while it is edited: the text of a box, a select's value, or a checkbox. */
type Draft = string | boolean;

type Parsed = { ok: true; value: unknown; omit?: true } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });
const OMIT: Parsed = { ok: true, value: undefined, omit: true };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A number the way a message shows it: `5,000,000`; money as `$50,000.00`. */
function show(field: FormField, value: number): string {
  return field.money ? formatCents(value) : value.toLocaleString("en-US");
}

function initialDraft(field: FormField): Draft {
  const given = field.defaultValue;
  switch (field.kind) {
    case "boolean":
      return given === true;
    case "enum": {
      const chosen = field.options?.find((option) => option.value === given);
      // A choice that has to be made starts on the first, so the form can always be submitted.
      return String((chosen ?? (field.required ? field.options?.[0] : undefined))?.value ?? "");
    }
    default:
      if (typeof given !== "string" && typeof given !== "number") return "";
      return field.money && typeof given === "number" ? (given / 100).toFixed(2) : String(given);
  }
}

/** The value a field's draft stands for, or why it cannot be sent. */
function parse(field: FormField, draft: Draft): Parsed {
  if (field.kind === "boolean") return { ok: true, value: draft === true };

  const text = String(draft);
  if (field.kind === "enum") {
    if (text === "") return field.required ? fail("Choose one") : OMIT;
    const chosen = field.options?.find((option) => String(option.value) === text);
    return chosen ? { ok: true, value: chosen.value } : fail("Choose one");
  }

  if (text.trim() === "") return field.required ? fail("Required") : OMIT;
  if (field.kind === "string") return { ok: true, value: text };

  const typed = Number(text);
  if (!Number.isFinite(typed)) return fail("Enter a number");
  // The player types dollars; the sim counts cents.
  const value = field.money ? Math.round(typed * 100) : typed;
  if (field.kind === "integer" && !Number.isInteger(value)) return fail("Must be a whole number");

  const { min, max } = field;
  if (min !== undefined && max !== undefined && (value < min || value > max)) {
    return fail(`Must be between ${show(field, min)} and ${show(field, max)}`);
  }
  if (min !== undefined && value < min) return fail(`Must be at least ${show(field, min)}`);
  if (max !== undefined && value > max) return fail(`Must be at most ${show(field, max)}`);
  return { ok: true, value };
}

/** The hint under a field. Money is asked for in dollars, so a schema's talk of cents is dropped. */
function hintOf(field: FormField): string | undefined {
  if (!field.money) return field.description;
  const note = field.description && !/\bcents?\b/i.test(field.description) ? field.description : "";
  return `${note} In dollars.`.trim();
}

const CONTROL =
  "min-h-8 w-full rounded-lg border border-white/15 bg-white/5 px-2.5 text-sm text-ink outline-none focus-visible:border-accent aria-[invalid=true]:border-[#ffb4b4]";
const BUTTON = "hud-button rounded-lg px-3 text-sm font-medium";

/**
 * A form for an action's input, drawn from its schema. It checks what the player types against the
 * schema's bounds, sends the command itself, and shows the sim's answer when it is a refusal.
 */
export function ActionForm({
  action,
  ctx,
  execute,
  onDone,
  onCancel,
  inline = false,
}: ActionFormProps) {
  const fields = useMemo(() => (action.schema ? fieldsFor(action.schema) : null), [action.schema]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries((fields ?? []).map((field) => [field.name, initialDraft(field)])),
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set at once on submit, where `busy` only changes on the next render: a double click runs once.
  const running = useRef(false);
  const form = useRef<HTMLFormElement>(null);

  if (!fields) {
    return (
      <div className="flex flex-col gap-3">
        <p role="note" className="text-sm">
          This action needs the full UI
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onCancel} className={`${BUTTON} text-muted`}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const parsedFields = fields.map((field) => ({
    field,
    parsed: parse(field, drafts[field.name] ?? initialDraft(field)),
  }));
  const errorFor = (field: FormField): string | undefined => {
    const parsed = parsedFields.find((entry) => entry.field === field)?.parsed;
    const shown = submitted || touched.has(field.name);
    return shown && parsed && !parsed.ok ? parsed.error : undefined;
  };

  const edit = (name: string, draft: Draft) => {
    setDrafts((current) => ({ ...current, [name]: draft }));
    setFailure(null);
  };
  const leave = (name: string) => setTouched((current) => new Set(current).add(name));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (running.current) return;
    setSubmitted(true);

    const input: Record<string, unknown> = {};
    for (const { field, parsed } of parsedFields) {
      if (!parsed.ok) {
        // Take the player to the first thing to put right.
        (form.current?.elements.namedItem(field.name) as HTMLElement | null)?.focus();
        return;
      }
      if (!parsed.omit) input[field.name] = parsed.value;
    }

    running.current = true;
    setBusy(true);
    setFailure(null);
    let result: ExecResult;
    try {
      result = await execute(action.commandName ?? action.id, input);
    } catch (error) {
      result = { ok: false, error: messageOf(error) };
    }
    running.current = false;
    setBusy(false);
    if (result.ok) onDone(result);
    else setFailure(result.error);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // A dialog around the form deals with Escape itself, and says so by preventing it.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onCancel();
  };

  const available = action.enabled ? action.enabled(ctx) : true;

  return (
    <form
      ref={form}
      aria-label={action.title}
      noValidate
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3"
    >
      {fields.map((field, index) => {
        const draft = drafts[field.name] ?? initialDraft(field);
        const common = {
          name: field.name,
          autoFocus: index === 0 && !inline,
          "aria-required": field.required || undefined,
          onBlur: () => leave(field.name),
        };
        let control: ReactElement;
        if (field.kind === "boolean") {
          control = (
            <input
              {...common}
              type="checkbox"
              checked={draft === true}
              onChange={(e) => edit(field.name, e.target.checked)}
              className="size-4 self-start accent-accent"
            />
          );
        } else if (field.kind === "enum") {
          control = (
            <select
              {...common}
              value={String(draft)}
              onChange={(e) => edit(field.name, e.target.value)}
              className={CONTROL}
            >
              {!field.required && <option value="">None</option>}
              {field.options?.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          );
        } else if (field.kind === "string") {
          control = (
            <input
              {...common}
              type="text"
              value={String(draft)}
              onChange={(e) => edit(field.name, e.target.value)}
              className={CONTROL}
            />
          );
        } else {
          const scale = field.money ? 100 : 1;
          control = (
            <input
              {...common}
              type="number"
              step={field.money ? 0.01 : field.kind === "integer" ? 1 : "any"}
              {...(field.min !== undefined && { min: field.min / scale })}
              {...(field.max !== undefined && { max: field.max / scale })}
              value={String(draft)}
              onChange={(e) => edit(field.name, e.target.value)}
              className={CONTROL}
            />
          );
        }
        const hint = hintOf(field);
        const error = errorFor(field);
        return (
          <Field
            key={field.name}
            label={field.label}
            {...(hint !== undefined && { hint })}
            {...(error !== undefined && { error })}
          >
            {control}
          </Field>
        );
      })}
      {failure !== null && (
        <p role="alert" className="text-sm text-[#ffb4b4]">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {!inline && (
          <button type="button" onClick={onCancel} className={`${BUTTON} text-muted`}>
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={busy || !available}
          className={`${BUTTON} bg-accent text-white`}
        >
          {action.title}
        </button>
      </div>
    </form>
  );
}
