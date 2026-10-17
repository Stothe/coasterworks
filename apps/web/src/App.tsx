import type { Speed } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { useCallback, useEffect, useRef, useState } from "react";
import { isButton, isTyping, stepSpeed } from "./state/keys";
import { useHost } from "./state/useHost";
import { useToasts } from "./state/useToasts";
import { Banner } from "./ui/Banner";
import { StatusPills } from "./ui/StatusPills";
import { Toast } from "./ui/Toast";
import { BRUSH_SIZES, TERRAIN_TOOLS, TerrainTool } from "./ui/TerrainTool";
import { Viewport } from "./viewport/Viewport";
import type { BrushSize, TerrainToolId } from "./viewport/brush";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function App() {
  const host = useHost();
  const { toasts, push, dismiss } = useToasts();
  const [tool, setTool] = useState<TerrainToolId>("raise");
  const [brush, setBrush] = useState<BrushSize>(1);
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

  // Hotkeys read the latest of everything through one ref, so the listener is added once.
  const { halted } = host;
  const disconnected = host.status === "disconnected";
  const keys = useRef({ speed, changeSpeed, client, onResult, brush, halted, disconnected });
  useEffect(() => {
    keys.current = { speed, changeSpeed, client, onResult, brush, halted, disconnected };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const now = keys.current;
      // Nobody is there to answer: the keys do nothing until the app is restarted.
      if (now.disconnected) return;
      const current = requested.current ?? now.speed;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (e.metaKey || e.ctrlKey) {
        if (e.altKey || !now.client) return;
        if (key === "z" || key === "y") {
          const redo = key === "y" || e.shiftKey;
          const run = redo ? now.client.redo() : now.client.undo();
          run.then(now.onResult, (error: unknown) =>
            now.onResult({ ok: false, error: messageOf(error) }),
          );
          e.preventDefault();
        }
        return;
      }
      if (e.altKey || e.repeat) return;

      switch (key) {
        case " ":
          // On a focused button Space presses the button, which is what a keyboard user wants.
          if (isButton(e.target)) return;
          // A halted sim stays stopped until Resume: the speed buttons are disabled, and so are the keys.
          if (!now.halted) now.changeSpeed(current === 0 ? resumeSpeed.current : 0);
          break;
        case "+":
        case "=":
          if (!now.halted) now.changeSpeed(stepSpeed(current, resumeSpeed.current, 1));
          break;
        case "-":
        case "_":
          if (!now.halted) now.changeSpeed(stepSpeed(current, resumeSpeed.current, -1));
          break;
        case "r":
        case "l":
        case "v":
        case "w": {
          const chosen = TERRAIN_TOOLS.find((option) => option.key.toLowerCase() === key);
          if (chosen) setTool(chosen.id);
          break;
        }
        case "[":
        case "]": {
          const at = BRUSH_SIZES.indexOf(now.brush);
          const next = BRUSH_SIZES[at + (key === "]" ? 1 : -1)];
          if (next) setBrush(next);
          break;
        }
        default:
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
            onToolChange={setTool}
            brush={brush}
            onBrushChange={setBrush}
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
    </div>
  );
}
