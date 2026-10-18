import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveDiagram, loadDiagram, listDiagrams, deleteDiagram, saveProject, loadProject, withoutIdConflict, resolveSharedProject } from "@/lib/storage/local-storage";
import { createProject } from "@/lib/project/project";
import type { Diagram } from "db-schema-toolkit";

const testDiagram: Diagram = {
  id: "test-1",
  name: "Test Schema",
  databaseType: "postgresql",
  tables: [],
  relationships: [],
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("local-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves and loads a diagram", () => {
    saveDiagram(testDiagram);
    const loaded = loadDiagram("test-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Test Schema");
  });

  it("lists saved diagrams", () => {
    saveDiagram(testDiagram);
    saveDiagram({ ...testDiagram, id: "test-2", name: "Another" });

    const list = listDiagrams();
    expect(list).toHaveLength(2);
  });

  it("deletes a diagram", () => {
    saveDiagram(testDiagram);
    deleteDiagram("test-1");

    expect(loadDiagram("test-1")).toBeNull();
    expect(listDiagrams()).toHaveLength(0);
  });

  it("returns null for non-existent diagram", () => {
    expect(loadDiagram("nonexistent")).toBeNull();
  });

  it("ignores a corrupt index and recovers diagrams from their records", () => {
    saveDiagram(testDiagram);
    localStorage.setItem("db-schema-viewer-diagrams", '{"unexpected":true}');
    expect(listDiagrams().map((d) => d.id)).toEqual(["test-1"]);
  });

  it("rejects valid JSON that is not a diagram", () => {
    localStorage.setItem("db-schema-viewer-diagram-bad", '{"tables":null}');
    expect(loadDiagram("bad")).toBeNull();
  });

  it("updates existing diagram in index", () => {
    saveDiagram(testDiagram);
    saveDiagram({ ...testDiagram, name: "Updated Name" });

    const list = listDiagrams();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Updated Name");
  });
});

describe("recent projects index", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lists recent projects without reading every project record", () => {
    saveDiagram(testDiagram);
    saveDiagram({ ...testDiagram, id: "test-2", name: "Another" });
    const reads = vi.spyOn(localStorage, "getItem");
    expect(listDiagrams().map((d) => d.name).sort()).toEqual(["Another", "Test Schema"]);
    expect(reads.mock.calls.filter(([key]) => key.startsWith("db-schema-viewer-diagram-"))).toEqual([]);
    reads.mockRestore();
  });

  it("recovers records written without an index entry", () => {
    saveDiagram(testDiagram);
    localStorage.setItem("db-schema-viewer-diagram-legacy", JSON.stringify({ ...testDiagram, id: "legacy", name: "Legacy" }));
    expect(listDiagrams().map((d) => d.id).sort()).toEqual(["legacy", "test-1"]);
  });

  it("hides a record that turned out to be invalid when it is opened", () => {
    saveDiagram(testDiagram);
    localStorage.setItem("db-schema-viewer-diagram-test-1", '{"version":1,"broken":true}');
    expect(loadDiagram("test-1")).toBeNull();
    expect(listDiagrams()).toEqual([]);
  });

  it("forgets deleted projects", () => {
    saveDiagram(testDiagram);
    expect(listDiagrams()).toHaveLength(1);
    deleteDiagram("test-1");
    expect(listDiagrams()).toEqual([]);
  });
});

describe("quota handling", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  // vi.restoreAllMocks() does not restore spies on happy-dom's localStorage.
  let spy: { mockRestore(): void } | undefined;
  afterEach(() => { spy?.mockRestore(); spy = undefined; });

  it("retries without the source when storage is full", () => {
    const original = localStorage.setItem.bind(localStorage);
    spy = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (value.includes("HUGE SOURCE")) throw new DOMException("Full", "QuotaExceededError");
      original(key, value);
    });
    const project = createProject({ ...testDiagram, sourceContent: "HUGE SOURCE" });
    expect(saveProject(project)).toEqual({ sourceDropped: true });
    const stored = loadProject("test-1");
    expect(stored?.diagram.name).toBe("Test Schema");
    expect(stored?.diagram.sourceContent).toBeUndefined();
  });

  it("rethrows other storage errors", () => {
    spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    expect(() => saveProject(createProject({ ...testDiagram, sourceContent: "src" }))).toThrow("Denied");
  });
});

describe("id conflicts", () => {
  const table = { id: "t1", name: "users", fields: [{ id: "f1", name: "id", type: "INT", primaryKey: true, unique: false, nullable: false, isForeignKey: false }], indexes: [], x: 0, y: 0, isView: false };
  const stored = createProject({ ...testDiagram, tables: [table], sourceContent: "CREATE TABLE users(id INT PRIMARY KEY);" });
  beforeEach(() => {
    localStorage.clear();
    saveProject(stored);
  });

  it("keeps the id of an import identical to the local project", () => {
    const incoming = createProject({ ...stored.diagram });
    expect(withoutIdConflict(incoming).diagram.id).toBe("test-1");
  });

  it("forks an import whose id exists locally with different content", () => {
    const incoming = createProject({ ...stored.diagram, tables: [{ ...table, name: "accounts" }] });
    const opened = withoutIdConflict(incoming);
    expect(opened.diagram.id).not.toBe("test-1");
    expect(opened.diagram.tables[0]?.name).toBe("accounts");
    expect(loadProject("test-1")?.diagram.tables[0]?.name).toBe("users");
  });

  it("forks an import whose notes differ from the local project", () => {
    const incoming = { ...createProject(stored.diagram), annotations: [{ id: "n", text: "new", x: 0, y: 0, color: "0" }] };
    expect(withoutIdConflict(incoming).diagram.id).not.toBe("test-1");
  });

  it("forks an older shared link instead of overwriting local work", () => {
    const shared = createProject({ ...stored.diagram, tables: [{ ...table, x: 400 }], sourceContent: undefined });
    const opened = resolveSharedProject(shared, false);
    expect(opened.diagram.id).not.toBe("test-1");
    expect(opened.diagram.tables[0]?.x).toBe(400);
    expect(loadProject("test-1")?.diagram.tables[0]?.x).toBe(0);
  });

  it("reopens the local project on reload", () => {
    const shared = createProject({ ...stored.diagram, tables: [{ ...table, x: 400 }], sourceContent: undefined });
    expect(resolveSharedProject(shared, true)).toEqual(loadProject("test-1"));
  });

  it("restores the local source for an identical shared link", () => {
    const shared = createProject({ ...stored.diagram, sourceContent: undefined });
    const opened = resolveSharedProject(shared, false);
    expect(opened.diagram.id).toBe("test-1");
    expect(opened.diagram.sourceContent).toBe(stored.diagram.sourceContent);
  });

  it("opens an unknown shared link as is", () => {
    const shared = createProject({ ...stored.diagram, id: "other" });
    expect(resolveSharedProject(shared, false).diagram.id).toBe("other");
  });
});
