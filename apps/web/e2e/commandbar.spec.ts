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

  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  const clickMiddle = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The terrain bar is on Lower, so a click that raises can only be the command bar's doing.
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

  // Escape puts the placement down, and the terrain bar's Lower is what a click does again.
  await page.keyboard.press("Escape");
  await clickMiddle();
  await expect.poll(lastCommand).toBe("terrain_lower");
});
