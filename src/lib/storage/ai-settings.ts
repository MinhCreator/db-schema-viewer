import type { AISettings } from "db-schema-toolkit/ai";

export type { AISettings } from "db-schema-toolkit/ai";

/**
 * AI settings storage.
 *
 * Non-secret settings live in localStorage. The API key never touches
 * localStorage or cookies: when "remember" is on, it is encrypted with
 * AES-GCM under a non-extractable CryptoKey, and both the key and the
 * ciphertext are kept in IndexedDB. A dump of browser storage therefore only
 * yields an opaque blob. When "remember" is off, the key lives in memory for
 * the lifetime of the tab.
 *
 * Code running inside the page (an active XSS) can still ask the browser to
 * decrypt; the Content-Security-Policy is what protects against that case.
 */

export interface StoredAISettings extends AISettings {
  rememberKey: boolean;
}

interface SaveOptions {
  rememberKey: boolean;
}

type PublicSettings = Omit<AISettings, "apiKey"> & { rememberKey: boolean };

interface EncryptedSecret {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

const SETTINGS_KEY = "db-sv-ai-settings";
const DB_NAME = "db-sv-secrets";
const STORE = "kv";
const CRYPTO_KEY_ID = "crypto-key";
const API_KEY_ID = "api-key";
const LEGACY_COOKIE_PREFIX = "db-sv-";
const LEGACY_COOKIE_KEYS = [
  "api-key", "model", "provider-id", "provider-name",
  "provider-npm", "provider-api", "custom-endpoint", "custom-model",
  "language",
];

let memoryKey: string | null = null;

/** Drops the in-memory key, as a page reload would. */
export function resetAISettingsCacheForTests(): void {
  memoryKey = null;
}

/* ---------- IndexedDB ---------- */

function openSecrets(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openSecrets();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const idbGet = <T>(id: string) => withStore<T | undefined>("readonly", (s) => s.get(id) as IDBRequest<T | undefined>);
const idbPut = (id: string, value: unknown) => withStore("readwrite", (s) => s.put(value, id));
const idbDelete = (id: string) => withStore("readwrite", (s) => s.delete(id));

/* ---------- Encryption ---------- */

async function getCryptoKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(CRYPTO_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbPut(CRYPTO_KEY_ID, key);
  return key;
}

async function storeEncryptedKey(apiKey: string): Promise<void> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(apiKey));
  const secret: EncryptedSecret = { iv, ciphertext };
  await idbPut(API_KEY_ID, secret);
}

async function readEncryptedKey(): Promise<string> {
  const secret = await idbGet<EncryptedSecret>(API_KEY_ID);
  const key = await idbGet<CryptoKey>(CRYPTO_KEY_ID);
  if (!secret || !key) return "";
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: secret.iv }, key, secret.ciphertext);
  return new TextDecoder().decode(plain);
}

/* ---------- Public settings ---------- */

function readPublicSettings(): PublicSettings | null {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PublicSettings>;
    if (typeof parsed.model !== "string" || typeof parsed.providerId !== "string") return null;
    return { ...parsed, model: parsed.model, providerId: parsed.providerId, rememberKey: parsed.rememberKey !== false };
  } catch {
    return null;
  }
}

function writePublicSettings(settings: AISettings, rememberKey: boolean): void {
  const publicSettings: PublicSettings = {
    model: settings.model,
    providerId: settings.providerId,
    providerName: settings.providerName || undefined,
    providerNpm: settings.providerNpm || undefined,
    providerApi: settings.providerApi || undefined,
    customEndpoint: settings.customEndpoint || undefined,
    customModel: settings.customModel || undefined,
    language: settings.language || undefined,
    rememberKey,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(publicSettings));
}

/* ---------- Legacy cookies ---------- */

function readLegacyCookies(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (!name.startsWith(LEGACY_COOKIE_PREFIX)) continue;
    values[name.slice(LEGACY_COOKIE_PREFIX.length)] = decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return values;
}

function deleteLegacyCookies(): void {
  for (const key of LEGACY_COOKIE_KEYS) {
    document.cookie = `${LEGACY_COOKIE_PREFIX}${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Strict`;
  }
}

async function migrateLegacyCookies(): Promise<void> {
  const legacy = readLegacyCookies();
  if (Object.keys(legacy).length === 0) return;
  const apiKey = legacy["api-key"] ?? "";
  if (apiKey || legacy["custom-endpoint"]) {
    await saveAISettings(
      {
        apiKey,
        model: legacy.model ?? "",
        providerId: legacy["provider-id"] ?? "openai",
        providerName: legacy["provider-name"],
        providerNpm: legacy["provider-npm"],
        providerApi: legacy["provider-api"],
        customEndpoint: legacy["custom-endpoint"],
        customModel: legacy["custom-model"],
        language: legacy.language,
      },
      { rememberKey: true },
    );
  }
  deleteLegacyCookies();
}

/* ---------- API ---------- */

export async function saveAISettings(settings: AISettings, { rememberKey }: SaveOptions): Promise<void> {
  if (typeof window === "undefined") return;
  writePublicSettings(settings, rememberKey);
  memoryKey = settings.apiKey;
  if (rememberKey && settings.apiKey) {
    await storeEncryptedKey(settings.apiKey);
  } else {
    await idbDelete(API_KEY_ID);
  }
}

export async function loadAISettings(): Promise<StoredAISettings | null> {
  const saved = await loadAISettingsDraft();
  // Settings exist if we have an API key OR a custom endpoint (local Ollama/LM Studio)
  if (!saved || (!saved.apiKey && !saved.customEndpoint)) return null;
  return saved;
}

/** Saved settings even when the key is missing, so the settings form can be prefilled. */
export async function loadAISettingsDraft(): Promise<StoredAISettings | null> {
  if (typeof window === "undefined") return null;
  await migrateLegacyCookies();
  const saved = readPublicSettings();
  if (!saved) return null;
  if (memoryKey === null) {
    memoryKey = saved.rememberKey ? await readEncryptedKey() : "";
  }
  return { ...saved, apiKey: memoryKey };
}

export async function clearAISettings(): Promise<void> {
  if (typeof window === "undefined") return;
  memoryKey = null;
  localStorage.removeItem(SETTINGS_KEY);
  deleteLegacyCookies();
  await idbDelete(API_KEY_ID);
  await idbDelete(CRYPTO_KEY_ID);
}
