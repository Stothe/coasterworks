import type { ExecResult } from "@coasterworks/sim";
import type { ParkState } from "../../state/useParkState";
import { ParkControls } from "../park/ParkControls";
import { Row, Rows } from "./Rows";

export interface EntranceInspectorProps {
  park: ParkState | null;
  execute(name: string, input: unknown): Promise<ExecResult>;
  notify(text: string, options?: { kind?: "info" | "error" }): void;
  disabled?: boolean;
}

/** The park entrance: where it is, how many have come through, and the gate's controls. */
export function EntranceInspector({ park, execute, notify, disabled }: EntranceInspectorProps) {
  if (!park) return <p className="text-sm text-muted">Loading the park</p>;
  if (!park.entrance) return <p className="text-sm text-muted">The park has no entrance.</p>;
  return (
    <div className="flex flex-col gap-3">
      <Rows label="Entrance">
        <Row label="Tile">{`(${park.entrance.x}, ${park.entrance.y})`}</Row>
        <Row label="Guests in the park">{park.guestsInPark}</Row>
        <Row label="Admissions">{park.totalAdmissions}</Row>
      </Rows>
      <ParkControls
        park={park}
        execute={execute}
        onError={(message) => notify(message, { kind: "error" })}
        {...(disabled !== undefined && { disabled })}
      />
    </div>
  );
}
