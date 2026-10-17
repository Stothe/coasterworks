import type { SimClient } from "@coasterworks/protocol";
import type { CatalogEntry } from "@coasterworks/sim";
import { useEffect, useMemo, useState } from "react";
import { buildActions, type UiActionDeps } from "./registry";
import type { Action } from "./types";

export interface UseActions {
  /** Every action: the interface's own at once, the sim's commands once the catalog has loaded. */
  actions: Action[];
  byId: Map<string, Action>;
  /** True once the catalog has loaded for the current client. */
  ready: boolean;
  /** Why the catalog could not be loaded, while it could not. */
  error?: string;
}

const NO_CATALOG: readonly CatalogEntry[] = [];

/**
 * The catalog each client has asked for. The question is put once per client, so strict mode's
 * second mount, a remount and a second component all share the answer.
 */
const requests = new WeakMap<SimClient, Promise<CatalogEntry[]>>();

function requestCatalog(client: SimClient): Promise<CatalogEntry[]> {
  let request = requests.get(client);
  if (!request) {
    const pending = (async () => {
      const result = await client.query<unknown>("catalog_list", {});
      if (!result.ok) throw new Error(result.error);
      if (!Array.isArray(result.result)) throw new Error("catalog_list did not return a list");
      return result.result as CatalogEntry[];
    })();
    request = pending;
    requests.set(client, pending);
    // A failure is not kept, so the next mount asks again.
    pending.catch(() => {
      if (requests.get(client) === pending) requests.delete(client);
    });
  }
  return request;
}

/** What one client's request came to. */
interface Outcome {
  client: SimClient;
  catalog?: CatalogEntry[];
  error?: string;
}

/**
 * The player's actions, built from the sim's own catalog so a command added to the sim appears
 * with no change here. The catalog is fetched once for each `client`, and again if the client
 * changes. `deps` should be stable between renders (see `UiActionDeps`).
 *
 * `ready` stays false until the catalog arrives, and if it cannot be fetched `error` says why.
 * Meanwhile the interface's own actions (pause, undo, tools) are available.
 */
export function useActions(client: SimClient | null, deps: UiActionDeps): UseActions {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!client) return;
    let current = true;
    requestCatalog(client).then(
      (catalog) => {
        if (current) setOutcome({ client, catalog });
      },
      (error: unknown) => {
        if (current)
          setOutcome({ client, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [client]);

  // An outcome belongs to the client that asked; another client's is as good as none.
  const own = outcome !== null && outcome.client === client ? outcome : null;
  const catalog = own?.catalog;
  const error = own?.error;

  return useMemo(() => {
    const actions = buildActions(catalog ?? NO_CATALOG, deps);
    const result: UseActions = {
      actions,
      byId: new Map(actions.map((action) => [action.id, action])),
      ready: catalog !== undefined,
    };
    if (error !== undefined) result.error = error;
    return result;
  }, [catalog, error, deps]);
}
