"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X, Key, Eye, EyeOff, Server, Loader2, Zap, Check, AlertTriangle, Search, Globe } from "lucide-react";
import { useTranslation } from "@/lib/i18n/context";
import {
  loadAISettingsDraft,
  saveAISettings,
  clearAISettings,
  type AISettings,
} from "@/lib/storage/ai-settings";
import { querySchema } from "db-schema-toolkit/ai";

/* ---------- Catalog types ---------- */

interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  providerName?: string;
  tool_call?: boolean;
  reasoning?: boolean;
}

interface ProviderInfo {
  id: string;
  name: string;
  npm?: string;
  api?: string;
  defaultModel?: string;
  models: Record<string, ModelInfo>;
}

type ModelCatalog = Record<string, ProviderInfo>;

/* ---------- Defaults ---------- */

const RECOMMENDED_PROVIDER_IDS = ["openai", "anthropic", "google", "mistral"];

function defaultModelOf(provider: ProviderInfo | undefined): string | undefined {
  if (!provider) return undefined;
  if (provider.defaultModel && provider.models[provider.defaultModel]) return provider.defaultModel;
  return Object.keys(provider.models)[0];
}

/* ---------- Component ---------- */

interface APIKeySettingsProps {
  onClose: () => void;
}

export function APIKeySettings({ onClose }: APIKeySettingsProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState("openai");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [useCustomEndpoint, setUseCustomEndpoint] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [language, setLanguage] = useState("English");
  const [rememberKey, setRememberKey] = useState(true);

  // Catalog state
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);

  // Load saved settings
  useEffect(() => {
    let cancelled = false;
    loadAISettingsDraft()
      .then((saved) => {
        if (cancelled || !saved) return;
        setApiKey(saved.apiKey);
        setModel(saved.model);
        setProviderId(saved.providerId);
        setCustomEndpoint(saved.customEndpoint ?? "");
        setCustomModel(saved.customModel ?? "");
        setUseCustomEndpoint(!!saved.customEndpoint);
        setLanguage(saved.language ?? "English");
        setRememberKey(saved.rememberKey);
      })
      .catch((err) => {
        console.error("Failed to load AI settings:", err);
      });
    return () => { cancelled = true; };
  }, []);

  // Load catalog from models.json (once per attempt; a failure waits for "Retry")
  useEffect(() => {
    let cancelled = false;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
    fetch(`${basePath}/models.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ModelCatalog>;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setCatalogError(false);
        setIsLoadingCatalog(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load models catalog:", err);
        setCatalogError(true);
        setIsLoadingCatalog(false);
      });
    return () => { cancelled = true; };
  }, [catalogAttempt]);

  const retryCatalog = useCallback(() => {
    setIsLoadingCatalog(true);
    setCatalogError(false);
    setCatalogAttempt((n) => n + 1);
  }, []);

  // Pick the provider's default model once the catalog arrives and nothing is selected yet
  useEffect(() => {
    if (!catalog || model) return;
    const fallback = defaultModelOf(catalog[providerId]);
    if (fallback) setModel(fallback);
  }, [catalog, providerId, model]);

  // Provider derived from catalog
  const selectedProvider = useMemo(() => {
    return catalog?.[providerId] ?? null;
  }, [catalog, providerId]);

  // Split providers into recommended / others
  const providerSelectOptions = useMemo(() => {
    if (!catalog) return { recommended: [], others: [] };

    const allProviders = Object.values(catalog);

    const recommended = RECOMMENDED_PROVIDER_IDS
      .map((id) => allProviders.find((p) => p.id === id))
      .filter(Boolean) as ProviderInfo[];

    const others = allProviders
      .filter((p) => !RECOMMENDED_PROVIDER_IDS.includes(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      recommended: recommended.map((p) => ({ id: p.id, name: p.name })),
      others: others.map((p) => ({ id: p.id, name: p.name })),
    };
  }, [catalog]);

  // Filtered model list for current provider
  const modelOptions = useMemo(() => {
    if (!selectedProvider) return [];
    const models = Object.values(selectedProvider.models).map((m) => ({
      ...m,
      providerName: selectedProvider.name,
    }));

    if (!searchTerm.trim()) return models;

    const search = searchTerm.toLowerCase();
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(search) ||
        m.id.toLowerCase().includes(search),
    );
  }, [selectedProvider, searchTerm]);

  // Provider metadata for saving
  const providerMeta = useMemo(() => {
    if (selectedProvider) {
      return {
        providerId: selectedProvider.id,
        providerName: selectedProvider.name,
        providerNpm: selectedProvider.npm ?? "",
        providerApi: selectedProvider.api ?? "",
      };
    }
    return {
      providerId: "openai",
      providerName: "OpenAI",
      providerNpm: "@ai-sdk/openai",
      providerApi: "https://api.openai.com/v1",
    };
  }, [selectedProvider]);

  const buildSettings = useCallback((): AISettings => {
    return {
      apiKey,
      model,
      providerId: providerMeta.providerId,
      providerName: providerMeta.providerName,
      providerNpm: providerMeta.providerNpm,
      providerApi: providerMeta.providerApi,
      customEndpoint: useCustomEndpoint ? customEndpoint : undefined,
      customModel: useCustomEndpoint ? customModel : undefined,
      language,
    };
  }, [apiKey, model, providerMeta, useCustomEndpoint, customEndpoint, customModel, language]);

  const handleSave = async () => {
    const settings = buildSettings();
    try {
      await saveAISettings(settings, { rememberKey });
    } catch (err) {
      console.error("Failed to save AI settings:", err);
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    toast.success(t("settings.saved"));
    onClose();
  };

  const handleClear = async () => {
    try {
      await clearAISettings();
    } catch (err) {
      console.error("Failed to clear AI settings:", err);
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    setApiKey("");
    setCustomEndpoint("");
    setCustomModel("");
    setUseCustomEndpoint(false);
    toast.success(t("settings.cleared"));
  };

  const handleTestConnection = useCallback(async () => {
    const settings = buildSettings();
    if (!settings.apiKey && !useCustomEndpoint) {
      toast.error(t("settings.enterApiKeyFirst"));
      return;
    }
    if (useCustomEndpoint && (!customEndpoint.trim() || !customModel.trim())) {
      toast.error(t("settings.fillEndpointAndModel"));
      return;
    }

    setIsTesting(true);
    try {
      if (useCustomEndpoint) {
        const res = await fetch(`${customEndpoint.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: customModel,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: false,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
        }
      } else {
        const minDiagram = {
          id: "t", name: "t", databaseType: "generic" as const,
          tables: [{
            id: "t", name: "t", fields: [{ id: "f", name: "id", type: "int", primaryKey: true, unique: false, nullable: false, isForeignKey: false }],
            indexes: [], x: 0, y: 0, isView: false,
          }],
          relationships: [], createdAt: "",
        };
        await querySchema(settings, minDiagram, "Say OK in 2 words max", () => {}, () => {}, []);
      }
      toast.success(t("settings.connectionSuccessful"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("settings.connectionFailed");
      if (message.includes("Failed to fetch")) {
        toast.error(t("settings.connectionFailed"), {
          description: t("settings.connectionFailedCors"),
        });
      } else {
        toast.error(message);
      }
    } finally {
      setIsTesting(false);
    }
  }, [buildSettings, useCustomEndpoint, customEndpoint, customModel, t]);

  // Recommended model for the current provider
  const recommendedModelId = selectedProvider?.defaultModel;
  const recommendedModel = recommendedModelId
    ? modelOptions.find((m) => m.id === recommendedModelId)
    : null;

  const modalContent = (
    <>
      <div className="fixed inset-0 z-50 bg-gray-950/90 backdrop-blur-sm" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="animate-scale-in pointer-events-auto max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/20 p-2">
                <Key className="h-5 w-5 text-indigo-400" />
              </div>
              <h2 className="text-lg font-bold text-foreground">{t("settings.title")}</h2>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 hover:bg-accent">
              <X className="h-5 w-5 text-muted-foreground" />
            </button>
          </div>

          {/* Content */}
          <div className="space-y-5 p-6">
            {/* Security notice */}
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
              {t("settings.securityNotice")}
            </div>

            {/* Custom endpoint toggle */}
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={useCustomEndpoint}
                onChange={(e) => setUseCustomEndpoint(e.target.checked)}
                className="rounded border-border"
              />
              <Server className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-foreground">{t("settings.useCustomEndpoint")}</span>
            </label>

            {useCustomEndpoint ? (
              <div className="space-y-3">
                {/* Preset buttons */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomEndpoint("http://localhost:11434/v1");
                      if (!customModel.trim()) setCustomModel("llama3.2");
                    }}
                    className={`flex-1 rounded-lg border p-2 text-center text-sm font-medium transition-all ${
                      customEndpoint === "http://localhost:11434/v1"
                        ? "border-emerald-500 bg-emerald-500/15 text-foreground"
                        : "border-border bg-accent text-foreground hover:border-emerald-500/50"
                    }`}
                  >
                    <Server className="mx-auto mb-1 h-4 w-4" />
                    Ollama
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomEndpoint("http://localhost:1234/v1");
                      if (!customModel.trim()) setCustomModel("lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF");
                    }}
                    className={`flex-1 rounded-lg border p-2 text-center text-sm font-medium transition-all ${
                      customEndpoint === "http://localhost:1234/v1"
                        ? "border-emerald-500 bg-emerald-500/15 text-foreground"
                        : "border-border bg-accent text-foreground hover:border-emerald-500/50"
                    }`}
                  >
                    <Server className="mx-auto mb-1 h-4 w-4" />
                    LM Studio
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-sm text-foreground">{t("settings.apiBaseUrl")}</label>
                  <input
                    type="text"
                    value={customEndpoint}
                    onChange={(e) => setCustomEndpoint(e.target.value)}
                    placeholder={t("settings.apiBaseUrlPlaceholder")}
                    className="w-full rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-indigo-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settings.apiBaseUrlHint")}
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-foreground">{t("settings.modelName")}</label>
                  <input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder={t("settings.modelNamePlaceholder")}
                    className="w-full rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Provider */}
                <div>
                  <label className="mb-1 block text-sm text-foreground">{t("settings.provider")}</label>
                  {isLoadingCatalog ? (
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-accent px-3 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("settings.loadingProviders")}
                    </div>
                  ) : catalogError ? (
                    <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
                      <span>{t("settings.catalogError")}</span>
                      <button
                        type="button"
                        onClick={retryCatalog}
                        className="rounded-md border border-amber-500/40 px-2 py-1 text-xs font-medium hover:bg-amber-500/10"
                      >
                        {t("settings.retry")}
                      </button>
                    </div>
                  ) : (
                    <select
                      value={providerId}
                      onChange={(e) => {
                        const newProviderId = e.target.value;
                        setProviderId(newProviderId);
                        setSearchTerm("");
                        // Auto-select recommended model or first available
                        const defaultModel = defaultModelOf(catalog?.[newProviderId]);
                        if (defaultModel) setModel(defaultModel);
                      }}
                      className="w-full rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground focus:outline-none"
                    >
                      {providerSelectOptions.recommended.length > 0 && (
                        <optgroup label={t("settings.recommended")}>
                          {providerSelectOptions.recommended.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </optgroup>
                      )}
                      {providerSelectOptions.others.length > 0 && (
                        <optgroup label={t("settings.otherProviders")}>
                          {providerSelectOptions.others.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  )}
                  {providerSelectOptions.others.some((p) => p.id === providerId) && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <p className="text-xs text-amber-400">
                        {t("settings.openAiCompatibleWarning")}
                      </p>
                    </div>
                  )}
                </div>

                {/* Model */}
                <div>
                  <label className="mb-1 block text-sm text-foreground">{t("settings.model")}</label>

                  {/* Recommended model badge */}
                  {recommendedModel && (
                    <div className="mb-2">
                      <div className="mb-1 flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                        <span className="text-[10px] font-semibold tracking-wide text-emerald-400 uppercase">{t("settings.recommended")}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setModel(recommendedModel.id)}
                        className={`w-full rounded-lg border p-2.5 text-left text-sm transition-all ${
                          model === recommendedModel.id
                            ? "border-emerald-500 bg-emerald-500/15 text-foreground"
                            : "border-emerald-500/40 bg-emerald-500/5 text-foreground hover:border-emerald-500 hover:bg-emerald-500/10"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{recommendedModel.name}</span>
                          {model === recommendedModel.id && <Check className="h-4 w-4 shrink-0 text-emerald-400" />}
                        </div>
                      </button>
                    </div>
                  )}

                  {/* Model search */}
                  {modelOptions.length > 5 && (
                    <div className="relative mb-2">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder={t("settings.searchModels")}
                        className="w-full rounded-lg border border-border bg-accent pl-8 pr-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                  )}

                  {/* Model list */}
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {modelOptions.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setModel(m.id)}
                        className={`w-full rounded-lg border p-2.5 text-left text-sm transition-all ${
                          model === m.id
                            ? "border-indigo-500 bg-indigo-500/15 text-foreground"
                            : "border-border bg-accent text-foreground hover:border-indigo-500/50"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{m.name}</span>
                          {model === m.id && <Check className="h-4 w-4 shrink-0 text-indigo-400" />}
                        </div>
                        <div className="mt-1 flex gap-1.5 text-[10px] text-muted-foreground">
                          {m.tool_call && (
                            <span className="rounded bg-accent px-1.5 py-0.5 border border-border">Tools</span>
                          )}
                          {m.reasoning && (
                            <span className="rounded bg-accent px-1.5 py-0.5 border border-border">Reasoning</span>
                          )}
                        </div>
                      </button>
                    ))}
                    {modelOptions.length === 0 && !isLoadingCatalog && (
                      <p className="py-2 text-center text-xs text-muted-foreground">
                        {searchTerm ? t("settings.noModelsMatchSearch") : t("settings.noModelsAvailable")}
                      </p>
                    )}
                    {isLoadingCatalog && (
                      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("settings.loadingModels")}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* API Key */}
            <div>
              <label className="mb-1 block text-sm text-foreground">
                {useCustomEndpoint ? t("settings.apiKeyOptional") : t("settings.apiKey")}
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t("settings.apiKeyPlaceholder")}
                  className="w-full rounded-lg border border-border bg-accent px-3 py-2 pr-10 text-sm text-foreground placeholder-muted-foreground focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-accent"
                >
                  {showKey ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.keyStorageInfo")}
              </p>
              <label className="mt-2 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={rememberKey}
                  onChange={(e) => setRememberKey(e.target.checked)}
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="block text-sm text-foreground">{t("settings.rememberKey")}</span>
                  <span className="block text-xs text-muted-foreground">{t("settings.rememberKeyHint")}</span>
                </span>
              </label>
            </div>

            {/* Language */}
            <div>
              <label className="mb-1 flex items-center gap-2 text-sm text-foreground">
                <Globe className="h-4 w-4 text-muted-foreground" />
                {t("settings.language")}
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground focus:outline-none"
              >
                <option value="English">English</option>
                <option value="French">Français</option>
                <option value="Spanish">Español</option>
                <option value="German">Deutsch</option>
                <option value="Italian">Italiano</option>
                <option value="Portuguese">Português</option>
                <option value="Dutch">Nederlands</option>
                <option value="Russian">Русский</option>
                <option value="Chinese">中文</option>
                <option value="Japanese">日本語</option>
                <option value="Korean">한국어</option>
                <option value="Arabic">العربية</option>
                <option value="Hindi">हिन्दी</option>
                <option value="Turkish">Türkçe</option>
                <option value="Polish">Polski</option>
                <option value="Swedish">Svenska</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.languageHint")}
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 border-t border-border px-6 py-4">
            <button
              onClick={handleClear}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              {t("common.clear")}
            </button>
            <div className="flex-1" />
            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {isTesting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              {t("settings.test")}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={
                useCustomEndpoint
                  ? !customEndpoint.trim() || !customModel.trim()
                  : !apiKey.trim() || !model
              }
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(modalContent, document.body);
}
