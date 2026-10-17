import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: ReadonlyArray<TabItem>;
  value: string;
  onValueChange(value: string): void;
  /** Names the tab list for assistive technology. */
  label?: string;
  className?: string;
}

/** Tabs with one panel shown. The arrow keys move between them. */
export function Tabs({ tabs, value, onValueChange, label, className }: TabsProps) {
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={onValueChange}
      className={`flex min-h-0 flex-col ${className ?? ""}`.trim()}
    >
      <RadixTabs.List aria-label={label} className="flex gap-0.5 rounded-lg bg-fill p-[3px]">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.id}
            value={tab.id}
            className="hud-button flex-1 rounded-md px-3 text-xs font-medium text-muted data-[state=active]:bg-fill-active data-[state=active]:text-ink"
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content
          key={tab.id}
          value={tab.id}
          // The padding, and the margin that takes it back, leave room inside the scrolling box for
          // the focus ring of a control at its edge: a ring is 4px out and would be cut off.
          className="-mx-1 min-h-0 flex-1 overflow-auto px-1 pt-3 pb-1"
        >
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
