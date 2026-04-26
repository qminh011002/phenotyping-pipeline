import { beforeAll, describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { screen } from "@testing-library/react";
import { render } from "@/test/setup";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

const mockUseTheme = vi.hoisted(() =>
  vi.fn().mockReturnValue({ theme: "light", toggleTheme: vi.fn(), setTheme: vi.fn() })
);
vi.mock("@/hooks/useTheme", () => ({ useTheme: mockUseTheme }));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const renderSidebar = (
  initialEntries: string[] = ["/"],
  providerProps?: ComponentProps<typeof SidebarProvider>,
) => {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SidebarProvider {...providerProps}>
        <Sidebar />
      </SidebarProvider>
    </MemoryRouter>
  );
};

describe("Sidebar", () => {
  it("renders the shell navigation items", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /recorded/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new analysis/i })).not.toBeInTheDocument();
  });

  it("renders the brand link, 3 navigation links, and footer links", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(6);
  });

  it("marks the current route active", () => {
    renderSidebar(["/recorded"]);
    const recordedLink = screen.getByRole("link", { name: /recorded/i });
    expect(recordedLink).toHaveAttribute("data-active", "true");
  });

  it("renders the app title", () => {
    renderSidebar();
    expect(screen.getAllByText("Phenotyping").length).toBeGreaterThan(0);
  });

  it("renders footer secondary links", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /support/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /feedback/i })).toBeInTheDocument();
  });

  it("has a profile menu trigger", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: /profile menu/i })).toBeInTheDocument();
  });

  it("opens the profile menu", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: /profile menu/i }));
    expect(screen.getByRole("menuitem", { name: /account/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /log out/i })).toBeInTheDocument();
  });

  it("uses the collapsed provider state", () => {
    const { container } = renderSidebar(["/"], { defaultOpen: false });
    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed",
    );
  });

  it("has correct href for each nav item", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /recorded/i })).toHaveAttribute("href", "/recorded");
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });
});
