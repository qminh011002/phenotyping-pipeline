import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface AnimatedTabsProps {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function AnimatedTabs({ tabs, active, onChange, className }: AnimatedTabsProps) {
  return (
    <div className={cn("flex border-b", className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "relative px-4 py-2 text-sm font-medium transition-colors duration-100",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "hover:text-foreground",
            active === tab.id ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {tab.label}
          {active === tab.id && (
            <motion.div
              layoutId="tabs-underline"
              className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}
