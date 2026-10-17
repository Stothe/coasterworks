import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** What a fresh sample park starts with, as the status pills show it. */
const START_CASH = "$10,000.00";
const START_CENTS = 10_000_00;
/**
 * The date it starts on is March 1, but the park runs at 1x until the test pauses it, and a slow
 * runner can be some days in by then. Any day of the first March is the park just opened.
 */
const START_DATE = /March \d+, Year 1/;

/** Terrain has a sky, grass in two shades, sand, water and a hill; a blank canvas has one colour. */
const MIN_COLOURS = 8;

/** The README's picture. `UPDATE_SCREENSHOT=1 pnpm e2e` refreshes it; a normal run leaves it be. */
const README_SCREENSHOT = fileURLToPath(new URL("./__screenshots__/park.png", import.meta.url));

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

/** Integer cents from a pill's text, such as `$9,800.00` or `-$5.00`. */
function cents(text: string): number {
  const match = /(-?)\$([\d,]+)\.(\d{2})/.exec(text);
  if (!match) throw new Error(`Not a money amount: ${JSON.stringify(text)}`);
  const value = Number((match[2] ?? "").replaceAll(",", "")) * 100 + Number(match[3]);
  return match[1] ? -value : value;
}

test("opens a park, shapes terrain, undoes it, pauses, and draws", async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });

  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );

  // The sample park opens running at 1x. Pause before reading the date, so it holds still.
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
  await expect.poll(async () => cents(await cash.innerText())).toBeLessThan(START_CENTS);

  // Undo gives it back.
  await page.keyboard.press("Meta+z");
  await expect(cash).toContainText(START_CASH);

  // Space resumes, and the pause button lets go.
  await page.keyboard.press("Space");
  await expect(pause).toHaveAttribute("aria-pressed", "false");

  // Everything above works with a blank canvas, because picking runs on the CPU. So look at the
  // pixels: copy the WebGL canvas onto a 2D one and count the distinct colours on an 8 by 8 grid.
  // The copy happens in an animation frame requested after the viewport's own loop, so it runs
  // right after that loop's render, while the drawing buffer is still full. The best of 30 frames
  // counts, and a canvas that draws nothing (a shader error, a lost context, black) has one.
  const colours = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        const gl = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Park view"]');
        const copy = document.createElement("canvas");
        const ctx = copy.getContext("2d", { willReadFrequently: true });
        if (!gl || !ctx) return done(0);
        let best = 0;
        let frames = 0;
        const sample = () => {
          copy.width = gl.width;
          copy.height = gl.height;
          ctx.drawImage(gl, 0, 0);
          const seen = new Set<string>();
          for (let row = 0; row < 8; row++) {
            for (let column = 0; column < 8; column++) {
              const x = Math.floor(((column + 0.5) * copy.width) / 8);
              const y = Math.floor(((row + 0.5) * copy.height) / 8);
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
              seen.add(`${r},${g},${b}`);
            }
          }
          best = Math.max(best, seen.size);
          if (++frames < 30) requestAnimationFrame(sample);
          else done(best);
        };
        requestAnimationFrame(sample);
      }),
  );

  // Keep the picture with the test's output, whatever happens next.
  const picture = await page.screenshot({ path: testInfo.outputPath("park.png") });

  // Errors first: a shader that failed to compile also leaves a blank canvas, and the message
  // says why where the colour count only says that.
  expect(problems).toEqual([]);
  expect(colours, "distinct colours on the park view").toBeGreaterThanOrEqual(MIN_COLOURS);

  // The README's picture is replaced only by a run that passed everything above.
  if (process.env.UPDATE_SCREENSHOT === "1") {
    await writeFile(README_SCREENSHOT, picture);
  }
});
