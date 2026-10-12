import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/storage/ai-settings", () => ({
  loadAISettingsDraft: vi.fn(async () => null),
  saveAISettings: vi.fn(async () => {}),
  clearAISettings: vi.fn(async () => {}),
}));
vi.mock("db-schema-toolkit/ai", () => ({ querySchema: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { saveAISettings } from "@/lib/storage/ai-settings";
import { APIKeySettings } from "@/app/_components/settings/APIKeySettings";

const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    defaultModel: "gpt-b",
    models: { "gpt-a": { id: "gpt-a", name: "GPT A" }, "gpt-b": { id: "gpt-b", name: "GPT B" } },
  },
};

function renderSettings() {
  render(<I18nProvider><APIKeySettings onClose={() => {}} /></I18nProvider>);
  fireEvent.change(screen.getByPlaceholderText(/sk-|key/i), { target: { value: "test-key" } });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("cannot save a provider configuration without a model when the catalog failed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
  renderSettings();
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

it("saves the provider's default model from the catalog", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })));
  renderSettings();
  await screen.findAllByText("GPT B");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saveAISettings).toHaveBeenCalledTimes(1));
  expect(vi.mocked(saveAISettings).mock.calls[0]![0].model).toBe("gpt-b");
});
