import * as Dialog from "@radix-ui/react-dialog";
import type { ExecResult } from "@coasterworks/sim";
import { Command, defaultFilter } from "cmdk";
import { useMemo, useState } from "react";
import type { Action, ActionContext } from "../actions/types";
import type { PushOptions } from "../state/useToasts";
import { uiStore, useUiStore } from "../state/uiStore";
import { ActionForm, type ExecSuccess } from "./ActionForm";
import { formatCents } from "./format";
import { Kbd } from "./kit";

export interface CommandBarProps {
  /** Every action; the bar lists the ones that are not hidden. */
  actions: readonly Action[];
  /** What an action may use. Null before the connection is made: nothing can run yet. */
  ctx: ActionContext | null;
  /** Runs a sim command for a form, and resolves with the sim's answer. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Shows the player a message. */
  notify(text: string, options?: PushOptions): void;
  /** False while the sim's commands are still being fetched. */
  catalogReady?: boolean;
  /** Why they could not be fetched. */
  catalogError?: string;
}

/** What the player is told when a placement starts. */
export const PLACEMENT_HINT = "Click the map to place · Esc to cancel";

const GROUPS = ["Terrain", "Finance", "Park", "View", "Speed", "History", "Time", "Other"] as const;
type Group = (typeof GROUPS)[number];

/** The group an action is listed under. */
function groupOf(action: Action): Group {
  const { id } = action;
  if (action.kind === "ui") {
    if (id === "ui.pause" || id.startsWith("ui.speed.")) return "Speed";
    if (id === "ui.undo" || id === "ui.redo") return "History";
    if (id === "ui.classicView" || id.startsWith("ui.tool.") || id.startsWith("ui.inspector.")) {
      return "View";
    }
    return "Other";
  }
  switch (action.category) {
    case "terrain":
      return "Terrain";
    case "finance":
      return "Finance";
    case "park":
      return "Park";
    case "sim":
      return "Time";
    default:
      return "Other";
  }
}

/** `text` with the characters that mean something in a pattern taken literally. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a search that starts a word of an action's title scores, and one that starts another word. */
const TITLE_WORD = 1;
const KEYWORD_WORD = 0.9;

/**
 * How well `search` matches an action, over the words the player knows it by: its title (the first
 * of `keywords`) and its other keywords. An item's `value` is its id, which is there to tell items
 * apart and is not something to search. Zero is no match.
 *
 * A search that starts a word of the title (`loan` for Take loan) matches best, one that starts a
 * word of another keyword next, and cmdk's fuzzy match, which takes letters in order from anywhere,
 * comes last, below both. cmdk's own score alone favors a match from the first letter of the whole
 * string, so the l, o, a, n of Lower terrain beat the word `loan` itself.
 */
const matchWords = (_value: string, search: string, keywords: string[] = []) => {
  const fuzzy = defaultFilter(keywords.join(" "), search);
  if (fuzzy === 0) return 0;
  const startsAWordOf = new RegExp(`(?:^|[^a-z0-9])${literal(search.trim().toLowerCase())}`);
  if (startsAWordOf.test((keywords[0] ?? "").toLowerCase())) return TITLE_WORD;
  if (startsAWordOf.test(keywords.join(" ").toLowerCase())) return KEYWORD_WORD;
  return (fuzzy * KEYWORD_WORD) / 2;
};

/**
 * The actions that match `search`, in their groups, best first: the group of the best match leads,
 * and so does the best of a group's own actions. Without a search, every action, in the groups' own
 * order. Letters found in order are only for a search no word of any action starts: `lwr` finds
 * Lower terrain, but `loan` is not padded out with whatever else has an l, an o, an a and an n.
 * cmdk would sort the items but not the groups, so the order is made here.
 */
function rankedGroups(actions: readonly Action[], search: string) {
  const scores = new Map<Action, number>();
  for (const action of actions) {
    if (action.hidden) continue;
    const score =
      search === "" ? 1 : matchWords(action.id, search, [action.title, ...action.keywords]);
    if (score > 0) scores.set(action, score);
  }
  const floor = Math.max(0, ...scores.values()) >= KEYWORD_WORD ? KEYWORD_WORD : 0;
  const scoreOf = (action: Action) => scores.get(action) ?? 0;
  return GROUPS.map((name) => {
    const items = [...scores.keys()]
      .filter((action) => groupOf(action) === name && scoreOf(action) >= floor)
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    return { name, items, best: Math.max(0, ...items.map(scoreOf)) };
  })
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.best - a.best);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface ActionListProps {
  actions: readonly Action[];
  isDisabled(action: Action): boolean;
  onChoose(action: Action): void;
  catalogReady: boolean;
  catalogError?: string;
}

/**
 * The search field and the list under it. The search text is its own, so each time the list comes
 * back (from a form, or from the bar being shut and opened) it starts empty. cmdk does the keys and
 * the highlight; the filtering and the order are done here (`shouldFilter` is off).
 */
function ActionList({
  actions,
  isDisabled,
  onChoose,
  catalogReady,
  catalogError,
}: ActionListProps) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => rankedGroups(actions, search), [actions, search]);
  return (
    <Command
      label="Command bar"
      shouldFilter={false}
      loop
      vimBindings={false}
      className="flex min-h-0 flex-col"
    >
      <Command.Input
        // The list comes back (from a form's Back or Escape) with the field already in focus:
        // its form had the focus, and nothing else is there to take it.
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder="Type a command…"
        className="min-h-10 border-b border-line bg-transparent px-3 text-sm text-ink -outline-offset-2 placeholder:text-muted"
      />
      <Command.List className="min-h-0 flex-1 overflow-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          No matching commands
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.name}
            heading={group.name}
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted"
          >
            {group.items.map((action) => (
              <Command.Item
                key={action.id}
                value={action.id}
                keywords={[action.title, ...action.keywords]}
                disabled={isDisabled(action)}
                onSelect={() => onChoose(action)}
                // The row the arrow keys are on is filled and ringed: the ring is drawn inward, so the
                // list's edge does not cut it, and it shows where the fill alone is hard to see.
                className="flex min-h-8 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-fill-strong data-[selected=true]:outline-2 data-[selected=true]:-outline-offset-2 data-[selected=true]:outline-accent"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{action.title}</span>
                  <span className="truncate text-xs text-muted">{action.description}</span>
                </span>
                {action.shortcut !== undefined && <Kbd>{action.shortcut}</Kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-xs text-muted">
        {catalogReady ? (
          <>
            <span className="flex items-center gap-1">
              <Kbd>↑↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> run
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> close
            </span>
          </>
        ) : (
          <span>
            {catalogError === undefined
              ? "Loading commands…"
              : `Could not load the commands: ${catalogError}`}
          </span>
        )}
      </div>
    </Command>
  );
}

/**
 * The ⌘K bar: every action in one searchable list. Choosing one runs it; a command that takes an
 * area closes the bar and starts placing, and one that takes other input shows its form in place of
 * the list. It is a transient palette, not a dialog the player has to answer.
 */
export function CommandBar({
  actions,
  ctx,
  execute,
  notify,
  catalogReady = true,
  catalogError,
}: CommandBarProps) {
  const open = useUiStore((state) => state.commandBarOpen);
  const formAction = useUiStore((state) => state.formAction);

  const isDisabled = (action: Action) => ctx === null || action.enabled?.(ctx) === false;

  const choose = (action: Action) => {
    if (ctx === null || isDisabled(action)) return;
    let result: Promise<void> | void;
    try {
      result = action.run(ctx);
    } catch (error) {
      notify(messageOf(error), { kind: "error" });
      uiStore.getState().closeCommandBar();
      return;
    }
    // A form keeps the bar. Anything else is finished with it, and a placement tells the player
    // what to do next.
    if (uiStore.getState().formAction === null) uiStore.getState().closeCommandBar();
    if (action.placement) notify(PLACEMENT_HINT);
    Promise.resolve(result).catch((error: unknown) => notify(messageOf(error), { kind: "error" }));
  };

  const done = (action: Action, result: ExecSuccess) => {
    uiStore.getState().closeCommandBar();
    notify(result.cost > 0 ? `Charged ${formatCents(result.cost)}` : `${action.title} done`);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) uiStore.getState().openCommandBar();
        else uiStore.getState().closeCommandBar();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          // Escape goes through the store, so that it closes a form before the bar, as it does
          // everywhere else. Preventing it keeps the dialog from closing itself on top of that.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            uiStore.getState().cancel();
          }}
          className="glass fixed top-[14vh] left-1/2 z-50 flex max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 animate-enter flex-col overflow-hidden text-ink"
        >
          <Dialog.Title className="sr-only">Command bar</Dialog.Title>
          {formAction !== null && ctx !== null ? (
            <div className="flex min-h-0 flex-col">
              <h2 className="border-b border-line px-3 py-2 text-sm font-semibold">
                {formAction.title}
              </h2>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <ActionForm
                  action={formAction}
                  ctx={ctx}
                  execute={execute}
                  onDone={(result) => done(formAction, result)}
                  onCancel={() => uiStore.getState().closeForm()}
                />
              </div>
            </div>
          ) : (
            <ActionList
              actions={actions}
              isDisabled={isDisabled}
              onChoose={choose}
              catalogReady={catalogReady}
              {...(catalogError !== undefined && { catalogError })}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
