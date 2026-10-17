import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Diagram } from "db-schema-toolkit";
import type { SchemaDiff } from "db-schema-toolkit/analysis";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/storage/ai-settings", () => ({
  loadAISettings: vi.fn(async () => ({ provider: "openai", apiKey: "test-key", model: "test" })),
}));
vi.mock("db-schema-toolkit/ai", () => ({ querySchema: vi.fn(), schemaToPromptContext: vi.fn(() => "Table: users\n  email VARCHAR(320) NOT NULL") }));
vi.mock("@/lib/parsing/parse-input", () => ({ parseSchemaInput: vi.fn() }));
vi.mock("db-schema-toolkit/analysis", () => ({ diffSchemas: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { querySchema } from "db-schema-toolkit/ai";
import { diffSchemas } from "db-schema-toolkit/analysis";
import { parseSchemaInput } from "@/lib/parsing/parse-input";
import { SourceViewer } from "@/app/_components/source/SourceViewer";
import { SchemaDiffPanel } from "@/app/_components/analysis/SchemaDiffPanel";

const diagram: Diagram = { id: "a", name: "A", databaseType: "postgresql", tables: [], relationships: [], createdAt: "2026-01-01" };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

it("reports a clipboard failure in the source viewer", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.reject(new DOMException("Denied", "NotAllowedError"))) },
  });
  render(<I18nProvider><SourceViewer sourceContent="CREATE TABLE t();" diagramName="A" onClose={() => {}} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(toast.success).not.toHaveBeenCalled();
});

it("source viewer is a labelled modal that returns focus to its trigger", () => {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  trigger.focus();
  const view = render(<I18nProvider><SourceViewer sourceContent="x" diagramName="A" onClose={() => {}} /></I18nProvider>);
  const dialog = screen.getByRole("dialog", { name: "Source Schema" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "Close source viewer" })).toBeInTheDocument();
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("stops the AI migration analysis when comparing another schema", async () => {
  const diff: SchemaDiff = {
    addedTables: ["orders"], removedTables: [], modifiedTables: [],
    addedRelationships: [], removedRelationships: [], summary: "1 table added",
  };
  vi.mocked(diffSchemas).mockReturnValue(diff);
  vi.mocked(parseSchemaInput).mockResolvedValue({ diagram } as Awaited<ReturnType<typeof parseSchemaInput>>);
  let signal: AbortSignal | undefined;
  vi.mocked(querySchema).mockImplementation((_s, _d, _q, _chunk, _done, _h, abortSignal) => {
    signal = abortSignal;
    return new Promise<void>(() => {});
  });
  render(<I18nProvider><SchemaDiffPanel currentDiagram={diagram} onClose={() => {}} /></I18nProvider>);
  expect(screen.getByRole("dialog", { name: "Schema Diff" })).toHaveAttribute("aria-modal", "true");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["CREATE TABLE orders(id INT);"], "new.sql")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Analyze with AI" }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Compare another schema" }));
  expect(signal!.aborted).toBe(true);
  expect(screen.queryByText("Analyzing migration...")).not.toBeInTheDocument();
});

it("sends the AI each change with its old and new value, and the new schema", async () => {
  const diff: SchemaDiff = {
    addedTables: ["alerts"], removedTables: ["widgets"],
    modifiedTables: [{
      tableName: "users", addedFields: ["locale"], removedFields: [], addedIndexes: [], removedIndexes: [],
      modifiedFields: [{ fieldName: "email", changes: [{ property: "type", oldValue: "VARCHAR(255)", newValue: "VARCHAR(320)" }, { property: "nullable", oldValue: "true", newValue: "false" }] }],
    }],
    addedRelationships: [{ sourceTable: "alerts", sourceField: "metric_id", targetTable: "metrics", targetField: "id", cardinality: "one-to-many" }],
    removedRelationships: [], summary: "Added 1 table, removed 1 table",
  };
  vi.mocked(diffSchemas).mockReturnValue(diff);
  vi.mocked(parseSchemaInput).mockResolvedValue({ diagram } as Awaited<ReturnType<typeof parseSchemaInput>>);
  vi.mocked(querySchema).mockResolvedValue(undefined);
  render(<I18nProvider><SchemaDiffPanel currentDiagram={diagram} onClose={() => {}} /></I18nProvider>);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["CREATE TABLE alerts(id INT);"], "new.sql")] } });
  // The summary comes from the interface strings, not the toolkit's English sentence
  expect(await screen.findByText("Added Tables: 1 · Removed Tables: 1 · Modified Tables: 1 · Added Relationships: 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
  await waitFor(() => expect(querySchema).toHaveBeenCalledTimes(1));
  const question = vi.mocked(querySchema).mock.calls[0]![2];
  expect(question).toContain("changed email: type VARCHAR(255) -> VARCHAR(320); nullable true -> false");
  expect(question).toContain("Added relationship: alerts.metric_id -> metrics.id (one-to-many)");
  expect(question).toContain("NEW SCHEMA:\nTable: users");
});
