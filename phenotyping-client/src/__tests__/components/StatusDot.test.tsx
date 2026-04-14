import { describe, it, expect } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import { StatusDot } from "@/components/common/StatusDot";

describe("StatusDot", () => {
  it.each([
    ["success", "bg-green-500"],
    ["warning", "bg-amber-500"],
    ["error", "bg-destructive"],
    ["processing", "bg-primary animate-pulse"],
    ["idle", "bg-muted-foreground"],
  ] as const)("applies correct color for status '%s'", (status, expectedColorClass) => {
    render(<StatusDot status={status} />);
    const dot = screen.getByRole("status");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass(expectedColorClass);
  });

  it("renders with role='status'", () => {
    render(<StatusDot status="success" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("applies aria-label matching the status", () => {
    render(<StatusDot status="warning" />);
    expect(screen.getByRole("status", { name: "warning" })).toBeInTheDocument();
  });

  it("applies additional className", () => {
    render(<StatusDot status="success" className="mt-2" />);
    expect(screen.getByRole("status")).toHaveClass("mt-2");
  });

  it("renders as a span element", () => {
    const { container } = render(<StatusDot status="idle" />);
    expect(container.querySelector("span")).toBeInTheDocument();
  });
});
