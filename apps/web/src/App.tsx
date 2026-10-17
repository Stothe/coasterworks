import type { SimClient, Speed } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiActionDeps } from "./actions/registry";
import type { Action, ActionContext } from "./actions/types";
import { useActions } from "./actions/useActions";
import { bindingFor, stepSpeed } from "./state/keys";
import { uiStore, useUiStore } from "./state/uiStore";
import { useHost } from "./state/useHost";
import { useToasts } from "./state/useToasts";
import { Banner } from "./ui/Banner";
import { CommandBar } from "./ui/CommandBar";
import { Dock } from "./ui/Dock";
import { IconButton, Panel } from "./ui/kit";
import { StatusPills } from "./ui/StatusPills";
import { Toast } from "./ui/Toast";
import { Tray } from "./ui/Tray";
import { requestClassicView } from "./viewport/classicView";
import { Viewport } from "./viewport/Viewport";
import { BRUSH_SIZES } from "./viewport/terrainTools";

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
        terrain: (verb) => store().startTerrain(verb),
        brush: (direction) => {
          const next = BRUSH_SIZES[BRUSH_SIZES.indexOf(store().brushSize) + direction];
          if (next !== undefined) store().setBrushSize(next);
        },
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
      if (!binding) return;
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
        <div className="pointer-events-auto absolute bottom-4 left-1/2 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
          <Tray
            tool={uiTool}
            actions={actions}
            ctx={ctx}
            lastCharge={lastCharge}
            onError={(message) => push(message, { kind: "error" })}
            disabled={disconnected}
          />
          <Dock
            tool={uiTool}
            onSelect={(next) => uiStore.getState().setTool(next)}
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
        {inspectorOpen && (
          // Stands in until the inspector comes, so that what the Park tray opens can be seen.
          <div className="pointer-events-auto absolute top-24 right-3.5 w-64">
            <Panel
              title="Inspector"
              actions={
                <IconButton
                  label="Close inspector"
                  icon={<CloseIcon />}
                  onClick={() => uiStore.getState().closeInspector()}
                />
              }
            >
              <p className="text-sm text-muted">Inspector coming in the next task</p>
            </Panel>
          </div>
        )}
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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
