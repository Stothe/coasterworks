import type { ParkStatus } from "../../state/useParkStatus";
import { formatCents } from "../format";
import { Row, Rows } from "./Rows";

/** The park at a glance: its name, the date, the money, and the places guests will fill. */
export function ParkOverview({ status }: { status: ParkStatus | null }) {
  if (!status) return <p className="text-sm text-muted">Loading the park</p>;
  return (
    <Rows label="Park">
      <Row label="Park">{status.name}</Row>
      <Row label="Date">{status.date}</Row>
      <Row label="Cash">{formatCents(status.cash)}</Row>
      <Row label="Loan">{formatCents(status.loan)}</Row>
      <Row label="Guests" tone="muted">
        Coming with guests
      </Row>
      <Row label="Park rating" tone="muted">
        Coming with guests
      </Row>
    </Rows>
  );
}
