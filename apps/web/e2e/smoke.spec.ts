import { expect, test } from "@playwright/test";

/** What a fresh sample park starts with, as the status pills show it. */
const START_CASH = "$10,000.00";
const START_DATE = "March 1, Year 1";

/**
 * The page's hook for the smoke test, set once it is connected to a sim (see `App.tsx`). The
 * callbacks below run in the page, so each one reads it for itself.
 */
interface Hook {
  __coasterworks?: {
    ready?: boolean;
    client?: { query(name: string, input: unknown): Promise<{ ok: boolean }> };
  };
}

test("opens a park, shapes terrain, undoes it, and pauses", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  // The sample park opens running at 1x. Pause before reading the date, so it cannot have moved.
  const pause = page.getByRole("button", { name: "Pause" });
  await page.keyboard.press("Space");
  await expect(pause).toHaveAttribute("aria-pressed", "true");

  const cash = page.getByRole("group", { name: "Cash" });
  const date = page.getByRole("group", { name: "Date" });
  await expect(date).toContainText(START_DATE);
  await expect(cash).toContainText(START_CASH);

  // The page really is talking to a sim, whatever the click below lands on.
  const status = await page.evaluate(() =>
    (window as unknown as Hook).__coasterworks?.client?.query("park_status", {}),
  );
  expect(status?.ok).toBe(true);

  // A click on the middle of the park with the default Raise tool is paid for in cash.
  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(cash).not.toContainText(START_CASH);

  // Undo gives it back.
  await page.keyboard.press("Meta+z");
  await expect(cash).toContainText(START_CASH);

  // Space resumes, and the pause button lets go.
  await page.keyboard.press("Space");
  await expect(pause).toHaveAttribute("aria-pressed", "false");

  // Let a few frames draw with the clock running, then keep the picture for the README.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        let frames = 0;
        const tick = () => (++frames < 30 ? requestAnimationFrame(tick) : done());
        requestAnimationFrame(tick);
      }),
  );
  await page.screenshot({ path: "e2e/__screenshots__/park.png" });

  expect(pageErrors).toEqual([]);
});
