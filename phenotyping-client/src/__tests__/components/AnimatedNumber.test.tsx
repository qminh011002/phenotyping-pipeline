import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import { AnimatedNumber } from "@/components/common/AnimatedNumber";

describe("AnimatedNumber", () => {
  // Suppress framer-motion console warnings in tests
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders initial value", () => {
    render(<AnimatedNumber value={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders value with decimals", () => {
    render(<AnimatedNumber value={3.14159} decimals={2} />);
    expect(screen.getByText("3.14")).toBeInTheDocument();
  });

  it("applies tabular-nums class for stable column width", () => {
    render(<AnimatedNumber value={0} />);
    expect(screen.getByText("0")).toHaveClass("tabular-nums");
  });

  it("renders className", () => {
    render(<AnimatedNumber value={0} className="text-3xl font-bold" />);
    expect(screen.getByText("0")).toHaveClass("text-3xl", "font-bold");
  });

  it("has aria-live='polite' for accessibility", () => {
    const { container } = render(<AnimatedNumber value={0} />);
    const el = container.querySelector('[aria-live="polite"]');
    expect(el).toBeInTheDocument();
  });

  it("has aria-atomic='true'", () => {
    const { container } = render(<AnimatedNumber value={0} />);
    const el = container.querySelector('[aria-atomic="true"]');
    expect(el).toBeInTheDocument();
  });
});
