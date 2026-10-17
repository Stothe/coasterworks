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
      className={`pointer-events-none absolute top-16 flex w-72 flex-col gap-2 ${
        // The inspector is 20rem wide at 0.875rem from the edge, and the stack keeps clear of it.
        besideInspector ? "right-[21.5rem]" : "right-3.5"
      }`}
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
