import { test, expect, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });

const model = (id: string, name: string) => ({
  id, name, attachment: false, reasoning: false, tool_call: true, open_weights: false,
  release_date: "2026-01-01", last_updated: "2026-01-01",
  modalities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: 8192 },
});
const provider = (id: string, name: string, npm: string, models: ReturnType<typeof model>[]) => ({
  id, name, npm, doc: "", env: [], models: Object.fromEntries(models.map((m) => [m.id, m])),
});
/** What models.dev answers, reduced to the four recommended providers. */
const modelsDev = {
  openai: provider("openai", "OpenAI", "@ai-sdk/openai", [model("gpt-live", "GPT Live")]),
  anthropic: provider("anthropic", "Anthropic", "@ai-sdk/anthropic", [model("claude-live", "Claude Live")]),
  google: provider("google", "Google", "@ai-sdk/google", [model("gemini-live", "Gemini Live")]),
  mistral: provider("mistral", "Mistral", "@ai-sdk/mistral", [model("mistral-live", "Mistral Live")]),
};

async function openSettings(page: Page) {
  await page.goto("./");
  await page.getByRole("button", { name: "Import Schema", exact: true }).click();
  await page.getByRole("button", { name: /Auto-Detect/ }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "data.sql", mimeType: "text/plain", buffer: Buffer.from("CREATE TABLE users(id INT PRIMARY KEY);") });
  await expect(page.locator(".react-flow__node-table")).toHaveCount(1);
  await page.getByRole("button", { name: "AI Settings", exact: true }).click();
}

const providerSelect = (page: Page) => page.locator("select").filter({ has: page.locator('option[value="anthropic"]') });

test("the model catalog is built live from models.dev", async ({ page }) => {
  const requests: string[] = [];
  await page.route("https://models.dev/**", (route) => { requests.push(route.request().url()); return route.fulfill({ json: modelsDev }); });
  await page.route("https://openrouter.ai/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.route("**/models.json", (route) => { requests.push(route.request().url()); return route.fulfill({ status: 404 }); });
  await openSettings(page);
  await providerSelect(page).selectOption("anthropic");
  await expect(page.getByRole("button", { name: /Claude Live/ }).first()).toBeVisible();
  expect(requests).toEqual(["https://models.dev/api.json"]);
});

test("the catalog falls back to models.json when models.dev is unreachable", async ({ page }) => {
  const fallback = { anthropic: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", defaultModel: "claude-fallback", models: { "claude-fallback": { id: "claude-fallback", name: "Claude Fallback" } } } };
  await page.route("https://models.dev/**", (route) => route.abort());
  await page.route("https://openrouter.ai/**", (route) => route.abort());
  await page.route("**/models.json", (route) => route.fulfill({ json: fallback }));
  await openSettings(page);
  await providerSelect(page).selectOption("anthropic");
  await expect(page.getByRole("button", { name: /Claude Fallback/ }).first()).toBeVisible();
});

test("a remote plain-http endpoint is refused, a local one is saved", async ({ page }) => {
  await page.route("https://models.dev/**", (route) => route.fulfill({ json: modelsDev }));
  await page.route("https://openrouter.ai/**", (route) => route.abort());
  await openSettings(page);
  await page.getByRole("checkbox", { name: /custom/i }).check();
  await page.getByPlaceholder("http://localhost:11434/v1").fill("http://192.168.1.10/v1");
  await page.getByPlaceholder(/llama3\.2/).fill("llama3.2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Plain http is only allowed/)).toBeVisible();
  await page.getByRole("button", { name: "Ollama", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();
});
