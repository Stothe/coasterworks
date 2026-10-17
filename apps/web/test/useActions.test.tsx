import { SimClient, SimHostServer, createLinkedTransports } from "@coasterworks/protocol";
import { Sim, createDefaultRegistry, createWorld, type ExecResult } from "@coasterworks/sim";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiActionDeps } from "../src/actions/registry";
import { useActions, type UseActions } from "../src/actions/useActions";

afterEach(cleanup);

const catalog = createDefaultRegistry().catalog();

function makeDeps(): UiActionDeps {
  const ok: ExecResult = { ok: true, id: 1, cost: 0 };
  return {
    startPlacement: vi.fn(),
    openForm: vi.fn(),
    execute: vi.fn(async () => ok),
    ui: {
      pause: vi.fn(),
      setSpeed: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      classicView: vi.fn(),
      setTool: vi.fn(),
      openInspector: vi.fn(),
      help: vi.fn(),
    },
  };
}

/** A client that answers `catalog_list` with `answer` and counts how often it is asked. */
function fakeClient(answer: () => Promise<unknown>) {
  const query = vi.fn(async (name: string) => {
    if (name !== "catalog_list") throw new Error(`unexpected query ${name}`);
    return answer();
  });
  return { client: { query } as unknown as SimClient, query };
}

const loaded = () => Promise.resolve({ ok: true, result: catalog });

describe("useActions", () => {
  it("is not ready, and offers only interface actions, until the catalog arrives", async () => {
    let resolve: (value: unknown) => void = () => {};
    const { client } = fakeClient(() => new Promise((r) => (resolve = r)));
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(client, deps));

    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.actions.every((a) => a.kind === "ui")).toBe(true);
    expect(result.current.byId.get("ui.undo")).toBeDefined();
    expect(result.current.byId.get("terrain_raise")).toBeUndefined();

    resolve({ ok: true, result: catalog });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.byId.get("terrain_raise")?.placement).toBe("rect");
    expect(result.current.byId.get("finance_take_loan")).toBeDefined();
    expect(result.current.actions).toContain(result.current.byId.get("terrain_raise"));
    expect(result.current.byId.size).toBe(result.current.actions.length);
  });

  it("has nothing to ask until there is a client", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(null, deps));
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.byId.get("ui.undo")).toBeDefined();
  });

  it("asks once per client when strict mode mounts the component twice", async () => {
    const { client, query } = fakeClient(loaded);
    const deps = makeDeps();
    let latest: UseActions | undefined;
    function Probe() {
      latest = useActions(client, deps);
      return null;
    }
    // Strict mode is the element here, not a `renderHook` wrapper: only this way does React mount,
    // unmount and mount the component again.
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(latest?.ready).toBe(true));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("catalog_list", {});
  });

  it("asks once per client when the component renders again or mounts a second time", async () => {
    const { client, query } = fakeClient(loaded);
    const deps = makeDeps();
    const first = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    first.rerender();
    first.rerender();
    const second = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps the same actions between renders while the catalog and deps are the same", async () => {
    const { client } = fakeClient(loaded);
    const deps = makeDeps();
    const { result, rerender } = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current.actions;
    rerender();
    expect(result.current.actions).toBe(first);
  });

  it("asks again when the client changes", async () => {
    const a = fakeClient(loaded);
    const b = fakeClient(async () => ({
      ok: true,
      result: catalog.filter((e) => e.name === "finance_take_loan"),
    }));
    const deps = makeDeps();
    const { result, rerender } = renderHook(
      ({ client }: { client: SimClient }) => useActions(client, deps),
      { initialProps: { client: a.client } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.byId.get("terrain_raise")).toBeDefined();

    rerender({ client: b.client });
    // Never the old client's catalog under the new client.
    await waitFor(() => expect(b.query).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.byId.get("terrain_raise")).toBeUndefined());
    expect(result.current.ready).toBe(true);
    expect(result.current.byId.get("finance_take_loan")).toBeDefined();
    expect(a.query).toHaveBeenCalledTimes(1);
  });

  it("is not ready again when the client goes away", async () => {
    const { client } = fakeClient(loaded);
    const deps = makeDeps();
    const { result, rerender } = renderHook(
      ({ c }: { c: SimClient | null }) => useActions(c, deps),
      { initialProps: { c: client as SimClient | null } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ c: null });
    expect(result.current.ready).toBe(false);
    expect(result.current.byId.get("terrain_raise")).toBeUndefined();
  });

  it("stays not ready and says why when the query fails", async () => {
    const { client } = fakeClient(async () => ({
      ok: false,
      error: "Unknown query: catalog_list",
    }));
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(result.current.error).toBe("Unknown query: catalog_list"));
    expect(result.current.ready).toBe(false);
    // The interface actions still work without the catalog.
    expect(result.current.byId.get("ui.pause")).toBeDefined();
  });

  it("stays not ready and says why when the request itself fails", async () => {
    const { client } = fakeClient(() => Promise.reject(new Error("Connection closed")));
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(result.current.error).toBe("Connection closed"));
    expect(result.current.ready).toBe(false);
  });

  it("stays not ready when the catalog is not a list", async () => {
    const { client } = fakeClient(async () => ({ ok: true, result: { not: "a list" } }));
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.ready).toBe(false);
  });

  it("asks again on a new mount after a failure", async () => {
    let calls = 0;
    const { client, query } = fakeClient(async () => {
      calls++;
      return calls === 1 ? { ok: false, error: "Busy" } : { ok: true, result: catalog };
    });
    const deps = makeDeps();
    const first = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(first.result.current.error).toBe("Busy"));
    first.unmount();

    const second = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.error).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("runs the actions against the deps it was given", async () => {
    const { client } = fakeClient(loaded);
    const deps = makeDeps();
    const { result } = renderHook(() => useActions(client, deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const ctx = {
      client,
      snapshot: null,
      ui: { tool: "select", selection: null, inspectorOpen: false },
    } as const;
    result.current.byId.get("terrain_raise")?.run(ctx);
    expect(deps.startPlacement).toHaveBeenCalledWith("terrain_raise", { steps: 1 });
  });

  it("gets the real catalog from a real host", async () => {
    const sim = new Sim(createWorld({ width: 8, height: 8, seed: 3, name: "Catalog Test" }));
    const host = new SimHostServer(sim);
    const [clientEnd, hostEnd] = createLinkedTransports();
    host.attach(hostEnd);
    const client = new SimClient(clientEnd);
    await client.connect();
    try {
      const deps = makeDeps();
      const { result } = renderHook(() => useActions(client, deps));
      await waitFor(() => expect(result.current.ready).toBe(true));
      const commands = catalog.filter((e) => e.kind === "command").map((e) => e.name);
      for (const name of commands) expect(result.current.byId.has(name), name).toBe(true);
    } finally {
      client.close();
    }
  });
});
