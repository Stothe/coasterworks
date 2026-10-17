import type { ParkInfo } from "../../state/useParkInfo";
import { formatCents } from "../format";
import { Row, Rows } from "./Rows";

/** The park at a glance: its name, the date, the money, and the places guests will fill. */
export function ParkOverview({ info }: { info: ParkInfo | null }) {
  if (!info) return <p className="text-sm text-muted">Loading the park</p>;
  return (
    <Rows label="Park">
      <Row label="Park">{info.name ?? "Park"}</Row>
      <Row label="Date">{info.date}</Row>
      <Row label="Cash">{formatCents(info.cash)}</Row>
      <Row label="Loan">{formatCents(info.loan)}</Row>
      <Row label="Guests" tone="muted">
        Coming with guests
      </Row>
      <Row label="Park rating" tone="muted">
        Coming with guests
      </Row>
    </Rows>
  );
}
