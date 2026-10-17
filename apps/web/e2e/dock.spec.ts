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

/** Integer cents from a pill's text, such as `$9,800.00`. */
function cents(text: string): number {
  const match = /(-?)\$([\d,]+)\.(\d{2})/.exec(text);
  if (!match) throw new Error(`Not a money amount: ${JSON.stringify(text)}`);
  const value = Number((match[2] ?? "").replaceAll(",", "")) * 100 + Number(match[3]);
  return match[1] ? -value : value;
}

test("the dock opens a tray for each tool, Water is paid for, and Escape puts it all down", async ({
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

  const dock = page.getByRole("group", { name: "Tools" });
  const tool = (name: string) => dock.getByRole("button", { name });
  const trays = page.getByRole("region", { name: /tray$/ });

  // The park opens with Select in hand, and no tray.
  await expect(tool("Select")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "false");
  await expect(trays).toHaveCount(0);

  // 1 puts Terrain in hand, with its tray up.
  await page.keyboard.press("1");
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Select")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();

  // 3 is Rides, whose tray is empty until the next update.
  await page.keyboard.press("3");
  await expect(tool("Rides")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Coming with the next update")).toBeVisible();
  await expect(page.getByRole("region", { name: "Terrain tray" })).toHaveCount(0);

  // 1 is Terrain again. Hold the park still, then fill the water in near the pond.
  await page.keyboard.press("1");
  await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();
  await page.keyboard.press("Space");
  const cash = page.getByRole("group", { name: "Cash" });
  const water = page.getByRole("button", { name: "Water", exact: true });
  await water.click();
  await expect(water).toHaveAttribute("aria-pressed", "true");
  const before = cents(await cash.innerText());

  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(lastCommand).toBe("terrain_set_water");
  await expect.poll(async () => cents(await cash.innerText())).toBeLessThan(before);

  // Escape puts the tool down: no tray, and Select is the one pressed.
  await page.keyboard.press("Escape");
  await expect(trays).toHaveCount(0);
  await expect(tool("Terrain")).toHaveAttribute("aria-pressed", "false");
  await expect(tool("Rides")).toHaveAttribute("aria-pressed", "false");
  await expect(tool("Select")).toHaveAttribute("aria-pressed", "true");

  // The Select button does the same from any tool.
  await page.keyboard.press("3");
  await expect(tool("Rides")).toHaveAttribute("aria-pressed", "true");
  await tool("Select").click();
  await expect(tool("Select")).toHaveAttribute("aria-pressed", "true");
  await expect(trays).toHaveCount(0);
});
