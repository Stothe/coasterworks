import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { MAX_HEIGHT } from "@coasterworks/sim";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TileInspector } from "../src/ui/inspector/TileInspector";
import { tileInfo } from "../src/ui/inspector/tileInfo";

afterEach(cleanup);

const W = 8;
const H = 8;

/**
 * An 8 by 8 map, flat at `base`, with tile (3, 3)'s corners set apart: NW 5, NE 6, SE 7, SW 4,
 * so the lowest is 4 and no two corners read alike.
 */
function terrain(over: { surface?: number; water?: number; corners?: number[] } = {}): TerrainData {
  const corners = new Int16Array((W + 1) * (H + 1)).fill(2);
  const at = (cx: number, cy: number) => cy * (W + 1) + cx;
  const [nw, ne, se, sw] = over.corners ?? [5, 6, 7, 4];
  corners[at(3, 3)] = nw as number;
  corners[at(4, 3)] = ne as number;
  corners[at(4, 4)] = se as number;
  corners[at(3, 4)] = sw as number;
  const surface = new Uint8Array(W * H);
  const water = new Uint8Array(W * H);
  surface[3 * W + 3] = over.surface ?? 2;
  water[3 * W + 3] = over.water ?? 0;
  return { width: W, height: H, corners, surface, water };
}

const OK: ExecResult = { ok: true, id: 1, cost: 1000 };

function setup(map: TerrainData | null = terrain(), result: ExecResult = OK, x = 3, y = 3) {
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(async () => result);
  const notify = vi.fn();
  const view = render(
    <TileInspector terrain={map} x={x} y={y} execute={execute} notify={notify} />,
  );
  const again = (next: TerrainData | null, nx = x, ny = y) =>
    view.rerender(<TileInspector terrain={next} x={nx} y={ny} execute={execute} notify={notify} />);
  return { execute, notify, again };
}

/** The height shown for a corner, from the group of the four. */
function corner(name: "NW" | "NE" | "SE" | "SW"): string {
  const group = screen.getByRole("group", { name: "Corner heights" });
  return within(group).getByText(name).nextElementSibling?.textContent ?? "";
}
/** The value beside a label in the tile's list of facts. */
function fact(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? "";
}

describe("tileInfo", () => {
  it("reads the four corners of a tile from the arrays: NW, NE, SE, SW", () => {
    const info = tileInfo(terrain(), 3, 3);
    expect(info).toEqual({
      corners: { nw: 5, ne: 6, se: 7, sw: 4 },
      lowest: 4,
      surface: "Dirt",
      water: 0,
    });
  });

  it("names every surface, and says nothing of a tile off the map", () => {
    expect([0, 1, 2, 3, 4].map((surface) => tileInfo(terrain({ surface }), 3, 3)?.surface)).toEqual(
      ["Grass", "Sand", "Dirt", "Rock", "Snow"],
    );
    expect(tileInfo(terrain(), W, 0)).toBeNull();
    expect(tileInfo(terrain(), 0, H)).toBeNull();
    expect(tileInfo(terrain(), -1, 0)).toBeNull();
    expect(tileInfo(null, 0, 0)).toBeNull();
  });

  it("reads x across and y down, not the other way: a tile off the diagonal", () => {
    // Tile (5, 2) is not tile (2, 5); on the diagonal the two would read alike.
    const map = terrain();
    const stride = W + 1;
    map.corners[2 * stride + 5] = 11;
    map.corners[2 * stride + 6] = 12;
    map.corners[3 * stride + 6] = 13;
    map.corners[3 * stride + 5] = 14;
    map.surface[2 * W + 5] = 3;
    map.water[2 * W + 5] = 7;
    expect(tileInfo(map, 5, 2)).toEqual({
      corners: { nw: 11, ne: 12, se: 13, sw: 14 },
      lowest: 11,
      surface: "Rock",
      water: 7,
    });
    expect(tileInfo(map, 2, 5)).toEqual({
      corners: { nw: 2, ne: 2, se: 2, sw: 2 },
      lowest: 2,
      surface: "Grass",
      water: 0,
    });
  });

  it("reads the last tile of the map, whose corners are the map's far edge", () => {
    const map = terrain();
    map.corners[H * (W + 1) + W] = 9;
    expect(tileInfo(map, W - 1, H - 1)?.corners.se).toBe(9);
  });
});

describe("TileInspector: what it shows", () => {
  it("shows the four corner heights, the lowest, the surface and the water", () => {
    setup(terrain({ surface: 1, water: 9 }));
    expect([corner("NW"), corner("NE"), corner("SE"), corner("SW")]).toEqual(["5", "6", "7", "4"]);
    expect(fact("Lowest corner")).toBe("4");
    expect(fact("Surface")).toBe("Sand");
    expect(fact("Water level")).toBe("9");
  });

  it('says "none" for a dry tile', () => {
    setup(terrain({ water: 0 }));
    expect(fact("Water level")).toBe("none");
  });

  it("names the surfaces of the sim: grass, sand, dirt, rock and snow", () => {
    const { again } = setup(terrain({ surface: 0 }));
    const seen = [fact("Surface")];
    for (const surface of [1, 2, 3, 4]) {
      again(terrain({ surface }));
      seen.push(fact("Surface"));
    }
    expect(seen).toEqual(["Grass", "Sand", "Dirt", "Rock", "Snow"]);
  });

  it("follows the latest terrain: new heights, surface and water show at once", () => {
    const { again } = setup(terrain());
    expect(corner("NW")).toBe("5");
    again(terrain({ corners: [9, 9, 9, 9], surface: 4, water: 12 }));
    expect([corner("NW"), corner("NE"), corner("SE"), corner("SW")]).toEqual(["9", "9", "9", "9"]);
    expect(fact("Lowest corner")).toBe("9");
    expect(fact("Surface")).toBe("Snow");
    expect(fact("Water level")).toBe("12");
  });

  it("reads the arrays on every render and keeps no copy of them", () => {
    // The same arrays changed in place, as a host that updates terrain in situ would: a copy taken
    // when the tile was first shown would still say 5.
    const map = terrain();
    const { again } = setup(map);
    map.corners[3 * (W + 1) + 3] = 1;
    again(map);
    expect(corner("NW")).toBe("1");
    expect(fact("Lowest corner")).toBe("1");
  });

  it("follows the tile when another is selected", () => {
    const map = terrain();
    map.corners[0] = 11;
    const { again } = setup(map);
    expect(corner("NW")).toBe("5");
    again(map, 0, 0);
    expect(corner("NW")).toBe("11");
  });

  it("says so for a tile that is not on the map, and while there is no map", () => {
    const { again } = setup(terrain(), OK, W, 0);
    expect(screen.getByText("This tile is not on the map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raise here" })).toBeNull();
    again(null, 3, 3);
    expect(screen.getByText("Waiting for the map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raise here" })).toBeNull();
  });
});

describe("TileInspector: the five actions", () => {
  const buttons = () =>
    within(screen.getByRole("group", { name: "Tile actions" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("has Raise here, Lower here, Level here, Set water and Drain, in that order", () => {
    setup();
    expect(buttons()).toEqual(["Raise here", "Lower here", "Level here", "Set water", "Drain"]);
  });

  it("is a row of full-size targets, each a plain button with its own name", () => {
    setup();
    for (const b of within(screen.getByRole("group", { name: "Tile actions" })).getAllByRole(
      "button",
    )) {
      expect(b.className).toContain("hud-button");
      expect((b as HTMLButtonElement).type).toBe("button");
    }
  });

  const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

  it("Raise here sends terrain_raise on this tile alone", async () => {
    const { execute } = setup();
    click("Raise here");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 3, w: 1, h: 1 });
  });

  it("Lower here sends terrain_lower on this tile alone", async () => {
    const { execute } = setup();
    click("Lower here");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_lower", { x: 3, y: 3, w: 1, h: 1 });
  });

  it("Level here levels to the lowest corner", async () => {
    const { execute } = setup();
    click("Level here");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_level", { x: 3, y: 3, w: 1, h: 1, height: 4 });
  });

  it("Set water fills to two steps above the lowest corner", async () => {
    const { execute } = setup();
    click("Set water");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_set_water", { x: 3, y: 3, w: 1, h: 1, level: 6 });
  });

  it("Set water stops at the highest level the sim takes", async () => {
    const { execute } = setup(
      terrain({ corners: [MAX_HEIGHT, MAX_HEIGHT, MAX_HEIGHT, MAX_HEIGHT] }),
    );
    click("Set water");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_set_water", {
      x: 3,
      y: 3,
      w: 1,
      h: 1,
      level: MAX_HEIGHT,
    });
  });

  it("Drain sets the water level to 0", async () => {
    const { execute } = setup(terrain({ water: 9 }));
    click("Drain");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_set_water", { x: 3, y: 3, w: 1, h: 1, level: 0 });
  });

  it("works out the command from the terrain as it is now, not as it was when it appeared", async () => {
    const { execute, again } = setup(terrain());
    again(terrain({ corners: [8, 8, 8, 10] }));
    click("Level here");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_level", { x: 3, y: 3, w: 1, h: 1, height: 8 });
  });

  it("acts on the tile it is showing", async () => {
    const { execute } = setup(terrain(), OK, 6, 1);
    click("Raise here");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 6, y: 1, w: 1, h: 1 });
  });

  it("says what it did and what it cost, as a message", async () => {
    const { notify } = setup(terrain(), { ok: true, id: 2, cost: 2000 });
    click("Raise here");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith("Raised (3, 3): charged $20.00", {});
  });

  it("says when it refunded, and says nothing of money when it cost none", async () => {
    const { notify } = setup(terrain(), { ok: true, id: 2, cost: -500 });
    click("Drain");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenLastCalledWith("Drained (3, 3): refunded $5.00", {});
    cleanup();

    const free = setup(terrain(), { ok: true, id: 3, cost: 0 });
    click("Level here");
    await waitFor(() => expect(free.notify).toHaveBeenCalledTimes(1));
    expect(free.notify).toHaveBeenCalledWith("Leveled (3, 3)", {});
  });

  it("shows the sim's refusal as an error message", async () => {
    const { notify } = setup(terrain(), { ok: false, error: "Not enough cash" });
    click("Set water");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith("Not enough cash", { kind: "error" });
  });

  it("sends nothing for a tile that is not there", () => {
    const { execute } = setup(terrain(), OK, W, 0);
    expect(screen.queryByRole("button", { name: "Raise here" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
