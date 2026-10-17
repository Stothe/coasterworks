import { describe, expect, it } from "vitest";
import { createWriteQueue } from "../src/write-queue.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createWriteQueue", () => {
  it("runs tasks one at a time, in the order they were queued, and returns their values", async () => {
    const queue = createWriteQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name} start`);
      await sleep(ms);
      events.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([
      queue.enqueue(task("a", 30)),
      queue.enqueue(task("b", 1)),
      queue.enqueue(task("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("reports a failure to its caller and still runs the tasks after it", async () => {
    const queue = createWriteQueue();
    const failed = queue.enqueue(async () => {
      throw new Error("disk full");
    });
    const after = queue.enqueue(async () => "ok");
    await expect(failed).rejects.toThrow("disk full");
    await expect(after).resolves.toBe("ok");
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("is idle when nothing was queued", async () => {
    await expect(createWriteQueue().idle()).resolves.toBeUndefined();
  });

  it("idle waits for everything queued, including tasks queued while it waits", async () => {
    const queue = createWriteQueue();
    const done: string[] = [];
    void queue.enqueue(async () => {
      await sleep(20);
      done.push("first");
      // Queued by a running task, as an `onMutate` that fires during a write would.
      void queue.enqueue(async () => {
        await sleep(20);
        done.push("second");
      });
    });
    await queue.idle();
    expect(done).toEqual(["first", "second"]);
  });

  it("idle does not reject because a task did", async () => {
    const queue = createWriteQueue();
    queue
      .enqueue(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    await expect(queue.idle()).resolves.toBeUndefined();
  });
});
