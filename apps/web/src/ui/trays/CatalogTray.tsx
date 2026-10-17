import type { Action, ActionContext, DockTool } from "../../actions/types";
import { EmptyState } from "../kit";

/** The dock tools whose trays list the sim's commands of the category of the same name. */
export type CatalogTool = Exclude<DockTool, "terrain" | "park">;

export interface CatalogTrayProps {
  tool: CatalogTool;
  actions: readonly Action[];
  /** What an action may use. Null before the connection is made: nothing can run yet. */
  ctx: ActionContext | null;
  /** Called with the message of an action that failed to run. */
  onError(message: string): void;
  disabled?: boolean;
}

/**
 * The part of an action's description that says what it costs: its first sentence that names a
 * price in dollars (`Costs $50 for each tile.`), without the full stop. Null if none does.
 */
export function costHintOf(action: Action): string | null {
  // A sentence ends at a full stop and a space, so the point in `$4,000.50` does not end one.
  for (const sentence of action.description.split(/(?<=[.!?])\s+/)) {
    if (/\b(?:costs?|priced?)\b/i.test(sentence) && /\$\d/.test(sentence)) {
      return sentence.trim().replace(/[.!?]+$/, "");
    }
  }
  return null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A row of cards, one for each of the sim's commands of the tool's category. A card runs its
 * action, which puts a placement in hand or opens a form. Until the sim has commands of the
 * category, it says so.
 */
export function CatalogTray({ tool, actions, ctx, onError, disabled = false }: CatalogTrayProps) {
  const cards = actions.filter((action) => action.category === tool);
  if (cards.length === 0) {
    return (
      <EmptyState
        title="Coming with the next update"
        hint="Paths, rides, scenery, shops and staff are coming soon."
      />
    );
  }

  const run = (action: Action) => {
    if (ctx === null) return;
    try {
      Promise.resolve(action.run(ctx)).catch((error: unknown) => onError(messageOf(error)));
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <ul className="m-0 flex list-none gap-2 overflow-x-auto p-1">
      {cards.map((action) => {
        const cost = costHintOf(action);
        return (
          <li key={action.id} className="flex">
            <button
              type="button"
              disabled={disabled || ctx === null || action.enabled?.(ctx) === false}
              onClick={() => run(action)}
              className="hud-button w-52 flex-col items-start gap-0.5 rounded-lg bg-fill p-2.5 text-left"
            >
              <span className="text-sm font-medium">{action.title}</span>
              <span className="text-xs text-muted">{action.description}</span>
              {cost !== null && <span className="text-xs text-success">{cost}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
