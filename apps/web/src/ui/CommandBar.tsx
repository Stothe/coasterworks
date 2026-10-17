import * as Dialog from "@radix-ui/react-dialog";
import type { ExecResult } from "@coasterworks/sim";
import { Command, defaultFilter } from "cmdk";
import { useMemo } from "react";
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

/**
 * cmdk's fuzzy match, over the words the player knows an action by: its title and keywords. An item's
 * `value` is its id, which is there to tell items apart and is not something to search.
 */
const matchWords = (_value: string, search: string, keywords: string[] = []) =>
  defaultFilter(keywords.join(" "), search);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

  const groups = useMemo(() => {
    const listed = actions.filter((action) => !action.hidden);
    return GROUPS.map((name) => ({
      name,
      items: listed.filter((action) => groupOf(action) === name),
    })).filter((group) => group.items.length > 0);
  }, [actions]);

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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          // Escape goes through the store, so that it closes a form before the bar, as it does
          // everywhere else. Preventing it keeps the dialog from closing itself on top of that.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            uiStore.getState().cancel();
          }}
          className="glass fixed top-[14vh] left-1/2 z-50 flex max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden text-ink"
        >
          <Dialog.Title className="sr-only">Command bar</Dialog.Title>
          {formAction !== null && ctx !== null ? (
            <div className="flex min-h-0 flex-col">
              <h2 className="border-b border-white/10 px-3 py-2 text-sm font-semibold">
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
            <Command
              label="Command bar"
              filter={matchWords}
              loop
              vimBindings={false}
              className="flex min-h-0 flex-col"
            >
              <Command.Input
                placeholder="Type a command…"
                className="min-h-10 border-b border-white/10 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-muted"
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
                        onSelect={() => choose(action)}
                        className="flex min-h-8 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-white/10"
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
              <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1.5 text-xs text-muted">
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
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
