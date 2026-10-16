import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkedTransports, type Frame } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLinkedTransports", () => {
  it("delivers what one side sends to the other, synchronously and in order", () => {
    const [a, b] = createLinkedTransports();
    const atB: Frame[] = [];
    const atA: Frame[] = [];
    b.onMessage((frame) => atB.push(frame));
    a.onMessage((frame) => atA.push(frame));
    const bytes = Uint8Array.from([1, 2, 3]);
    a.send("one");
    a.send(bytes);
    b.send("back");
    expect(atB).toEqual(["one", bytes]);
    expect(atA).toEqual(["back"]);
  });

  it("holds frames until the other side listens, then delivers them in order", () => {
    const [a, b] = createLinkedTransports();
    a.send("first");
    a.send("second");
    const got: Frame[] = [];
    b.onMessage((frame) => got.push(frame));
    expect(got).toEqual(["first", "second"]);
    a.send("third");
    expect(got).toEqual(["first", "second", "third"]);
  });

  it("closing either side runs onClose on both, once", () => {
    const [a, b] = createLinkedTransports();
    const closes = { a: 0, b: 0 };
    a.onClose(() => closes.a++);
    b.onClose(() => closes.b++);
    b.close();
    b.close();
    a.close();
    expect(closes).toEqual({ a: 1, b: 1 });
  });

  it("tells a late onClose handler that the pair is already closed", () => {
    const [a, b] = createLinkedTransports();
    a.close();
    let closed = false;
    b.onClose(() => {
      closed = true;
    });
    expect(closed).toBe(true);
  });

  it("drops frames sent after close", () => {
    const [a, b] = createLinkedTransports();
    const got: Frame[] = [];
    b.onMessage((frame) => got.push(frame));
    a.close();
    a.send("late");
    b.send("late too");
    expect(got).toEqual([]);
  });

  it("keeps a failing receiver from unwinding into the sender", () => {
    const reported: unknown[] = [];
    vi.spyOn(Promise, "reject").mockImplementation((error: unknown) => {
      reported.push(error);
      return Promise.resolve() as Promise<never>;
    });
    const [a, b] = createLinkedTransports();
    const boom = new Error("handler failed");
    b.onMessage(() => {
      throw boom;
    });
    expect(() => a.send("x")).not.toThrow();
    expect(reported).toEqual([boom]);
  });
});
