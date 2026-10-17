import type { ReactNode } from "react";

/** A list of facts, each a label and its value. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl aria-label={label} className="m-0 flex flex-col gap-1.5">
      {children}
    </dl>
  );
}

/** One fact. `tone` colors the value: `good` is green and `bad` is red. */
export function Row({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "good" | "bad" | "muted";
}) {
  const color =
    tone === "good"
      ? "text-success"
      : tone === "bad"
        ? "text-danger"
        : tone === "muted"
          ? "text-muted"
          : "";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`m-0 text-right text-sm tabular-nums ${color}`.trim()}>{children}</dd>
    </div>
  );
}
