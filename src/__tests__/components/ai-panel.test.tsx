import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Diagram } from "db-schema-toolkit";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/storage/ai-settings", () => ({
  loadAISettings: vi.fn(async () => ({ provider: "openai", apiKey: "test-key", model: "test" })),
}));
vi.mock("db-schema-toolkit/ai", () => ({
  querySchema: vi.fn(async () => {}),
  challengeSchema: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { loadAISettings } from "@/lib/storage/ai-settings";
import { challengeSchema, querySchema } from "db-schema-toolkit/ai";
import { AIPanel } from "@/app/_components/ai/AIPanel";

const diagram = (id: string): Diagram => ({
  id, name: `Schema ${id}`, databaseType: "postgresql", tables: [], relationships: [], createdAt: "2026-01-01",
});

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

function renderPanel(id = "a", visible = true) {
  return render(<I18nProvider><AIPanel diagram={diagram(id)} onClose={() => {}} visible={visible} /></I18nProvider>);
}

async function runChallenge(score: number) {
  vi.mocked(challengeSchema).mockResolvedValueOnce({ overallScore: score, summary: "Reviewed", issues: [] });
  fireEvent.click(screen.getByRole("button", { name: "Challenge" }));
  fireEvent.click(screen.getByRole("button", { name: "Challenge My Schema" }));
  await screen.findByText(`${score}/100`);
}

it("does not send while an IME composition is active", async () => {
  renderPanel();
  const input = screen.getByPlaceholderText("Ask about your schema...");
  fireEvent.change(input, { target: { value: "テーブル" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  await act(async () => {});
  expect(loadAISettings).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(querySchema).toHaveBeenCalledTimes(1));
});

it("revokes the report URL only after the download has started", async () => {
  URL.createObjectURL = vi.fn(() => "blob:report");
  const revoke = vi.fn();
  URL.revokeObjectURL = revoke;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderPanel();
  await runChallenge(80);
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: ".json" }));
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith("blob:report");
});

it("keeps the score history of each diagram separate", async () => {
  renderPanel("a");
  await runChallenge(41);
  cleanup();
  renderPanel("b");
  await runChallenge(93);
  fireEvent.click(screen.getByRole("button", { name: "View score history" }));
  expect(screen.getByText("Score History")).toBeInTheDocument();
  expect(screen.getByText("93")).toBeInTheDocument();
  expect(screen.queryByText("41")).not.toBeInTheDocument();
});

it("is a modal dialog that returns focus to its trigger when hidden", () => {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  trigger.focus();
  const view = renderPanel("a", true);
  const dialog = screen.getByRole("dialog", { name: "AI Assistant" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog.contains(document.activeElement)).toBe(true);
  view.rerender(<I18nProvider><AIPanel diagram={diagram("a")} onClose={() => {}} visible={false} /></I18nProvider>);
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});
