import type { LlmSettings } from "llm-connect";

/**
 * What the AI functions need to call a model: llm-connect's settings (a
 * catalog provider, or a custom OpenAI-compatible endpoint) and the language
 * to answer in, as a code ("fr") or an English name ("French").
 */
export type AISettings = LlmSettings;
