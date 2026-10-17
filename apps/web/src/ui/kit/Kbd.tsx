import type { ReactNode } from "react";

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** A key cap: how the keyboard does something, such as `⌘K` or `Space`. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={`inline-flex min-w-5 items-center justify-center rounded border border-white/15 bg-white/10 px-1 font-sans text-[11px] leading-5 text-muted ${className ?? ""}`.trim()}
    >
      {children}
    </kbd>
  );
}
