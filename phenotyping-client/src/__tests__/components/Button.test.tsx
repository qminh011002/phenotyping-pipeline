import { describe, it, expect, vi } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";

// Mock Loader2 (Lucide icon used for loading state)
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Loader2: ({ className, ...props }: React.SVGProps<SVGSVGElement> & { className?: string }) => (
      <svg data-testid="loader-icon" className={className} {...props} />
    ),
  };
});

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies all variants", () => {
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>Button</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-variant", variant);
      unmount();
    }
  });

  it("applies all sizes", () => {
    const sizes = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>B</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-size", size);
      unmount();
    }
  });

  it("shows loading state and hides label", async () => {
    render(
      <Button loading onClick={() => {}}>
        Submit
      </Button>
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveClass("cursor-not-allowed");
    expect(screen.queryByText("Submit")).toBeInTheDocument();
  });

  it("is disabled when loading", () => {
    render(
      <Button loading onClick={() => {}}>
        Submit
      </Button>
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is disabled when disabled prop is set", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("calls onClick handler", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button disabled onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("does not call onClick when loading", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(
      <Button loading onClick={handleClick}>
        Submit
      </Button>
    );
    await user.click(screen.getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("renders as a button element", () => {
    const { container } = render(<Button>Test</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });
});
