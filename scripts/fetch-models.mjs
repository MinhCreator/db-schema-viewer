#!/usr/bin/env node
// Builds public/models.json: the providers and models the AI settings need,
// nothing more. Data and the recommended model come from llm-models.
import { writeFile } from 'fs/promises';
import { fetchUnifiedData, pickTiers, setCacheEnabled } from 'llm-models';

const OUT_PATH = new URL('../public/models.json', import.meta.url).pathname;

/** Maps a pick such as "openai/gpt-x" or "gpt-x" back to a models.dev key of the provider. */
function toProviderModelKey(id, providerId, models) {
  const bare = id.startsWith(`${providerId}/`) ? id.slice(providerId.length + 1) : id;
  if (models[bare]) return bare;
  const dashed = bare.replace(/\./g, '-');
  return Object.keys(models).find((key) => key.replace(/\./g, '-') === dashed);
}

function defaultModelFor(providerId, pool, models) {
  const picks = pickTiers(pool) ?? [];
  const ordered = [...picks.filter((pick) => pick.tier === 'sonnet'), ...picks.filter((pick) => pick.tier !== 'sonnet')];
  for (const pick of ordered) {
    const key = toProviderModelKey(pick.model.id, providerId, models);
    if (key) return key;
  }
  return undefined;
}

async function main() {
  try {
    setCacheEnabled(false);
    console.log('[fetch-models] Fetching models via llm-models');
    const { models: unified, modelsDevData } = await fetchUnifiedData();

    const poolByProvider = new Map();
    for (const model of unified) {
      const pool = poolByProvider.get(model.provider) ?? [];
      pool.push(model);
      poolByProvider.set(model.provider, pool);
    }

    const catalog = {};
    for (const [providerId, provider] of Object.entries(modelsDevData)) {
      const models = {};
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        if (model.status === 'deprecated') continue;
        models[modelId] = {
          id: model.id ?? modelId,
          name: model.name ?? modelId,
          ...(model.tool_call ? { tool_call: true } : {}),
          ...(model.reasoning ? { reasoning: true } : {}),
        };
      }
      if (Object.keys(models).length === 0) continue;
      const defaultModel = defaultModelFor(providerId, poolByProvider.get(providerId) ?? [], models);
      catalog[providerId] = {
        id: provider.id ?? providerId,
        name: provider.name ?? providerId,
        ...(provider.npm ? { npm: provider.npm } : {}),
        ...(provider.api ? { api: provider.api } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        models,
      };
    }

    const json = JSON.stringify(catalog);
    await writeFile(OUT_PATH, json, 'utf8');
    console.log('[fetch-models] Wrote', OUT_PATH, `(${Object.keys(catalog).length} providers, ${(json.length / 1024).toFixed(0)} KiB)`);
  } catch (err) {
    console.error('[fetch-models] Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
