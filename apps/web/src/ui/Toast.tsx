import { EDGE_GAP_REM, TOAST_RIGHT_BESIDE_INSPECTOR_REM } from "./layout";

export interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface ToastProps {
  toasts: readonly ToastItem[];
  onDismiss(id: number): void;
  /** Moves the stack left of the inspector, which would otherwise be covered by it. */
  besideInspector?: boolean;
}

/** The stack of messages at the top right, under the command bar button. */
export function Toast({ toasts, onDismiss, besideInspector = false }: ToastProps) {
  return (
    <div
      className="pointer-events-none absolute top-16 flex w-72 flex-col gap-2"
      // Clear of the inspector while it is open, and at the window's edge while it is not.
      style={{ right: `${besideInspector ? TOAST_RIGHT_BESIDE_INSPECTOR_REM : EDGE_GAP_REM}rem` }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className="glass pointer-events-auto flex items-start gap-2 py-1.5 pr-1.5 pl-3 text-sm"
        >
          <span className={`flex-1 py-1 ${toast.kind === "error" ? "text-[#ffb4b4]" : ""}`}>
            {toast.text}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
            className="hud-button min-w-8 rounded-lg text-muted"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
