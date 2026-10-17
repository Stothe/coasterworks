import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastItem } from "../ui/Toast";

/** How long a message stays up unless it is sticky. */
export const TOAST_MS = 3000;

export interface PushOptions {
  kind?: ToastItem["kind"];
  /** Stays until dismissed. */
  sticky?: boolean;
}

/** The messages on screen, each gone after 3 seconds unless it was pushed sticky. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (text: string, options: PushOptions = {}) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, text, kind: options.kind ?? "info" }]);
      if (!options.sticky)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TOAST_MS),
        );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}
