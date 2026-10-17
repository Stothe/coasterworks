import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  hint: string;
  /** Decoration only: it is hidden from assistive technology. */
  icon?: ReactNode;
}

/** What a panel shows when it has nothing yet: what is missing and what to do about it. */
export function EmptyState({ title, hint, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
      {icon !== undefined && (
        <div aria-hidden="true" className="text-2xl text-muted">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs text-muted">{hint}</p>
    </div>
  );
}
