import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveAISettings,
  loadAISettings,
  clearAISettings,
  resetAISettingsCacheForTests,
  type AISettings,
} from "@/lib/storage/ai-settings";

const testSettings: AISettings = {
  apiKey: "test-key-123",
  model: "gpt-4o",
  providerId: "openai",
  providerName: "OpenAI",
  providerNpm: "@ai-sdk/openai",
  providerApi: "https://api.openai.com/v1",
  customEndpoint: undefined,
  customModel: undefined,
};

function clearCookies() {
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

async function readRawSecrets(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("db-sv-secrets");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.close();
        resolve([]);
        return;
      }
      const request = db.transaction("kv", "readonly").objectStore("kv").getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result as unknown[]);
      };
      request.onerror = () => reject(request.error);
    };
  });
}

describe("ai-settings storage", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    clearCookies();
    resetAISettingsCacheForTests();
  });

  it("saves and loads AI settings", async () => {
    await saveAISettings(testSettings, { rememberKey: true });
    resetAISettingsCacheForTests();
    const loaded = await loadAISettings();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("test-key-123");
    expect(loaded!.model).toBe("gpt-4o");
    expect(loaded!.providerId).toBe("openai");
    expect(loaded!.rememberKey).toBe(true);
  });

  it("returns null when no settings are saved", async () => {
    expect(await loadAISettings()).toBeNull();
  });

  it("never writes the API key in clear text to localStorage, cookies or IndexedDB", async () => {
    await saveAISettings(testSettings, { rememberKey: true });
    expect(document.cookie).not.toContain("test-key-123");
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key)).not.toContain("test-key-123");
    }
    const raw = await readRawSecrets();
    expect(raw.length).toBeGreaterThan(0);
    const cryptoKey = raw.find((value) => value instanceof CryptoKey) as CryptoKey | undefined;
    expect(cryptoKey?.extractable).toBe(false);
    expect(JSON.stringify(raw)).not.toContain("test-key-123");
    const blob = raw.find((value) => !(value instanceof CryptoKey)) as { ciphertext: ArrayBuffer };
    expect(new TextDecoder().decode(blob.ciphertext)).not.toContain("test-key-123");
  });

  it("keeps the key in memory only when rememberKey is false", async () => {
    await saveAISettings(testSettings, { rememberKey: false });
    expect((await loadAISettings())?.apiKey).toBe("test-key-123");
    expect(await readRawSecrets()).toEqual([]);

    resetAISettingsCacheForTests();
    const reloaded = await loadAISettings();
    expect(reloaded).toBeNull();
  });

  it("forgets a previously remembered key when rememberKey is turned off", async () => {
    await saveAISettings(testSettings, { rememberKey: true });
    await saveAISettings(testSettings, { rememberKey: false });
    const raw = await readRawSecrets();
    expect(raw.some((value) => !(value instanceof CryptoKey))).toBe(false);
  });

  it("clears previous provider metadata when switching to a minimal configuration", async () => {
    await saveAISettings(testSettings, { rememberKey: true });
    await saveAISettings({ apiKey: "test", model: "local", providerId: "custom" }, { rememberKey: true });
    const loaded = await loadAISettings();
    expect(loaded?.providerApi).toBeUndefined();
    expect(loaded?.providerNpm).toBeUndefined();
    expect(loaded?.providerName).toBeUndefined();
  });

  it("clears all settings", async () => {
    await saveAISettings(testSettings, { rememberKey: true });
    await clearAISettings();
    expect(await loadAISettings()).toBeNull();
    resetAISettingsCacheForTests();
    expect(await loadAISettings()).toBeNull();
  });

  it("loads a keyless custom endpoint such as a local Ollama", async () => {
    await saveAISettings(
      {
        apiKey: "",
        model: "llama3.2",
        providerId: "openai",
        customEndpoint: "http://localhost:11434/v1",
        customModel: "llama3.2",
        language: "French",
      },
      { rememberKey: true },
    );
    resetAISettingsCacheForTests();
    const loaded = await loadAISettings();
    expect(loaded?.apiKey).toBe("");
    expect(loaded?.customEndpoint).toBe("http://localhost:11434/v1");
    expect(loaded?.customModel).toBe("llama3.2");
    expect(loaded?.language).toBe("French");
  });

  it("migrates legacy db-sv-* cookies once and deletes them", async () => {
    document.cookie = "db-sv-api-key=legacy-key; path=/";
    document.cookie = "db-sv-model=claude-sonnet; path=/";
    document.cookie = "db-sv-provider-id=anthropic; path=/";
    document.cookie = "db-sv-language=German; path=/";

    const loaded = await loadAISettings();
    expect(loaded?.apiKey).toBe("legacy-key");
    expect(loaded?.model).toBe("claude-sonnet");
    expect(loaded?.providerId).toBe("anthropic");
    expect(loaded?.language).toBe("German");
    expect(document.cookie).not.toContain("db-sv-");

    resetAISettingsCacheForTests();
    expect((await loadAISettings())?.apiKey).toBe("legacy-key");
  });
});
