import type { ParkInfo } from "../../state/useParkInfo";
import { ratingWord, type ParkState } from "../../state/useParkState";
import { formatCents } from "../format";
import { Row, Rows } from "./Rows";

/** The park at a glance: its name, the date, the money, the gate and the guests. */
export function ParkOverview({ info, park }: { info: ParkInfo | null; park?: ParkState | null }) {
  if (!info) return <p className="text-sm text-muted">Loading the park</p>;
  return (
    <Rows label="Park">
      <Row label="Park">{info.name ?? "Park"}</Row>
      <Row label="Date">{info.date}</Row>
      <Row label="Cash">{formatCents(info.cash)}</Row>
      <Row label="Loan">{formatCents(info.loan)}</Row>
      {park ? (
        <>
          <Row label="Gate" tone={park.open ? "good" : "muted"}>
            {park.entrance === null ? "No entrance" : park.open ? "Open" : "Closed"}
          </Row>
          <Row label="Entry fee">{formatCents(park.entryFee)}</Row>
          <Row label="Guests">{park.guestsInPark}</Row>
          <Row label="Admissions">{park.totalAdmissions}</Row>
          <Row label="Park rating">{`${park.rating} · ${ratingWord(park.rating)}`}</Row>
        </>
      ) : (
        <Row label="Guests" tone="muted">
          Loading
        </Row>
      )}
    </Rows>
  );
}
