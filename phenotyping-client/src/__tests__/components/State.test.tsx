import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/setup";
import userEvent from "@testing-library/user-event";
import { RefreshCw } from "lucide-react";
import { LoadingState, ErrorState, EmptyState } from "@/components/common/State";

// ── LoadingState ────────────────────────────────────────────────────────────────

describe("LoadingState", () => {
  it("renders with default props", () => {
    render(<LoadingState />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("renders with a custom label", () => {
    render(<LoadingState label="Processing images..." />);
    expect(screen.getByText("Processing images...")).toBeInTheDocument();
  });

  it("renders spinner in three sizes", () => {
    const { rerender } = render(<LoadingState size="sm" />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();

    rerender(<LoadingState size="md" />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();

    rerender(<LoadingState size="lg" />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });
});

// ── ErrorState ─────────────────────────────────────────────────────────────────

describe("ErrorState", () => {
  it("renders default error title", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders custom error message", () => {
    render(<ErrorState message="Network request failed" />);
    expect(screen.getByText("Network request failed")).toBeInTheDocument();
  });

  it("renders custom title", () => {
    render(<ErrorState title="Inference failed" />);
    expect(screen.getByText("Inference failed")).toBeInTheDocument();
  });

  it("shows Retry button when onRetry is provided", () => {
    render(<ErrorState onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows Go Back button when onBack is provided", () => {
    render(<ErrorState onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: /go back/i })).toBeInTheDocument();
  });

  it("calls onRetry when Retry button is clicked", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("calls onBack when Go Back button is clicked", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState onBack={onBack} />);
    await user.click(screen.getByRole("button", { name: /go back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows both buttons when both callbacks are provided", () => {
    render(<ErrorState onRetry={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go back/i })).toBeInTheDocument();
  });

  it("does not show description when message is absent", () => {
    const { container } = render(<ErrorState />);
    expect(container.querySelector('[data-slot="alert-description"]')).not.toBeInTheDocument();
  });
});

// ── EmptyState ─────────────────────────────────────────────────────────────────

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState icon={RefreshCw} title="No analyses yet" />);
    expect(screen.getByText("No analyses yet")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <EmptyState
        icon={RefreshCw}
        title="No analyses yet"
        description="Upload images to get started"
      />
    );
    expect(screen.getByText("Upload images to get started")).toBeInTheDocument();
  });

  it("does not render description when absent", () => {
    const { container } = render(
      <EmptyState icon={RefreshCw} title="No analyses yet" />
    );
    expect(
      container.querySelector(".text-sm.text-muted-foreground")
    ).not.toBeInTheDocument();
  });

  it("renders action button when actionLabel and onAction are provided", () => {
    render(
      <EmptyState
        icon={RefreshCw}
        title="No analyses yet"
        actionLabel="Start Analysis"
        onAction={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Start Analysis" })
    ).toBeInTheDocument();
  });

  it("does not render action button when onAction is missing", () => {
    const { container } = render(
      <EmptyState icon={RefreshCw} title="No analyses yet" actionLabel="Start" />
    );
    expect(container.querySelector("button")).not.toBeInTheDocument();
  });

  it("calls onAction when action button is clicked", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState
        icon={RefreshCw}
        title="No analyses yet"
        actionLabel="Start Analysis"
        onAction={onAction}
      />
    );
    await user.click(screen.getByRole("button", { name: "Start Analysis" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders the Lucide icon element", () => {
    const { container } = render(<EmptyState icon={RefreshCw} title="No data" />);
    // Lucide icons render as SVG elements with lucide class
    const svg = container.querySelector("svg.lucide");
    expect(svg).toBeInTheDocument();
  });
});
