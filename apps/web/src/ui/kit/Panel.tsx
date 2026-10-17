import { useId, type ReactNode } from "react";

export interface PanelProps {
  /** Names the panel for assistive technology as well as heading it. */
  title?: string;
  /** Controls at the right of the header, such as a close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const present = (node: ReactNode) => node !== undefined && node !== null && node !== false;

/** A glass container with an optional header (title and actions) and footer. */
export function Panel({ title, actions, footer, children, className }: PanelProps) {
  const titleId = useId();
  const hasTitle = title !== undefined;
  return (
    <section
      aria-labelledby={hasTitle ? titleId : undefined}
      className={`glass flex min-h-0 flex-col ${className ?? ""}`.trim()}
    >
      {(hasTitle || present(actions)) && (
        <header className="flex min-h-10 items-center gap-2 border-b border-line py-1 pr-1.5 pl-3">
          {hasTitle && (
            <h2 id={titleId} className="flex-1 truncate text-sm font-semibold">
              {title}
            </h2>
          )}
          {present(actions) && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      {present(footer) && <footer className="border-t border-line px-3 py-2">{footer}</footer>}
    </section>
  );
}
