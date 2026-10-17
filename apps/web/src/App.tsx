import type { SimClient, Speed } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiActionDeps } from "./actions/registry";
import type { Action, ActionContext } from "./actions/types";
import { useActions } from "./actions/useActions";
import { bindingFor, isTyping, stepSpeed } from "./state/keys";
import { uiStore, useUiStore } from "./state/uiStore";
import { useHost } from "./state/useHost";
import { useToasts } from "./state/useToasts";
import { Banner } from "./ui/Banner";
import { CommandBar } from "./ui/CommandBar";
import { IconButton } from "./ui/kit";
import { StatusPills } from "./ui/StatusPills";
import { Toast } from "./ui/Toast";
import { BRUSH_SIZES, TERRAIN_TOOLS, TerrainTool } from "./ui/TerrainTool";
import { requestClassicView } from "./viewport/classicView";
import { Viewport } from "./viewport/Viewport";
import type { TerrainToolId } from "./viewport/brush";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The latest of what the key handler and the actions' handlers read, which outlive renders. */
interface Live {
  speed: Speed;
  halted: boolean;
  disconnected: boolean;
  client: SimClient | null;
  changeSpeed(speed: Speed): void;
  onResult(result: ExecResult): void;
  ctx: ActionContext | null;
  byId: ReadonlyMap<string, Action>;
}

export function App() {
  const host = useHost();
  const { toasts, push, dismiss } = useToasts();
  // The terrain bar's tool, until the dock replaces it. A placement started elsewhere (the command
  // bar) is in the store and wins in the viewport; the bar's own buttons put it down.
  const [tool, setTool] = useState<TerrainToolId>("raise");
  const brush = useUiStore((state) => state.brushSize);
  const uiTool = useUiStore((state) => state.tool);
  const selection = useUiStore((state) => state.selection);
  const inspectorOpen = useUiStore((state) => state.inspector.open);
  const [lastCharge, setLastCharge] = useState<number | null>(null);

  const { client } = host;
  const speed: Speed = host.snapshot?.header.speed ?? 1;
  // The speed a pause interrupted, which Space brings back.
  const resumeSpeed = useRef<Speed>(1);
  // The speed last asked for, until the host's snapshot confirms it. Keys pressed in quick
  // succession step from it rather than from a speed the host has not yet reported.
  const requested = useRef<Speed | null>(null);
  useEffect(() => {
    requested.current = null;
    if (speed !== 0) resumeSpeed.current = speed;
  }, [speed]);

  /** Shows what a command did: its charge, or why it failed. */
  const onResult = useCallback(
    (result: ExecResult) => {
      if (result.ok) setLastCharge(result.cost);
      else push(result.error, { kind: "error" });
    },
    [push],
  );

  const changeSpeed = useCallback(
    (next: Speed) => {
      requested.current = next;
      if (next !== 0) resumeSpeed.current = next;
      client?.setSpeed(next).catch((error: unknown) => {
        requested.current = null;
        push(messageOf(error), { kind: "error" });
      });
    },
    [client, push],
  );

  /** The banner's button: asks the host to run again. The speed buttons and keys stay off until it does. */
  const resume = useCallback(() => {
    client?.setSpeed(1).catch((error: unknown) => push(messageOf(error), { kind: "error" }));
  }, [client, push]);

  /** Runs a sim command and says how it went; a refusal is a result, not an error. */
  const execute = useCallback(
    async (name: string, input: unknown): Promise<ExecResult> => {
      if (!client) return { ok: false, error: "Not connected to the park" };
      try {
        return await client.command(name, input);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    [client],
  );

  const { halted } = host;
  const disconnected = host.status === "disconnected";
  // The key handler and the actions' handlers read the latest of everything through this, so the
  // listener is added once and the actions are not rebuilt by a render.
  const live = useRef<Live>({
    speed,
    halted,
    disconnected,
    client,
    changeSpeed,
    onResult,
    ctx: null,
    byId: new Map(),
  });

  // What the actions can do. The object is made once per connection: `useActions` rebuilds the
  // actions whenever it changes, so nothing in it may depend on a render.
  const deps = useMemo<UiActionDeps>(() => {
    /** The speed the host will be at once what was asked has happened. */
    const currentSpeed = () => requested.current ?? live.current.speed;
    /** A halted sim stays stopped until Resume: the speed buttons are disabled, and so are these. */
    const changeable = () => !live.current.halted && !live.current.disconnected;
    const send = (run: (client: SimClient) => Promise<ExecResult>) => {
      const now = live.current;
      if (!now.client) return;
      run(now.client).then(now.onResult, (error: unknown) =>
        now.onResult({ ok: false, error: messageOf(error) }),
      );
    };
    const store = () => uiStore.getState();
    return {
      startPlacement: (command, defaults) => store().startPlacement(command, defaults),
      openForm: (action) => store().openForm(action),
      // For a command that runs at once: the result shows as a message or the last charge.
      execute: async (name, input) => {
        const result = await execute(name, input);
        live.current.onResult(result);
        return result;
      },
      ui: {
        pause: () => {
          if (changeable()) {
            const current = currentSpeed();
            live.current.changeSpeed(current === 0 ? resumeSpeed.current : 0);
          }
        },
        setSpeed: (next) => {
          if (changeable()) live.current.changeSpeed(next);
        },
        stepSpeed: (direction) => {
          if (changeable()) {
            live.current.changeSpeed(stepSpeed(currentSpeed(), resumeSpeed.current, direction));
          }
        },
        undo: () => send((c) => c.undo()),
        redo: () => send((c) => c.redo()),
        classicView: requestClassicView,
        setTool: (next) => store().setTool(next),
        openInspector: (tab) => store().openInspector(tab),
        help: () => store().toggleHelp(),
        commandBar: () => store().openCommandBar(),
        cancel: () => store().cancel(),
      },
    };
  }, [execute]);

  const { actions, byId, ready: catalogReady, error: catalogError } = useActions(client, deps);
  const ctx = useMemo<ActionContext | null>(
    () =>
      client
        ? { client, snapshot: host.snapshot, ui: { tool: uiTool, selection, inspectorOpen } }
        : null,
    [client, host.snapshot, uiTool, selection, inspectorOpen],
  );

  useEffect(() => {
    live.current = { speed, halted, disconnected, client, changeSpeed, onResult, ctx, byId };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Something nearer the key, such as the command bar's dialog, has dealt with it already.
      if (e.defaultPrevented) return;
      const now = live.current;
      // Nobody is there to answer: the keys do nothing until the app is restarted.
      if (now.disconnected) return;
      // While the command bar is up it has the keyboard: only Escape gets through to the app.
      const barOpen = uiStore.getState().commandBarOpen;

      const binding = bindingFor(e);
      if (binding) {
        // Holding a key repeats it; only undo and redo mean it.
        if (e.repeat && !binding.combo.startsWith("mod+")) return;
        if (barOpen && binding.actionId !== "ui.cancel") return;
        const action = now.byId.get(binding.actionId);
        if (!action || !now.ctx) return;
        if (action.enabled && !action.enabled(now.ctx)) return;
        e.preventDefault();
        const report = (error: unknown) => now.onResult({ ok: false, error: messageOf(error) });
        try {
          Promise.resolve(action.run(now.ctx)).catch(report);
        } catch (error) {
          report(error);
        }
        return;
      }

      // The terrain bar's own keys, until the dock replaces it.
      if (barOpen || e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "r" || key === "l" || key === "v" || key === "w") {
        const chosen = TERRAIN_TOOLS.find((option) => option.key.toLowerCase() === key);
        if (!chosen) return;
        uiStore.getState().setTool("select");
        setTool(chosen.id);
      } else if (key === "[" || key === "]") {
        const at = BRUSH_SIZES.indexOf(uiStore.getState().brushSize);
        const next = BRUSH_SIZES[at + (key === "]" ? 1 : -1)];
        if (next) uiStore.getState().setBrushSize(next);
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A mouse click leaves a button focused, and Space would then press it instead of pausing.
  const releaseFocus = (e: React.MouseEvent) => {
    if (e.detail > 0) (e.target as Element).closest("button")?.blur();
  };

  // What the host reports shows for a moment. A halt and a lost connection have their banners.
  useEffect(() => {
    if (host.error && host.status === "ready" && host.error !== host.haltMessage) {
      push(host.error, { kind: "error" });
    }
  }, [host.error, host.haltMessage, host.status, push]);

  // Whatever an agent does shows up as it happens.
  const seenEvent = useRef(0);
  useEffect(() => {
    for (const { entry } of host.events) {
      if (entry.id <= seenEvent.current) continue;
      seenEvent.current = entry.id;
      if (entry.client === "agent") push(`Agent: ${entry.name}`);
    }
  }, [host.events, push]);

  // Tells the smoke test, and anyone with a console, that the page has a sim to talk to.
  useEffect(() => {
    if (host.status !== "ready" || !client) return;
    window.__coasterworks = { ready: true, client };
    return () => {
      delete window.__coasterworks;
    };
  }, [host.status, client]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0d1117] font-sans text-ink select-none">
      <Viewport
        terrain={host.terrain}
        tick={host.snapshot?.header.tick ?? 0}
        client={client}
        tool={tool}
        brush={brush}
        onResult={onResult}
      />
      <div className="pointer-events-none absolute inset-0" onClick={releaseFocus}>
        <div className="pointer-events-auto absolute top-3.5 left-3.5">
          {host.snapshot && (
            <StatusPills
              cash={host.snapshot.header.cash}
              date={host.snapshot.header.date}
              speed={speed}
              onSpeedChange={changeSpeed}
              speedDisabled={host.halted || disconnected}
            />
          )}
        </div>
        <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2">
          <TerrainTool
            tool={tool}
            onToolChange={(next) => {
              // Choosing a tool on the bar puts down a placement the command bar started.
              uiStore.getState().setTool("select");
              setTool(next);
            }}
            brush={brush}
            onBrushChange={(size) => uiStore.getState().setBrushSize(size)}
            lastCharge={lastCharge}
            disabled={disconnected}
          />
        </div>
        <div className="pointer-events-none absolute inset-x-4 top-16 flex justify-center">
          {disconnected ? (
            <Banner text="Lost the connection to the park. Restart Coasterworks." />
          ) : (
            host.halted && (
              <Banner
                text={host.haltMessage ?? "Simulation halted"}
                action={{ label: "Resume", onClick: resume, disabled: !client }}
              />
            )
          )}
        </div>
        <div className="glass pointer-events-auto absolute top-3.5 right-3.5 p-[3px]">
          <IconButton
            label="Open command bar"
            icon={<SearchIcon />}
            onClick={() => uiStore.getState().openCommandBar()}
            disabled={disconnected}
          />
        </div>
        <Toast toasts={toasts} onDismiss={dismiss} />
        {(host.status === "connecting" || host.status === "error") && (
          <div className="absolute inset-0 grid place-items-center">
            <p role="status" className="glass px-4 py-2 text-sm">
              {host.status === "error"
                ? `Could not connect: ${host.error ?? "unknown error"}`
                : "Starting the park…"}
            </p>
          </div>
        )}
      </div>
      <CommandBar
        actions={actions}
        ctx={ctx}
        execute={execute}
        notify={push}
        catalogReady={catalogReady}
        {...(catalogError !== undefined && { catalogError })}
      />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
