import { describe, it, expect } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import { Spinner } from "@/components/common/Spinner";

describe("Spinner", () => {
  it("renders with default size 'md'", () => {
    render(<Spinner />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("renders size 'sm'", () => {
    render(<Spinner size="sm" />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("renders size 'lg'", () => {
    render(<Spinner size="lg" />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("has aria-label 'Loading'", () => {
    render(<Spinner />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("applies animate-spin class", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass("animate-spin");
  });

  it("applies additional className", () => {
    const { container } = render(<Spinner className="text-blue-500" />);
    expect(container.querySelector("svg")).toHaveClass("text-blue-500");
  });
});
