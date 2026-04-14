import "@testing-library/jest-dom";
import { cleanup, render, type RenderOptions } from "@testing-library/react";
import { afterEach, beforeAll, afterAll, vi } from "vitest";
import type { ReactElement } from "react";
import React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

// Wrap every render with required context providers
export function AllProviders({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

const customRender = (ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) =>
  render(ui, { wrapper: AllProviders, ...options });

export { customRender as render };

// Clean up after each test to avoid state leakage between tests
afterEach(() => {
  cleanup();
});

// Mock `window.matchMedia` used by `next-themes`
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock framer-motion's `useReducedMotion`
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: vi.fn().mockReturnValue(false),
    motion: {
      div: ({ children, ...props }: React.ComponentProps<"div">) =>
        <div {...props}>{children}</div>,
    },
    MotionConfig: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Suppress console.error noise from framer-motion AnimatePresence in tests
const origError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      (args[0].includes("AnimatePresence") ||
        args[0].includes("Warning:") ||
        args[0].includes("Hydration"))
    ) {
      return;
    }
    origError(...args);
  };
});
afterAll(() => {
  console.error = origError;
});

