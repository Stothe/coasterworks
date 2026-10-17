import type { SimClient, Speed } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiActionDeps } from "./actions/registry";
import type { Action, ActionContext } from "./actions/types";
import { useActions } from "./actions/useActions";
import { bindingFor, stepSpeed } from "./state/keys";
import { uiStore, useUiStore } from "./state/uiStore";
import { useAgentToasts } from "./state/useAgentToasts";
import { useHost, type HostState } from "./state/useHost";
import { useNotifications } from "./state/useNotifications";
import { useSnapshot, type SnapshotSource } from "./state/useSnapshot";
import { useTimeline, type TileRect } from "./state/useTimeline";
import { useToasts } from "./state/useToasts";
import { Banner } from "./ui/Banner";
import { CommandBar } from "./ui/CommandBar";
import { Dock } from "./ui/Dock";
import { HelpOverlay } from "./ui/HelpOverlay";
import { Inspector } from "./ui/Inspector";
import { CLEAR_OF_INSPECTOR_REM } from "./ui/layout";
import { StatusPills, type StatusPillsProps } from "./ui/StatusPills";
import { TileContextMenu, type TileMenuHandle } from "./ui/TileContextMenu";
import { Toast } from "./ui/Toast";
import { TopRight } from "./ui/TopRight";
import { Tray } from "./ui/Tray";
import { requestClassicView } from "./viewport/classicView";
import { Viewport, type ViewportHandle, type ViewportProps } from "./viewport/Viewport";
import { BRUSH_SIZES } from "./viewport/terrainTools";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The latest of what the key handler and the actions' handlers read, which outlive renders. */
interface Live {
  speed: Speed;
  halted: boolean;
  disconnected: boolean;
  client: SimClient | null;
  host: HostState;
  changeSpeed(speed: Speed): void;
  onResult(result: ExecResult): void;
  ctx: ActionContext | null;
  byId: ReadonlyMap<string, Action>;
}

/**
 * The status pills, with the cash, the month's change and the date followed from the snapshots. They
 * are the part of the app that changes with the clock, so they are what a snapshot renders.
 */
function LiveStatusPills({
  source,
  ...rest
}: Omit<StatusPillsProps, "cash" | "monthChange" | "date"> & { source: SnapshotSource }) {
  const cash = useSnapshot(source, (snapshot) => snapshot?.header.cash);
  const monthStartCash = useSnapshot(source, (snapshot) => snapshot?.header.monthStartCash);
  const date = useSnapshot(source, (snapshot) => snapshot?.header.date);
  if (cash === undefined || monthStartCash === undefined || date === undefined) return null;
  return <StatusPills cash={cash} monthChange={cash - monthStartCash} date={date} {...rest} />;
}

/** The view, with the time of day following the sim's tick. */
function LiveViewport({
  source,
  ...rest
}: Omit<ViewportProps, "tick"> & { source: SnapshotSource }) {
  const tick = useSnapshot(source, (snapshot) => snapshot?.header.tick ?? 0);
  return <Viewport {...rest} tick={tick} />;
}

export function App() {
  const host = useHost();
  const { toasts, push, dismiss, update } = useToasts();
  const uiTool = useUiStore((state) => state.tool);
  const selection = useUiStore((state) => state.selection);
  const inspectorOpen = useUiStore((state) => state.inspector.open);
  const [lastCharge, setLastCharge] = useState<number | null>(null);
  const tileMenu = useRef<TileMenuHandle>(null);
  const viewport = useRef<ViewportHandle>(null);

  const { client } = host;
  // The one thing of the snapshot the app itself follows. A snapshot every 50 ms renders the pills
  // and the view; the app renders when the speed changes.
  const speed: Speed = useSnapshot(host, (snapshot) => snapshot?.header.speed ?? 1);
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

  /** The viewport's right click: the tile menu opens at the pointer. */
  const openTileMenu = useCallback<NonNullable<ViewportProps["onSecondaryClick"]>>(
    (tile, point) => tileMenu.current?.openAt(tile, point),
    [],
  );
  /** Looks at an area of the map: a timeline entry's, or a toast's. */
  const focusRect = useCallback(
    ({ x, y, w, h }: TileRect) => viewport.current?.focusTile(x, y, w, h),
    [],
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
    host,
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

  // The context is made again when the connection or what the actions read of the interface
  // changes, and never for a snapshot: `snapshot` is read from the latest when asked.
  const ctx = useMemo<ActionContext | null>(
    () =>
      client
        ? {
            client,
            get snapshot() {
              return live.current.host.snapshot;
            },
            ui: { tool: uiTool, selection, inspectorOpen },
          }
        : null,
    [client, uiTool, selection, inspectorOpen],
  );

  useEffect(() => {
    live.current = {
      speed,
      halted,
      disconnected,
      client,
      host,
      changeSpeed,
      onResult,
      ctx,
      byId,
    };
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
  const reportedError =
    host.error && host.status === "ready" && host.error !== host.haltMessage
      ? host.error
      : undefined;
  useEffect(() => {
    if (reportedError !== undefined) push(reportedError, { kind: "error" });
  }, [reportedError, push]);

  // What the bell counts: an agent's commands since it was last opened. What was in the log when
  // the page joined is history, not news.
  const seenThrough = host.historyThrough ?? 0;
  const notifications = useNotifications(host.events, seenThrough);
  const { clear: clearNotifications } = notifications;
  const openNotifications = useCallback(() => {
    uiStore.getState().openInspector("timeline");
    clearNotifications();
  }, [clearNotifications]);

  // Whatever an agent does shows up as it happens, a burst of commands as one message, and a click
  // on it goes to where it happened or else to the Timeline.
  const timeline = useTimeline(host.events);
  useAgentToasts({
    events: host.events,
    timeline,
    seenThrough,
    push,
    update,
    focusRect,
    openTimeline: openNotifications,
  });

  // Tells the smoke test, and anyone with a console, that the page has a sim to talk to.
  useEffect(() => {
    if (host.status !== "ready" || !client) return;
    window.__coasterworks = {
      ready: true,
      client,
      uiState: () => {
        const { tool, placement } = uiStore.getState();
        return { tool, placement };
      },
    };
    return () => {
      delete window.__coasterworks;
    };
  }, [host.status, client]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-canvas font-sans text-ink select-none">
      <TileContextMenu
        ref={tileMenu}
        terrain={host.terrain}
        execute={execute}
        notify={push}
        disabled={disconnected}
      >
        <LiveViewport
          ref={viewport}
          source={host}
          terrain={host.terrain}
          client={client}
          onResult={onResult}
          onSecondaryClick={openTileMenu}
        />
      </TileContextMenu>
      <div className="pointer-events-none absolute inset-0" onClick={releaseFocus}>
        <div className="pointer-events-auto absolute top-3.5 left-3.5">
          <LiveStatusPills
            source={host}
            speed={speed}
            onSpeedChange={changeSpeed}
            speedDisabled={host.halted || disconnected}
            onOpenFinances={() => uiStore.getState().openInspector("finances")}
            onOpenOverview={() => uiStore.getState().openInspector("overview")}
          />
        </div>
        {/*
          The tray and the dock sit in the middle of the space the inspector leaves, and move left
          to keep out of its way while it is open. Only they take the pointer; the space beside the
          narrower is the map's.
        */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4 transition-[right]"
          style={{ right: inspectorOpen ? `${CLEAR_OF_INSPECTOR_REM}rem` : 0 }}
        >
          <div className="pointer-events-none flex w-max max-w-full flex-col items-center gap-2">
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
        <div className="pointer-events-auto absolute top-3.5 right-3.5">
          <TopRight
            unread={notifications.count}
            onOpenNotifications={openNotifications}
            onOpenSearch={() => uiStore.getState().openCommandBar()}
            disabled={disconnected}
          />
        </div>
        <Inspector
          terrain={host.terrain}
          source={host}
          parkName={host.name}
          actions={actions}
          ctx={ctx}
          execute={execute}
          notify={push}
          timeline={timeline}
          focusTile={focusRect}
        />
        <Toast toasts={toasts} onDismiss={dismiss} besideInspector={inspectorOpen} />
        <HelpOverlay byId={byId} />
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
