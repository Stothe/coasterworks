import { expect, test } from "@playwright/test";

/** The page's hook for tests (see `App.tsx`), as much of it as this test uses. */
interface Hook {
  __coasterworks?: { ready?: boolean };
}

test("the timeline lists what the player did, and ? shows the keyboard map", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");

  // The top-right buttons: the Assistant is not here yet.
  await expect(page.getByRole("button", { name: "Assistant" })).toBeDisabled();

  // 1 takes up Terrain with Raise in hand, so a click on the map raises the tile under it.
  await page.keyboard.press("1");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The bell opens the inspector on the Timeline, which lists the raise as the player's own.
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("tab", { name: "Timeline" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const entry = inspector.getByRole("listitem").first();
  await expect(entry.getByText("Raise terrain")).toBeVisible();
  await expect(entry.getByText("You")).toBeVisible();

  // ? opens the keyboard map, which names the command bar's key; Esc puts it away.
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help.getByText("Command bar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  // Esc closed the map and nothing else: the inspector it was over is still there.
  await expect(inspector).toBeVisible();
});
