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

  // The Lower tool is in hand, so a click that raises can only be the command bar's doing.
  await page.keyboard.press("l");
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByPlaceholder("Type a command…");
  await expect(search).toBeFocused();
  await search.fill("raise terrain");
  await expect(page.getByRole("option", { name: /Raise terrain/ })).toBeVisible();
  await page.keyboard.press("Enter");

  // The bar is out of the way and says what to do.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Click the map to place · Esc to cancel")).toBeVisible();

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
