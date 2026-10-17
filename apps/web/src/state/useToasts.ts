import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastItem } from "../ui/Toast";

/** How long a message stays up unless it is sticky. */
export const TOAST_MS = 3000;

/** The most messages on screen at once. A new one past it takes the oldest's place. */
export const MAX_TOASTS = 4;

export interface PushOptions {
  kind?: ToastItem["kind"];
  /** Stays until dismissed. */
  sticky?: boolean;
  /** Turns the message into a button that does this when pressed, named `label`. */
  action?: ToastItem["action"];
}

/** What `update` can change in a message that is up. */
export interface ToastUpdate {
  text: string;
  /** The message's button after the update. Without one, it has none. */
  action?: ToastItem["action"];
}

/**
 * The messages on screen, each gone after 3 seconds unless it was pushed sticky, and at most four
 * at a time: the oldest is dismissed to make room.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // The same list, for the calls that need to know now what is up.
  const current = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const commit = useCallback((next: ToastItem[]) => {
    current.current = next;
    setToasts(next);
  }, []);

  const forget = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      forget(id);
      commit(current.current.filter((toast) => toast.id !== id));
    },
    [commit, forget],
  );

  /** Puts the message away in `TOAST_MS`, unless it is changed or dismissed first. */
  const expireIn = useCallback(
    (id: number) => {
      forget(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      );
    },
    [dismiss, forget],
  );

  const push = useCallback(
    (text: string, options: PushOptions = {}) => {
      const id = nextId.current++;
      const toast: ToastItem = { id, text, kind: options.kind ?? "info" };
      if (options.action) toast.action = options.action;
      const next = [...current.current, toast];
      for (const old of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) forget(old.id);
      commit(next.slice(-MAX_TOASTS));
      if (!options.sticky) expireIn(id);
      return id;
    },
    [commit, expireIn, forget],
  );

  /** True while the message `id` is up. */
  const has = useCallback((id: number) => current.current.some((toast) => toast.id === id), []);

  /**
   * Changes a message that is up, and gives it its three seconds again unless it is sticky. Nothing
   * happens, and false is returned, if it is gone.
   */
  const update = useCallback(
    (id: number, change: ToastUpdate): boolean => {
      const old = current.current.find((toast) => toast.id === id);
      if (!old) return false;
      const { action: _action, ...rest } = old;
      const next: ToastItem = { ...rest, text: change.text };
      if (change.action) next.action = change.action;
      commit(current.current.map((toast) => (toast.id === id ? next : toast)));
      if (timers.current.has(id)) expireIn(id);
      return true;
    },
    [commit, expireIn],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss, update, has };
}
