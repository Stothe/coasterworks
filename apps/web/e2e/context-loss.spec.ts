import { expect, test } from "@playwright/test";

interface Hook {
  __coasterworks?: { ready?: boolean };
}

/** Distinct colours the park view draws, the best of `frames` frames, on an 8 by 8 grid. */
function colours(frames: number): Promise<number> {
  return new Promise<number>((done) => {
    const gl = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Park view"]');
    const copy = document.createElement("canvas");
    const ctx = copy.getContext("2d", { willReadFrequently: true });
    if (!gl || !ctx) return done(0);
    let best = 0;
    let seenFrames = 0;
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
      if (++seenFrames < frames) requestAnimationFrame(sample);
      else done(best);
    };
    requestAnimationFrame(sample);
  });
}

// A GPU reset, a driver switch or waking from sleep can take the WebGL context away. The view must
// stop drawing while it is gone and draw the park again, lit, once the browser gives it back.
test("draws the park again after the WebGL context is lost and restored", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });

  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    {
      timeout: 45_000,
    },
  );
  expect(await page.evaluate(colours, 20)).toBeGreaterThanOrEqual(8);

  const lost = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Park view"]');
    const gl = canvas?.getContext("webgl2");
    const lose = gl?.getExtension("WEBGL_lose_context");
    if (!canvas || !lose) return false;
    const gone = new Promise((done) =>
      canvas.addEventListener("webglcontextlost", done, { once: true }),
    );
    lose.loseContext();
    await gone;
    await new Promise((done) => setTimeout(done, 300));
    const back = new Promise((done) =>
      canvas.addEventListener("webglcontextrestored", done, { once: true }),
    );
    lose.restoreContext();
    await back;
    return true;
  });
  expect(lost, "the browser offers WEBGL_lose_context").toBe(true);

  await expect
    .poll(() => page.evaluate(colours, 20), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(8);
  // WebGL itself warns about the lost context; anything else is a problem.
  expect(problems.filter((p) => !/CONTEXT_LOST|context lost|lost context/i.test(p))).toEqual([]);
});
