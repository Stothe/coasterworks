import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useSnapshot } from "../src/state/useSnapshot";
import { makeSource } from "./snapshotSource";

afterEach(cleanup);

describe("useSnapshot", () => {
  it("is what select makes of the latest snapshot, and follows it", () => {
    const source = makeSource({ cash: 5 });
    const { result } = renderHook(() => useSnapshot(source, (s) => s?.header.cash));
    expect(result.current).toBe(5);
    act(() => source.push({ cash: 9 }));
    expect(result.current).toBe(9);
  });

  it("gives select null before there is a snapshot", () => {
    const source = makeSource(null);
    const { result } = renderHook(() => useSnapshot(source, (s) => s?.header.cash ?? "none"));
    expect(result.current).toBe("none");
    act(() => source.push({ cash: 3 }));
    expect(result.current).toBe(3);
  });

  it("renders only when what it selected changes", () => {
    const source = makeSource({ cash: 5, tick: 0 });
    let commits = 0;
    function Cash() {
      const cash = useSnapshot(source, (s) => s?.header.cash);
      return <p>{cash}</p>;
    }
    render(
      <Profiler id="cash" onRender={() => commits++}>
        <Cash />
      </Profiler>,
    );
    const first = commits;
    act(() => source.push({ tick: 1 }));
    act(() => source.push({ tick: 2 }));
    expect(commits).toBe(first);
    act(() => source.push({ cash: 6 }));
    expect(commits).toBe(first + 1);
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("stops listening when the component goes", () => {
    const source = makeSource({});
    const view = renderHook(() => useSnapshot(source, (s) => s?.header.tick));
    expect(source.listeners()).toBe(1);
    view.unmount();
    expect(source.listeners()).toBe(0);
  });

  it("reads a source that cannot change, as a fixed state in a test is", () => {
    const { result } = renderHook(() =>
      useSnapshot({ snapshot: makeSource({ cash: 77 }).snapshot }, (s) => s?.header.cash),
    );
    expect(result.current).toBe(77);
  });
});
