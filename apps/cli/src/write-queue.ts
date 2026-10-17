export interface WriteQueue {
  /**
   * Runs `task` after every task queued before it has finished, and resolves or rejects as `task`
   * does. A task that fails does not hold up the ones behind it.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves once every task queued so far, and any they queue in turn, has finished. */
  idle(): Promise<void>;
}

/**
 * A queue that runs one write at a time. Parks are saved through a temporary file beside the
 * target, so two writes to one path at once would trample it; and a later write has the newer park
 * anyway. Everything that writes a park for a command, `--out` and the `save_write` tool alike,
 * goes through one queue, so a client that writes to the `--out` path itself cannot race the writes
 * that follow its own commands.
 */
export function createWriteQueue(): WriteQueue {
  // The end of the line. It never rejects: a caller hears of its own task's failure from the
  // promise `enqueue` returned.
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task);
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    async idle(): Promise<void> {
      // A task that was queued while we waited moves the end of the line.
      for (let seen = tail; ; seen = tail) {
        await seen;
        if (seen === tail) return;
      }
    },
  };
}
