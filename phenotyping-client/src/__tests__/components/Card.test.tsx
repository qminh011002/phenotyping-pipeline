import { describe, it, expect } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<Card>Test</Card>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card");
  });

  it("renders with interactive prop", () => {
    const { container } = render(<Card interactive>Interactive</Card>);
    const card = container.querySelector('[data-slot="card"]');
    expect(card).toHaveClass("hover:shadow-md");
    expect(card).toHaveClass("cursor-pointer");
  });

  it("renders without interactive styles when interactive is false", () => {
    const { container } = render(<Card>Not interactive</Card>);
    const card = container.querySelector('[data-slot="card"]');
    expect(card).not.toHaveClass(/hover:shadow-md/);
  });

  it("applies additional className", () => {
    const { container } = render(<Card className="p-0">Custom</Card>);
    expect(container.querySelector('[data-slot="card"]')).toHaveClass("p-0");
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>Header content</CardHeader>);
    expect(screen.getByText("Header content")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<CardHeader>Test</CardHeader>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card-header");
  });
});

describe("CardTitle", () => {
  it("renders children", () => {
    render(<CardTitle>My Title</CardTitle>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<CardTitle>Test</CardTitle>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card-title");
  });
});

describe("CardDescription", () => {
  it("renders children", () => {
    render(<CardDescription>A description</CardDescription>);
    expect(screen.getByText("A description")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<CardDescription>Test</CardDescription>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card-description");
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>Content</CardContent>);
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<CardContent>Test</CardContent>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card-content");
  });
});

describe("CardFooter", () => {
  it("renders children", () => {
    render(<CardFooter>Footer</CardFooter>);
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("has data-slot attribute", () => {
    render(<CardFooter>Test</CardFooter>);
    expect(screen.getByText("Test")).toHaveAttribute("data-slot", "card-footer");
  });
});
