import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ParsedDumpTable } from "db-schema-toolkit/data";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/storage/ai-settings", () => ({
  loadAISettings: vi.fn(async () => ({ provider: "openai", apiKey: "test-key", model: "test" })),
}));
vi.mock("db-schema-toolkit/ai", () => ({
  queryData: vi.fn(async () => {}),
  suggestCharts: vi.fn(),
  generateCustomChart: vi.fn(),
}));
vi.mock("@/lib/parsing/parse-data", () => ({ loadData: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { loadAISettings } from "@/lib/storage/ai-settings";
import { queryData, suggestCharts } from "db-schema-toolkit/ai";
import { loadData } from "@/lib/parsing/parse-data";
import { DataChat } from "@/app/_components/data/DataChat";
import { DataCharts } from "@/app/_components/data/DataCharts";
import { DataExplorer } from "@/app/_components/data/DataExplorer";
import { DataExplorerProvider } from "@/app/_components/data/DataExplorerContext";

const table: ParsedDumpTable = {
  name: "users",
  columns: ["id", "name"],
  rows: [{ id: 2, name: "b" }, { id: 1, name: "a" }],
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

it("does not send a data question while an IME composition is active", async () => {
  render(<I18nProvider><DataChat tables={[table]} messages={[]} onMessagesChange={() => {}} chatKey="users" /></I18nProvider>);
  const input = screen.getByPlaceholderText("Ask about users...");
  fireEvent.change(input, { target: { value: "ユーザー" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  await act(async () => {});
  expect(loadAISettings).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(queryData).toHaveBeenCalledTimes(1));
});

it("keeps each chart suggestion card when another one is removed", async () => {
  const suggestion = { type: "bar" as const, description: "", xColumn: "name", yColumn: "id", aggregation: "sum" as const, reasoning: "" };
  vi.mocked(suggestCharts).mockResolvedValueOnce([
    { ...suggestion, title: "Alpha chart" },
    { ...suggestion, title: "Beta chart" },
  ]);
  render(<I18nProvider><DataExplorerProvider><DataCharts table={table} /></DataExplorerProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "AI Charts" }));
  fireEvent.click(screen.getByRole("button", { name: "Suggest Charts" }));
  const beta = await screen.findByText("Beta chart");
  fireEvent.click(screen.getAllByRole("button", { name: "Remove chart" })[0]!);
  expect(screen.queryByText("Alpha chart")).not.toBeInTheDocument();
  expect(screen.getByText("Beta chart")).toBe(beta);
});

it("exposes sortable column headers as keyboard buttons with aria-sort", async () => {
  vi.mocked(loadData).mockResolvedValueOnce([table]);
  render(<I18nProvider><DataExplorer onClose={() => {}} /></I18nProvider>);
  const dialog = screen.getByRole("dialog", { name: "Data Explorer" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["INSERT INTO users VALUES (1,'a');"], "dump.sql")] } });
  const header = await screen.findByRole("columnheader", { name: /name/ });
  const sortButton = within(header).getByRole("button");
  expect(header).not.toHaveAttribute("aria-sort");
  fireEvent.click(sortButton);
  expect(screen.getByRole("columnheader", { name: /name/ })).toHaveAttribute("aria-sort", "ascending");
  fireEvent.click(within(screen.getByRole("columnheader", { name: /name/ })).getByRole("button"));
  expect(screen.getByRole("columnheader", { name: /name/ })).toHaveAttribute("aria-sort", "descending");
});
