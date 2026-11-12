import { expect, test, type Page } from "@playwright/test";

/** What the page's hook for tests offers (see `App.tsx`), as much of it as this test uses. */
interface Hook {
  __coasterworks?: {
    ready?: boolean;
    client?: {
      query(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown }>;
    };
    uiState?(): {
      tool: string;
      placement: { command: string; defaults: Record<string, unknown> } | null;
      placementCheck: { ok: boolean; reason: string | null } | null;
    };
    tileToScreen?(x: number, y: number): { clientX: number; clientY: number } | null;
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

/**
 * A spot on the map where the sim would build a carousel, whose middle tile is drawn in the open
 * middle of the view, clear of the tray, the dock, the pills and the inspector: the carousel's
 * top-left tile and the point in the window over its middle tile. The sample park's camera is
 * fixed, but which tiles are free is the sim's to say, so it is asked.
 */
async function freeSpot(page: Page) {
  const spot = await page.evaluate(async () => {
    const hook = (window as unknown as Hook).__coasterworks;
    if (!hook?.client || !hook.tileToScreen) return null;
    const status = await hook.client.query("park_status", {});
    const { width, height } = (status.result ?? {}) as { width?: number; height?: number };
    if (!width || !height) return null;
    // From the middle of the map outward.
    const tiles: Array<{ x: number; y: number }> = [];
    for (let y = 1; y < height - 3; y++) for (let x = 1; x < width - 3; x++) tiles.push({ x, y });
    const cx = width / 2;
    const cy = height / 2;
    tiles.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    const view = { w: window.innerWidth, h: window.innerHeight };
    let looked = 0;
    for (const { x, y } of tiles) {
      const check = await hook.client.query("ride_check", { type: "carousel", x, y, rot: 0 });
      if (!(check.result as { ok?: boolean } | undefined)?.ok) continue;
      if (++looked > 25) break;
      const point = hook.tileToScreen(x + 1, y + 1);
      if (!point) continue;
      const open =
        point.clientX > view.w * 0.25 &&
        point.clientX < view.w * 0.65 &&
        point.clientY > view.h * 0.2 &&
        point.clientY < view.h * 0.6;
      if (open) return { x, y, ...point };
    }
    return null;
  });
  if (!spot) throw new Error("No free flat spot for a carousel in view");
  return spot;
}

const uiState = (page: Page) =>
  page.evaluate(() => (window as unknown as Hook).__coasterworks?.uiState?.() ?? null);

test("3 is Rides: a Carousel placed on free ground, then opened from its inspector", async ({
  page,
}) => {
  await openPark(page);
  // Paused, so guests stand still and nothing else changes the ground.
  await page.keyboard.press("Space");

  await page.keyboard.press("3");
  const tray = page.getByRole("region", { name: "Rides tray" });
  await tray.getByRole("button", { name: /^Carousel/ }).click();
  await expect
    .poll(async () => (await uiState(page))?.placement?.defaults)
    .toEqual({
      type: "carousel",
      rot: 0,
    });

  const spot = await freeSpot(page);
  await page.mouse.move(spot.clientX, spot.clientY);
  // The ghost is green: the sim would build it here.
  await expect.poll(async () => (await uiState(page))?.placementCheck?.ok).toBe(true);
  await page.mouse.click(spot.clientX, spot.clientY);
  await expect(tray.getByText("Charged $1,200.00")).toBeVisible();

  const rides = await page.evaluate(async () => {
    const answer = await (window as unknown as Hook).__coasterworks?.client?.query("ride_list", {});
    return (answer?.result ?? []) as Array<{ type: string; x: number; y: number; name: string }>;
  });
  const built = rides.find((ride) => ride.type === "carousel" && ride.x === spot.x);
  expect(built).toMatchObject({ x: spot.x, y: spot.y });

  // Put it down, then click the ride to look at it.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await uiState(page))?.placement).toBeNull();
  // The view draws the ride from the snapshot after the build, which may be a frame behind the
  // reply: a click before then looks at the tile, so it is clicked until the ride is what it hits.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(async () => {
    await page.mouse.click(spot.clientX, spot.clientY);
    await expect(inspector.getByRole("heading", { name: built?.name ?? "" })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 10_000 });
  await expect(inspector.getByLabel("Status")).toHaveText("Closed");
  await inspector.getByRole("button", { name: "Open ride" }).click();
  await expect(inspector.getByLabel("Status")).toHaveText(/^Open/);
  await expect(inspector.getByRole("button", { name: "Close ride" })).toBeVisible();
});
