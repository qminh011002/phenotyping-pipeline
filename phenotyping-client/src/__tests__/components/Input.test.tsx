import { describe, it, expect } from "vitest";
import { render } from "@/test/setup";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders with default props", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("accepts placeholder text", () => {
    render(<Input placeholder="Search analyses..." />);
    expect(screen.getByPlaceholderText("Search analyses...")).toBeInTheDocument();
  });

  it("accepts and reports value", async () => {
    const user = userEvent.setup();
    render(<Input defaultValue="initial" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("initial");
    await user.clear(input);
    await user.type(input, "new value");
    expect(input.value).toBe("new value");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("is readonly when readOnly prop is set", () => {
    render(<Input readOnly defaultValue="read only value" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });

  it("has data-slot attribute", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toHaveAttribute("data-slot", "input");
  });

  it("accepts type prop", () => {
    const { container } = render(<Input type="email" placeholder="email@example.com" />);
    expect(container.querySelector('input[type="email"]')).toBeInTheDocument();
  });

  it("applies additional className", () => {
    render(<Input className="w-64" />);
    expect(screen.getByRole("textbox")).toHaveClass("w-64");
  });
});
