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
      <RadixTabs.List aria-label={label} className="flex gap-0.5 rounded-lg bg-white/5 p-[3px]">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.id}
            value={tab.id}
            className="hud-button flex-1 rounded-md px-3 text-xs font-medium text-muted data-[state=active]:bg-white/15 data-[state=active]:text-ink"
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content
          key={tab.id}
          value={tab.id}
          className="min-h-0 flex-1 overflow-auto pt-3 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
