import { expect, test } from "@playwright/test";

/** The page's hook for tests (see `App.tsx`), as much of it as this test uses. */
interface Hook {
  __coasterworks?: {
    ready?: boolean;
    client?: {
      query(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown }>;
    };
  };
}

test("a placement started from the command bar is what a click does, until Escape", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  /** The name of the newest command in the sim's log. */
  const lastCommand = () =>
    page.evaluate(async () => {
      const client = (window as unknown as Hook).__coasterworks?.client;
      const answer = await client?.query("log_recent", { limit: 1 });
      const entries = (answer?.result ?? []) as Array<{ name: string }>;
      return entries[0]?.name ?? null;
    });
  /** How many commands the sim's log holds, up to the 200 a query can return. */
  const logLength = () =>
    page.evaluate(async () => {
      const client = (window as unknown as Hook).__coasterworks?.client;
      const answer = await client?.query("log_recent", { limit: 200 });
      if (!answer?.ok) throw new Error("log_recent failed");
      return (answer.result as unknown[]).length;
    });

  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  const clickMiddle = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Lower is in hand, and then 3 takes up Rides in its place, so the dock is on another tool and
  // nothing is in hand: a click that raises can only be the command bar's doing.
  const dock = page.getByRole("group", { name: "Tools" });
  const tool = (name: string) => dock.getByRole("button", { name });
  await page.keyboard.press("l");
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("3");
  await expect(tool("Rides")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByPlaceholder("Type a command…");
  await expect(search).toBeFocused();
  await search.fill("raise terrain");
  await expect(page.getByRole("option", { name: /Raise terrain/ })).toBeVisible();
  await page.keyboard.press("Enter");

  // The bar is out of the way and says what to do, and the dock has gone from Rides to Terrain,
  // the tool the command belongs to.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Click the map to place · Esc to cancel")).toBeVisible();
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Rides")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Raise", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await clickMiddle();
  await expect.poll(lastCommand).toBe("terrain_raise");

  // Escape puts the placement down: a click does nothing, and the tray is gone. Taking Lower up
  // again is what makes a click do something. Only that second click is in the log.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toHaveCount(0);
  const before = await logLength();
  await clickMiddle();
  await page.keyboard.press("l");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();
  await clickMiddle();
  await expect.poll(lastCommand).toBe("terrain_lower");
  expect(await logLength()).toBe(before + 1);
});

test("the row the arrow keys are on has a 2px accent ring, inside its edge", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Type a command…").fill("loan");
  const active = page.getByRole("option", { selected: true });
  await expect(active).toHaveCount(1);

  const ring = (locator: typeof active) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        color: style.outlineColor,
      };
    });
  // The accent is #3b82f6; a negative offset draws the ring inside the row.
  expect(await ring(active)).toEqual({
    style: "solid",
    width: "2px",
    offset: "-2px",
    color: "rgb(59, 130, 246)",
  });

  // The ring follows the arrow keys, and only the row that is on has it.
  await page.keyboard.press("ArrowDown");
  const next = page.getByRole("option", { selected: true });
  await expect(next).toHaveCount(1);
  expect((await ring(next)).width).toBe("2px");
  const others = page.getByRole("option", { selected: false });
  expect(await others.count()).toBeGreaterThan(0);
  expect((await ring(others.first())).style).toBe("none");
});

test("the search field has the keyboard back after Escape from a form", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByPlaceholder("Type a command…");
  await search.fill("take loan");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Amount")).toBeFocused();

  // Escape goes back to the list, and what is typed next goes to the search field.
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await page.keyboard.type("repay");
  await expect(search).toHaveValue("repay");
  await expect(page.getByRole("option", { name: /Repay loan/ })).toBeVisible();
});
