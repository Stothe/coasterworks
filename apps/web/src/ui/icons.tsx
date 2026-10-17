/*
 * The dock's icons. Original line drawings, 24 px with a 1.75 px stroke, in the text colour
 * (`currentColor`) so a button's colour and its pressed state colour them. Licensed under CC BY 4.0
 * with the repository's other assets: see LICENSE-ASSETS.
 */
import type { ReactNode } from "react";

export interface IconProps {
  className?: string;
}

/** The frame every icon shares: a 24 px square, outlined and not filled. */
function Icon({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(className !== undefined && { className })}
    >
      {children}
    </svg>
  );
}

/** A mountain with a snow line: Terrain. */
export function TerrainIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 19.5 9.5 6l4.5 8.5 2.5-4 5 9z" />
      <path d="m7.2 10.8 2.3 1.7 2-1.7" />
    </Icon>
  );
}

/** A path winding up the page between its two edges: Paths. */
export function PathIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 21C4.5 16 16.5 17 16.5 12.5S4.5 9 4.5 3.5" />
      <path d="M9 21c0-5 12-4 12-8.5S9 9 9 3.5" />
    </Icon>
  );
}

/** A ferris wheel on its legs: Rides. */
export function RideIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="10" r="7" />
      <circle cx="12" cy="10" r="1.25" />
      <path d="M12 3v14M5 10h14M7.05 5.05l9.9 9.9M16.95 5.05l-9.9 9.9" />
      <path d="m8.5 20.5 3.5-10.5 3.5 10.5M6 20.5h12" />
    </Icon>
  );
}

/** A pine tree: Scenery. */
export function SceneryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5 7 9.5h3l-4 6h12l-4-6h3z" />
      <path d="M12 15.5v6" />
    </Icon>
  );
}

/** A shop front under its scalloped awning: Shops. */
export function ShopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9 5.5 4h13L20 9" />
      <path d="M4 9a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0A2.67 2.67 0 0 0 20 9" />
      <path d="M5.5 12.5V20h13v-7.5" />
      <path d="M10 20v-4.5h4V20" />
    </Icon>
  );
}

/** A broom: Staff. */
export function StaffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 3.5 12 11" />
      <path d="m10.9 9.9 2.2 2.2-4 8-6.2-6.2z" />
      <path d="m5 16 2.8-2.8M7 18l2.9-2.8" />
    </Icon>
  );
}

/** A flag on a pole: Park. */
export function ParkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 21.5v-19" />
      <path d="M5.5 4h13l-3.25 4.5 3.25 4.5h-13" />
    </Icon>
  );
}

/** The pointer: Select. */
export function SelectIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 3.5v15.5l4.2-4 2.9 6.2 2.5-1.2-2.8-6H18.5z" />
    </Icon>
  );
}
