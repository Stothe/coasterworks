export interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface ToastProps {
  toasts: readonly ToastItem[];
  onDismiss(id: number): void;
}

/** The stack of messages at the top right, under the command bar button. */
export function Toast({ toasts, onDismiss }: ToastProps) {
  return (
    <div className="pointer-events-none absolute top-16 right-3.5 flex w-72 flex-col gap-2">
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
