import { expect, test, type Locator, type Page } from "@playwright/test";

/** What the page's hook for tests offers (see `App.tsx`), as much of it as these tests use. */
interface Hook {
  __coasterworks?: {
    ready?: boolean;
    client?: {
      query(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown }>;
    };
    uiState?(): { tool: string; placement: { command: string } | null };
  };
}

/** The accent color, as the browser reports it (`--color-accent`, #3b82f6). */
const ACCENT = "rgb(59, 130, 246)";

/** Integer cents from a pill's text, such as `$9,800.00`. */
function cents(text: string): number {
  const match = /(-?)\$([\d,]+)\.(\d{2})/.exec(text);
  if (!match) throw new Error(`Not a money amount: ${JSON.stringify(text)}`);
  const value = Number((match[2] ?? "").replaceAll(",", "")) * 100 + Number(match[3]);
  return match[1] ? -value : value;
}

/** Opens the park, waits for the sim, and holds it still so cash only moves when a command moves it. */
async function openPark(page: Page) {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as Hook).__coasterworks?.ready === true,
    undefined,
    { timeout: 45_000 },
  );
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "true");
}

/** The name of the newest command in the sim's log. */
const lastCommand = (page: Page) =>
  page.evaluate(async () => {
    const client = (window as unknown as Hook).__coasterworks?.client;
    const answer = await client?.query("log_recent", { limit: 1 });
    const entries = (answer?.result ?? []) as Array<{ name: string }>;
    return entries[0]?.name ?? null;
  });

/** What the player has in hand, as the interface's own store has it. */
const uiState = (page: Page) =>
  page.evaluate(() => (window as unknown as Hook).__coasterworks?.uiState?.());

/** Waits for everything that eases in, or slides, to be where it is going. */
const settled = (page: Page) =>
  page.evaluate(async () => {
    // One that is cancelled because its element went away has nothing left to wait for.
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });

const cashOf = (page: Page) => page.getByRole("group", { name: "Cash" });

/** The middle of the park view, which is the pond's edge in the sample park. */
async function pondEdge(page: Page) {
  const canvas = page.getByLabel("Park view");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The park view has no size");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("Water from the dock, placed at the pond's edge, is paid for", async ({ page }) => {
  await openPark(page);

  // 1 is Terrain, whose tray holds the Water verb.
  await page.keyboard.press("1");
  const tray = page.getByRole("region", { name: "Terrain tray" });
  await expect(tray).toBeVisible();
  const water = tray.getByRole("button", { name: "Water", exact: true });
  await water.click();
  await expect(water).toHaveAttribute("aria-pressed", "true");
  expect((await uiState(page))?.placement?.command).toBe("terrain_set_water");

  const before = cents(await cashOf(page).innerText());
  const at = await pondEdge(page);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => lastCommand(page)).toBe("terrain_set_water");
  await expect.poll(async () => cents(await cashOf(page).innerText())).toBeLessThan(before);
});

test("the command bar takes a loan, and the inspector's Finances shows it", async ({ page }) => {
  await openPark(page);
  const before = cents(await cashOf(page).innerText());

  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByPlaceholder("Type a command…");
  await expect(search).toBeFocused();
  await search.fill("loan");
  // Take loan is the first match, so Enter picks it; its form asks for the amount.
  await expect(page.getByRole("option", { name: /Take loan/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  const amount = page.getByLabel("Amount");
  await expect(amount).toBeFocused();
  await page.keyboard.type("500");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => lastCommand(page)).toBe("finance_take_loan");

  // The cash pill opens Finances, where the loan is a row of its own.
  await expect.poll(async () => cents(await cashOf(page).innerText())).toBe(before + 500_00);
  await page.getByRole("button", { name: /^Open finances/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("tab", { name: "Finances" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const loan = inspector.getByText("Loan", { exact: true }).locator("xpath=..");
  await expect(loan).toContainText("$500.00");
});

test("a right click on a tile offers Raise here, and it is paid for", async ({ page }) => {
  await openPark(page);
  const before = cents(await cashOf(page).innerText());

  const at = await pondEdge(page);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Raise here" }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => lastCommand(page)).toBe("terrain_raise");
  await expect.poll(async () => cents(await cashOf(page).innerText())).toBeLessThan(before);
});

test("3 is Rides, whose tray is empty until the next update", async ({ page }) => {
  await openPark(page);

  await page.keyboard.press("3");
  const rides = page.getByRole("region", { name: "Rides tray" });
  await expect(rides).toBeVisible();
  await expect(rides.getByText("Coming with the next update")).toBeVisible();
  await expect(page.getByRole("region", { name: "Terrain tray" })).toHaveCount(0);
  expect((await uiState(page))?.tool).toBe("ride");
});

test("? shows the keyboard map and Esc puts it away", async ({ page }) => {
  await openPark(page);

  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toHaveCount(0);
  await page.keyboard.press("1");
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help.getByText("Command bar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  // Esc closed the map and only the map: the tool in hand is still Terrain.
  expect((await uiState(page))?.tool).toBe("terrain");
});

test("Esc returns to Select, with nothing in hand", async ({ page }) => {
  await openPark(page);
  // The park opens that way.
  expect(await uiState(page)).toEqual({ tool: "select", placement: null });

  await page.keyboard.press("1");
  await page.getByRole("button", { name: "Water", exact: true }).click();
  expect((await uiState(page))?.placement).not.toBeNull();

  await page.keyboard.press("Escape");
  await expect.poll(() => uiState(page)).toEqual({ tool: "select", placement: null });
  const dock = page.getByRole("group", { name: "Tools" });
  await expect(dock.getByRole("button", { pressed: true })).toHaveCount(1);
  await expect(dock.getByRole("button", { name: "Select" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: /tray$/ })).toHaveCount(0);

  // A click on the map now looks at a tile, and costs nothing.
  const before = cents(await cashOf(page).innerText());
  const at = await pondEdge(page);
  await page.mouse.click(at.x, at.y);
  await expect(
    page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("heading", { name: /^Tile \(\d+, \d+\)$/ }),
  ).toBeVisible();
  expect(cents(await cashOf(page).innerText())).toBe(before);
});

test.describe("at the desktop minimum, 1100 by 700", () => {
  test.use({ viewport: { width: 1100, height: 700 } });

  test("the pills, the cluster, the tray and the dock keep clear of the inspector and of each other", async ({
    page,
  }) => {
    await openPark(page);

    // The tallest case: Water's extra controls in the tray, and the Finances forms in the inspector.
    await page.keyboard.press("1");
    await page.getByRole("button", { name: "Water", exact: true }).click();
    await page.getByRole("button", { name: /^Open finances/ }).click();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await expect(page.getByRole("region", { name: "Terrain tray" })).toBeVisible();
    await settled(page);

    const pieces: Array<[string, Locator]> = [
      ["inspector", inspector],
      ["cash pill", page.getByRole("group", { name: "Cash" })],
      ["date pill", page.getByRole("group", { name: "Date" })],
      ["speed control", page.getByRole("group", { name: "Game speed" })],
      ["top-right cluster", page.getByRole("group", { name: "Quick actions" })],
      ["tray", page.getByRole("region", { name: "Terrain tray" })],
      ["dock", page.getByRole("group", { name: "Tools" })],
    ];
    const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const [name, locator] of pieces) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${name} has no box`);
      boxes.set(name, box);
      // Inside the window, on every side.
      expect(box.x, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(1100);
      expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(700);
    }

    const overlaps = (a: string, b: string) => {
      const p = boxes.get(a);
      const q = boxes.get(b);
      if (!p || !q) throw new Error("no box");
      return (
        p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height
      );
    };
    const names = [...boxes.keys()];
    for (const [index, a] of names.entries()) {
      for (const b of names.slice(index + 1)) {
        expect(overlaps(a, b), `${a} overlaps ${b}`).toBe(false);
      }
    }
  });
});

/**
 * What is wrong with the visible controls on the page: the ones with no accessible name, and the
 * ones smaller than 32 px either way, each by name and size. A check box is as big as the label
 * around it, which takes the click as well.
 */
const controlProblems = (page: Page) =>
  page.evaluate(() => {
    const controls =
      'button, input:not([type="hidden"]), select, textarea, [role="tab"], [role="menuitem"], [role="option"], a[href]';
    const nameOf = (el: HTMLElement) => {
      const labelled = el.getAttribute("aria-labelledby");
      return (
        el.getAttribute("aria-label") ??
        (labelled ? document.getElementById(labelled)?.textContent : null) ??
        (el as HTMLInputElement).labels?.[0]?.textContent ??
        el.textContent ??
        el.getAttribute("title") ??
        ""
      ).trim();
    };
    const unnamed: string[] = [];
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(controls)) {
      const target = el.closest("label") ?? el;
      const { width, height } = target.getBoundingClientRect();
      if (width === 0 || height === 0) continue;
      const name = nameOf(el);
      if (name === "") unnamed.push(el.outerHTML.slice(0, 80));
      if (width < 31.5 || height < 31.5)
        small.push(`${name}: ${width.toFixed(1)} x ${height.toFixed(1)}`);
    }
    return { unnamed, small };
  });

test("every control, in every panel, has a name and is at least 32 px to hit", async ({ page }) => {
  await openPark(page);
  /** Looks at what is on screen once it has finished easing in. */
  const audit = async (what: string) => {
    await settled(page);
    expect(await controlProblems(page), what).toEqual({ unnamed: [], small: [] });
  };

  await audit("the park as it opens: pills, speeds and the dock, with Select in hand");
  await page.keyboard.press("1");
  await audit("the Terrain tray");
  for (const verb of ["Water", "Surface", "Level"]) {
    await page.getByRole("button", { name: verb, exact: true }).click();
    await audit(`the ${verb} tray`);
  }
  await page.keyboard.press("3");
  await audit("the Rides tray");
  await page.keyboard.press("7");
  await audit("the Park tray");

  await page.getByRole("button", { name: /^Open finances/ }).click();
  await audit("the inspector on Finances, with its forms");
  await page.getByRole("tab", { name: "Timeline" }).click();
  await audit("the inspector on the Timeline");
  await page.getByRole("button", { name: "Settings" }).click();
  await audit("the settings panel");
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  await audit("the command bar");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await audit("the keyboard map");
  await page.keyboard.press("Escape");

  // A tile in the inspector, and its menu.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const at = await pondEdge(page);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByRole("group", { name: "Corner heights" })).toBeVisible();
  await audit("the inspector on a tile");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await audit("a tile's menu");
});

test("a key press shows a 2px accent focus ring on whatever takes the focus", async ({ page }) => {
  await openPark(page);

  const seen: string[] = [];
  for (let press = 0; press < 14; press++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName,
        style: style.outlineStyle,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        color: style.outlineColor,
      };
    });
    if (!ring) continue;
    seen.push(ring.name);
    expect(ring, ring.name).toMatchObject({
      style: "solid",
      width: "2px",
      offset: "2px",
      color: ACCENT,
    });
  }
  // It really did walk through the controls: pills, speeds, and on into the dock.
  expect(seen.length).toBeGreaterThan(8);
});

test("a focus ring is not cut off by the panel its control is in", async ({ page }) => {
  await openPark(page);
  await page.getByRole("button", { name: /^Open finances/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("tab", { name: "Finances" }).focus();

  /** The ring is 4px out from the control: 2px of offset and 2px of line. */
  const clippedBy = () =>
    page.evaluate(() => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) return "nothing is focused";
      const ring = focused.getBoundingClientRect();
      for (let el = focused.parentElement; el; el = el.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(el);
        if (overflowX === "visible" && overflowY === "visible") continue;
        const box = el.getBoundingClientRect();
        // A scrolled box shows only its own edges; what is past them is cut off.
        if (
          ring.left - 4 < box.left - 0.5 ||
          ring.right + 4 > box.right + 0.5 ||
          ring.top - 4 < box.top - 0.5 ||
          ring.bottom + 4 > box.bottom + 0.5
        ) {
          const name = focused.getAttribute("aria-label") ?? focused.textContent?.trim();
          return `${name} is cut off by ${el.tagName.toLowerCase()}.${el.className}`;
        }
      }
      return null;
    });

  // Tab along the panel: the tabs, then the two loan forms.
  for (let press = 0; press < 8; press++) {
    await page.keyboard.press("Tab");
    expect(await clippedBy()).toBeNull();
  }
});

test("prefers-reduced-motion turns every transition and animation off", async ({ page }) => {
  await openPark(page);
  /** The longest transition or animation time, in seconds, on the element a locator finds. */
  const longest = (locator: Locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el);
      const seconds = (list: string) =>
        Math.max(...list.split(",").map((value) => Number.parseFloat(value) || 0));
      return {
        transition: seconds(style.transitionDuration),
        animation: seconds(style.animationDuration),
      };
    });

  // With motion allowed, a button eases its hover color and a panel eases in ...
  const pause = page.getByRole("button", { name: "Pause" });
  expect((await longest(pause)).transition).toBeGreaterThan(0.05);
  await page.getByRole("button", { name: /^Open finances/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  expect((await longest(inspector)).animation).toBeGreaterThan(0.05);

  // ... and with it reduced, neither does.
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await longest(pause)).transition).toBeLessThan(0.001);
  expect((await longest(inspector)).animation).toBeLessThan(0.001);
});
