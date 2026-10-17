import { createDefaultRegistry, type CatalogEntry } from "@coasterworks/sim";
import { vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { Action } from "../src/actions/types";

/** The deps of actions that nothing in the test will run. */
export function inertDeps(): UiActionDeps {
  const noop = vi.fn();
  return {
    startPlacement: noop,
    openForm: noop,
    execute: noop,
    ui: {
      pause: noop,
      setSpeed: noop,
      stepSpeed: noop,
      undo: noop,
      redo: noop,
      classicView: noop,
      setTool: noop,
      openInspector: noop,
      help: noop,
      commandBar: noop,
      cancel: noop,
      terrain: noop,
      brush: noop,
    },
  };
}

/** A command the sim does not have, that takes an area of tiles as the terrain commands do. */
export const FAKE_RECT: CatalogEntry = {
  name: "terrain_flatten_fake",
  description: "Does a made-up thing to an area.",
  category: "terrain",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "integer", minimum: 0 },
      y: { type: "integer", minimum: 0 },
      w: { type: "integer", minimum: 1 },
      h: { type: "integer", minimum: 1 },
    },
    required: ["x", "y", "w", "h"],
  },
  undoable: true,
  kind: "command",
};

/** The actions the app builds from the sim's own catalog, and from `extra` besides. */
export function registryActions(extra: CatalogEntry[] = []): Action[] {
  return buildActions([...createDefaultRegistry().catalog(), ...extra], inertDeps());
}
