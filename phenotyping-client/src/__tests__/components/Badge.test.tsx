import { describe, it, expect } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>Completed</Badge>);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("applies all variants", () => {
    const variants = [
      "default",
      "secondary",
      "destructive",
      "outline",
      "ghost",
      "link",
      "success",
      "warning",
    ] as const;
    for (const variant of variants) {
      const { unmount } = render(<Badge variant={variant}>Badge</Badge>);
      expect(screen.getByText("Badge")).toHaveAttribute("data-variant", variant);
      unmount();
    }
  });

  it("applies default variant", () => {
    render(<Badge>Default</Badge>);
    expect(screen.getByText("Default")).toHaveAttribute("data-variant", "default");
  });

  it("renders as a span element", () => {
    const { container } = render(<Badge>Span Badge</Badge>);
    expect(container.querySelector("span")).toBeInTheDocument();
  });

  it("applies additional className", () => {
    render(<Badge className="mt-2">Custom</Badge>);
    expect(screen.getByText("Custom")).toHaveClass("mt-2");
  });

  it("renders success variant with green styles", () => {
    render(<Badge variant="success">Success</Badge>);
    expect(screen.getByText("Success")).toHaveClass(/green-100|dark:bg-green-900/);
  });

  it("renders warning variant with amber styles", () => {
    render(<Badge variant="warning">Warning</Badge>);
    expect(screen.getByText("Warning")).toHaveClass(/amber-100|dark:bg-amber-900/);
  });

  it("renders destructive variant", () => {
    render(<Badge variant="destructive">Failed</Badge>);
    expect(screen.getByText("Failed")).toHaveAttribute("data-variant", "destructive");
  });
});
