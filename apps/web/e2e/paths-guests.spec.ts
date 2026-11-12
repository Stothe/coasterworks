import { expect, test, type Page } from "@playwright/test";

/** What the page's hook for tests offers (see `App.tsx`), as much of it as these tests use. */
interface Hook {
  __coasterworks?: {
    ready?: boolean;
    client?: {
      query(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown }>;
    };
    uiState?(): { tool: string; placement: { command: string; defaults: unknown } | null };
    findGuest?(): { clientX: number; clientY: number; id: number } | null;
  };
}

async function openPark(page: Page) {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );
}

/** The names of the newest `limit` commands in the sim's log, newest first. */
const recentCommands = (page: Page, limit: number) =>
  page.evaluate(async (limit) => {
    const client = (window as unknown as Hook).__coasterworks?.client;
    const answer = await client?.query("log_recent", { limit });
    return ((answer?.result ?? []) as Array<{ name: string }>).map((entry) => entry.name);
  }, limit);

const guestCount = async (page: Page) => Number(await page.getByTestId("guest-count").innerText());

test("2 is Paths: a drag lays footpath, one command per tile", async ({ page }) => {
  await openPark(page);
  await page.keyboard.press("Space");

  await page.keyboard.press("2");
  const tray = page.getByRole("region", { name: "Paths tray" });
  await expect(tray).toBeVisible();
  await expect(tray.getByRole("button", { name: "Footpath" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Across open grass in the lower left of the view, well clear of the pond.
  const box = await page.getByLabel("Park view").boundingBox();
  if (!box) throw new Error("The park view has no size");
  const y = box.y + box.height * 0.62;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(box.x + box.width * (0.3 + 0.015 * k), y);
  }
  await page.mouse.up();

  await expect
    .poll(async () => (await recentCommands(page, 20)).filter((n) => n === "path_build").length)
    .toBeGreaterThanOrEqual(3);
});

test("guests come in through the gate, a click on one shows them, and closing sends them home", async ({
  page,
}) => {
  await openPark(page);

  // The sample park opens with an entrance, paths and the gate open: guests come at 8x.
  await page.getByRole("button", { name: "8x" }).click();
  await expect.poll(() => guestCount(page), { timeout: 45_000 }).toBeGreaterThanOrEqual(3);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "true");

  // Click a guest where the view draws one.
  const found = await page.waitForFunction(() =>
    (window as unknown as Hook).__coasterworks?.findGuest?.(),
  );
  const spot = (await found.jsonValue()) as { clientX: number; clientY: number } | null;
  if (!spot) throw new Error("No guest in view");
  await page.mouse.click(spot.clientX, spot.clientY);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Guest" })).toBeVisible();
  await expect(inspector.getByRole("meter", { name: "Happiness" })).toBeVisible();
  await expect(inspector.getByRole("meter", { name: "Hunger" })).toBeVisible();

  // Close the park from the Park tray: everyone leaves.
  await page.keyboard.press("7");
  const tray = page.getByRole("region", { name: "Park tray" });
  await tray.getByRole("button", { name: "Close park" }).click();
  await expect(tray.getByRole("button", { name: "Open park" })).toBeVisible();
  await page.getByRole("button", { name: "8x" }).click();
  await expect.poll(() => guestCount(page), { timeout: 50_000 }).toBe(0);
});
