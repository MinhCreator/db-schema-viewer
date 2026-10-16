import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCatalogCache } from "llm-connect";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/storage/ai-settings", () => ({
  aiSettingsStorage: {
    load: vi.fn(async () => null),
    loadDraft: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { aiSettingsStorage } from "@/lib/storage/ai-settings";
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

beforeEach(() => { vi.clearAllMocks(); clearCatalogCache(); });
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
  // The default model is picked in an effect after the catalog renders.
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(aiSettingsStorage.save).toHaveBeenCalledTimes(1));
  expect(vi.mocked(aiSettingsStorage.save).mock.calls[0]).toEqual([
    {
      apiKey: "test-key",
      model: "gpt-b",
      providerId: "openai",
      providerName: "OpenAI",
      providerNpm: "@ai-sdk/openai",
      providerApi: "",
      language: "English",
    },
    { rememberKey: true },
  ]);
});

it("explains a blocked connection test on a local endpoint", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/models.json")) return new Response(JSON.stringify(catalog), { status: 200 });
    throw new TypeError("Failed to fetch");
  }));
  render(<I18nProvider><APIKeySettings onClose={() => {}} /></I18nProvider>);
  fireEvent.click(screen.getByRole("checkbox", { name: /custom/i }));
  fireEvent.click(screen.getByRole("button", { name: /Ollama/ }));
  fireEvent.click(screen.getByRole("button", { name: /Test/ }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(vi.mocked(toast.error).mock.calls[0]![1]).toEqual({
    description: expect.stringContaining("OLLAMA_ORIGINS"),
  });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(
    "http://localhost:11434/v1/chat/completions",
  );
});
