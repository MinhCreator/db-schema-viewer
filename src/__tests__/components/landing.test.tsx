import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { I18nProvider } from "@/lib/i18n/context";
import { createProject } from "@/lib/project/project";
import { Landing } from "@/app/_components/landing/Landing";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/parsing/parse-input", () => ({
  parseSchemaInput: vi.fn(async () => createProject({ id: "p", name: "P", databaseType: "postgresql", tables: [], relationships: [], createdAt: "2026-01-01" })),
}));

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderLanding(onProjectOpened: (project: ReturnType<typeof createProject>) => boolean | void) {
  render(
    <I18nProvider>
      <Landing onProjectOpened={onProjectOpened} theme="dark" themeMode="system" onToggleTheme={() => {}} />
    </I18nProvider>,
  );
}

describe("Landing", () => {
  it("closes the import dialog on Escape", () => {
    renderLanding(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Import Schema" }));
    expect(screen.getByRole("dialog", { name: "Import Schema" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not report success when opening the project is refused", async () => {
    const onProjectOpened = vi.fn(() => false);
    renderLanding(onProjectOpened);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: /E-commerce|Blog|SaaS/i })[0]!); });
    await waitFor(() => expect(onProjectOpened).toHaveBeenCalledOnce());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports success when the project opens", async () => {
    const onProjectOpened = vi.fn();
    renderLanding(onProjectOpened);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: /E-commerce|Blog|SaaS/i })[0]!); });
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce());
  });

  it("names the theme mode in the current language", () => {
    renderLanding(vi.fn());
    expect(screen.getByRole("button", { name: "Theme: System (click to cycle)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
  });
});
