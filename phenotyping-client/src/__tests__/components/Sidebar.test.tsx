import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/setup";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";

const mockUseTheme = vi.hoisted(() =>
  vi.fn().mockReturnValue({ theme: "light", toggleTheme: vi.fn(), setTheme: vi.fn() })
);
vi.mock("@/hooks/useTheme", () => ({ useTheme: mockUseTheme }));

const renderSidebar = (initialEntries: string[] = ["/"]) => {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Sidebar />
    </MemoryRouter>
  );
};

describe("Sidebar", () => {
  it("renders the remaining navigation items", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /recorded/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /analyze/i })).not.toBeInTheDocument();
  });

  it("renders exactly 3 nav links", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
  });

  it("applies active class to the current route", () => {
    renderSidebar(["/recorded"]);
    const recordedLink = screen.getByRole("link", { name: /recorded/i });
    expect(recordedLink).toHaveClass(/text-accent-foreground/);
  });

  it("renders the app title", () => {
    renderSidebar();
    expect(screen.getByText("Phenotyping")).toBeInTheDocument();
  });

  it("renders the version label", () => {
    renderSidebar();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("has a theme toggle button", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it("has a collapse button", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: /collapse sidebar/i })).toBeInTheDocument();
  });

  it("calls onCollapsedChange when collapse button is clicked", () => {
    const handleChange = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar onCollapsedChange={handleChange} />
      </MemoryRouter>
    );
    screen.getByRole("button", { name: /collapse sidebar/i }).click();
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("renders collapsed when collapsed prop is true", () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={true} />
      </MemoryRouter>
    );
    // In collapsed mode, only the P logo should be visible (not full "Phenotyping")
    expect(screen.getByText("P")).toBeInTheDocument();
    // The "Phenotyping" label exists in the DOM but is visually hidden (opacity-0)
    const label = screen.queryByText("Phenotyping", { selector: ":not([class*='opacity-0'])" });
    expect(label).not.toBeInTheDocument();
  });

  it("has correct href for each nav item", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /recorded/i })).toHaveAttribute("href", "/recorded");
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });
});
