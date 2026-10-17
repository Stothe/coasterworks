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

test("the inspector shows the park and a tile, and a right click on the map offers the tile's actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );
  // Hold the park still, so the cash only moves when a command moves it.
  await page.keyboard.press("Space");

  /** The name of the newest command in the sim's log. */
  const lastCommand = () =>
    page.evaluate(async () => {
      const client = (window as unknown as Hook).__coasterworks?.client;
      const answer = await client?.query("log_recent", { limit: 1 });
      const entries = (answer?.result ?? []) as Array<{ name: string }>;
      return entries[0]?.name ?? null;
    });

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toHaveCount(0);

  // The cash pill opens the park's finances.
  await page.getByRole("button", { name: /^Open finances/ }).click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText("This month")).toBeVisible();
  await expect(inspector.getByRole("tab", { name: "Finances" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The date pill opens the overview in the same panel: there is only ever one.
  await page.getByRole("button", { name: /^Open park overview/ }).click();
  await expect(inspector.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(1);

  // The × closes it.
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toHaveCount(0);

  // Escape puts Terrain down, which leaves Select: a click on the map now looks at a tile.
  const dock = page.getByRole("group", { name: "Tools" });
  await expect(dock.getByRole("button", { name: "Terrain" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dock.getByRole("button", { name: "Terrain" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await page.mouse.click(centerX, centerY);
  await expect(inspector.getByRole("heading", { name: /^Tile \(\d+, \d+\)$/ })).toBeVisible();
  await expect(inspector.getByRole("group", { name: "Corner heights" })).toBeVisible();

  // Escape closes the inspector now that nothing else is up.
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);

  // A right click on the map opens the tile's menu ...
  const menu = page.getByRole("menu");
  await page.mouse.click(centerX, centerY, { button: "right" });
  await expect(menu).toBeVisible();
  for (const name of ["Inspect", "Raise here", "Lower here", "Level here", "Set water", "Drain"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }

  // ... whose action runs on the tile, and says what it did.
  await menu.getByRole("menuitem", { name: "Raise here" }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(lastCommand).toBe("terrain_raise");
  await expect(page.getByText(/^Raised \(\d+, \d+\)/)).toBeVisible();

  // Inspect from the menu puts the tile in the inspector.
  await page.mouse.click(centerX, centerY, { button: "right" });
  await menu.getByRole("menuitem", { name: "Inspect" }).click();
  await expect(inspector.getByRole("heading", { name: /^Tile \(\d+, \d+\)$/ })).toBeVisible();

  // Escape closes the menu and only the menu: the inspector it was opened over stays.
  await page.mouse.click(centerX, centerY, { button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(inspector).toBeVisible();

  // A right drag turns the view. It is not a right click, and opens no menu.
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centerX + 80, centerY + 10, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await expect(menu).toHaveCount(0);
});
