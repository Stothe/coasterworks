import * as ContextMenu from "@radix-ui/react-context-menu";
import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Action } from "../actions/types";
import { uiStore } from "../state/uiStore";
import { runTileEntry, tileEntries } from "./inspector/tileActions";

/** What the viewport can ask of the menu. */
export interface TileMenuHandle {
  /** Opens the menu for tile (`x`, `y`) at a point of the window. */
  openAt(tile: { x: number; y: number }, point: { clientX: number; clientY: number }): void;
}

export interface TileContextMenuProps {
  /** The latest terrain, which the menu's actions work their commands out from. */
  terrain: TerrainData | null;
  /** Every action: the menu lists the ones that take an area of tiles, and does them to the one tile. */
  actions: readonly Action[];
  execute(name: string, input: unknown): Promise<ExecResult>;
  notify(text: string, options?: { kind?: "info" | "error" }): void;
  /** Keeps the menu shut, for a park that can no longer be edited. */
  disabled?: boolean;
  ref?: Ref<TileMenuHandle>;
  /** The view the menu is for. */
  children: ReactNode;
}

const ITEM =
  "hud-button justify-start rounded-lg px-2.5 text-sm text-ink select-none data-[highlighted]:bg-fill-strong";

/**
 * The menu of a tile: Inspect, and what the inspector does to a tile, which is every action of the
 * registry that takes an area of tiles, done to this one tile. It is Radix's
 * context menu, but the viewport decides when it opens. A right press that turns into a drag is
 * an orbit and must not open it, and the browser's own `contextmenu` event comes before the drag
 * is known, so the viewport asks with `openAt` when a right click is over instead.
 */
export function TileContextMenu({
  terrain,
  actions,
  execute,
  notify,
  disabled = false,
  ref,
  children,
}: TileContextMenuProps) {
  const trigger = useRef<HTMLSpanElement>(null);
  const [tile, setTile] = useState<{ x: number; y: number } | null>(null);
  const entries = useMemo(() => tileEntries(actions), [actions]);

  useImperativeHandle(
    ref,
    () => ({
      openAt(at, { clientX, clientY }) {
        if (disabled) return;
        setTile(at);
        // The trigger opens at the point of the event it hears, so it is told one.
        trigger.current?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }),
        );
      },
    }),
    [disabled],
  );

  return (
    <ContextMenu.Root>
      {children}
      <ContextMenu.Trigger asChild>
        <span ref={trigger} aria-hidden="true" className="pointer-events-none fixed top-0 left-0" />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label={tile ? `Tile (${tile.x}, ${tile.y}) actions` : "Tile actions"}
          className="glass z-50 flex min-w-44 animate-enter flex-col p-1"
        >
          {tile && (
            <>
              <ContextMenu.Label className="px-2.5 py-1 text-xs text-muted">
                {`Tile (${tile.x}, ${tile.y})`}
              </ContextMenu.Label>
              <ContextMenu.Item
                className={ITEM}
                onSelect={() => uiStore.getState().inspectTile(tile.x, tile.y)}
              >
                Inspect
              </ContextMenu.Item>
              {entries.length > 0 && <ContextMenu.Separator className="my-1 h-px bg-line" />}
              {entries.map((entry) => (
                <ContextMenu.Item
                  key={entry.id}
                  className={ITEM}
                  {...(entry.hint !== undefined && { title: entry.hint })}
                  onSelect={() =>
                    void runTileEntry(entry, terrain, tile.x, tile.y, execute, notify)
                  }
                >
                  {entry.label}
                </ContextMenu.Item>
              ))}
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
