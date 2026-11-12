import type { RidePublic } from "@coasterworks/protocol";
import type { ParkInfo } from "../../state/useParkInfo";
import { ratingWord, type ParkState } from "../../state/useParkState";
import { formatCents } from "../format";
import { Row, Rows } from "./Rows";

/** The park at a glance: its name, the date, the money, the gate, the guests, rides and stalls. */
export function ParkOverview({
  info,
  park,
  rides,
}: {
  info: ParkInfo | null;
  park?: ParkState | null;
  /** The rides and stalls built, which it counts; left out without them. */
  rides?: readonly RidePublic[] | null;
}) {
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
          {rides && (
            <>
              <Row label="Rides">{rides.filter((ride) => ride.kind !== "stall").length}</Row>
              <Row label="Shops and stalls">
                {rides.filter((ride) => ride.kind === "stall").length}
              </Row>
            </>
          )}
        </>
      ) : (
        <Row label="Guests" tone="muted">
          Loading
        </Row>
      )}
    </Rows>
  );
}
