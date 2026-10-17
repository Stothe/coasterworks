import { EDGE_GAP_REM, TOAST_RIGHT_BESIDE_INSPECTOR_REM } from "./layout";

export interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error";
  /**
   * Makes the message a button. `label` says what pressing it does (`Open the Timeline`); the
   * button's name is the message and then that, so the name has the words the eye reads in it.
   */
  action?: { label: string; run(): void };
}

export interface ToastProps {
  toasts: readonly ToastItem[];
  onDismiss(id: number): void;
  /** Moves the stack left of the inspector, which would otherwise be covered by it. */
  besideInspector?: boolean;
}

/** The stack of messages at the top right, under the buttons. One with an action jumps on a click. */
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
          className="glass pointer-events-auto flex animate-enter items-start gap-2 py-1.5 pr-1.5 pl-3 text-sm"
        >
          {toast.action ? (
            <JumpButton action={toast.action} onDone={() => onDismiss(toast.id)}>
              {toast.text}
            </JumpButton>
          ) : (
            <span className={`flex-1 py-1 ${toast.kind === "error" ? "text-danger" : ""}`}>
              {toast.text}
            </span>
          )}
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

/** The text of a message that does something when pressed, and is gone once it has. */
function JumpButton({
  action,
  onDone,
  children,
}: {
  action: NonNullable<ToastItem["action"]>;
  onDone(): void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={`${children}. ${action.label}`}
      onClick={() => {
        action.run();
        onDone();
      }}
      className="hud-button flex-1 justify-start rounded-lg py-1 text-left"
    >
      {children}
    </button>
  );
}
