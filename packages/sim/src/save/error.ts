/** Thrown when a save cannot be read: damaged, malformed, from a newer build, or not migratable. */
export class SaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SaveError";
  }
}

/** The message for a save that is damaged beyond a more specific explanation. */
export const CORRUPT_MESSAGE = "Save file is corrupt";
