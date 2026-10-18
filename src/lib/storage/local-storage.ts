import { z } from "zod";
import { Diagram as DiagramSchema, encodeState, generateId, type Diagram } from "db-schema-toolkit";
import { createProject, ProjectSchema, type Project } from "@/lib/project/project";

const RECORD_PREFIX = "db-schema-viewer-diagram-";
/** Metadata cache for the recent list. Records stay the source of truth. */
const INDEX_KEY = "db-schema-viewer-diagrams";

const StoredDiagramSchema = z.object({
  id: z.string(),
  name: z.string(),
  databaseType: z.string(),
  tableCount: z.number(),
  updatedAt: z.string(),
});
export type StoredDiagram = z.infer<typeof StoredDiagramSchema>;
const IndexSchema = z.record(z.string(), StoredDiagramSchema);
type Index = z.infer<typeof IndexSchema>;

export interface SaveResult {
  /** The source code did not fit in storage; the rest of the project was saved. */
  sourceDropped: boolean;
}

function toEntry(project: Project): StoredDiagram {
  const d = project.diagram;
  return { id: d.id, name: d.name, databaseType: d.databaseType,
    tableCount: d.tables.length, updatedAt: project.updatedAt ?? d.updatedAt ?? d.createdAt };
}

function readIndex(): Index {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return {};
  try {
    const parsed = IndexSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    // A corrupt cache is rebuilt from the records.
    return {};
  }
}

function writeIndex(index: Index): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Never keep a stale cache: without it, the list is rebuilt from the records.
    localStorage.removeItem(INDEX_KEY);
  }
}

function updateIndex(id: string, entry: StoredDiagram | null): void {
  const index = readIndex();
  if (entry) index[id] = entry;
  else delete index[id];
  writeIndex(index);
}

function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22;
}

/**
 * One atomic record per project. Validation happens on import and load, not on every autosave.
 * When storage is full, the project is saved again without its source code.
 */
export function saveProject(project: Project): SaveResult {
  if (typeof window === "undefined") return { sourceDropped: false };
  const id = project.diagram.id;
  const key = `${RECORD_PREFIX}${id}`;
  let sourceDropped = false;
  try {
    localStorage.setItem(key, JSON.stringify(project));
  } catch (error) {
    if (!isQuotaExceeded(error) || project.diagram.sourceContent === undefined) throw error;
    localStorage.setItem(key, JSON.stringify({ ...project, diagram: { ...project.diagram, sourceContent: undefined } }));
    sourceDropped = true;
  }
  updateIndex(id, toEntry(project));
  return { sourceDropped };
}
export function saveDiagram(diagram: Diagram): void {
  const existing = loadProject(diagram.id);
  saveProject({ ...(existing ?? createProject(diagram)), diagram });
}
export function loadProject(id: string): Project | null {
  if (typeof window === "undefined") return null;
  let stored: string | null;
  try {
    stored = localStorage.getItem(`${RECORD_PREFIX}${id}`);
  } catch {
    return null;
  }
  if (!stored) return null;
  const project = parseRecord(stored);
  if (project?.diagram.id === id) return project;
  // Unreadable record: drop it from the recent list, which never parses records.
  updateIndex(id, null);
  return null;
}
function parseRecord(stored: string): Project | null {
  try {
    const data: unknown = JSON.parse(stored);
    // Legacy records migrate only on a successful save.
    return data && typeof data === "object" && "version" in data
      ? ProjectSchema.parse(data)
      : createProject(DiagramSchema.parse(data));
  } catch {
    return null;
  }
}
export function loadDiagram(id: string): Diagram | null {
  return loadProject(id)?.diagram ?? null;
}
export function deleteDiagram(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(`${RECORD_PREFIX}${id}`);
  updateIndex(id, null);
}
export function listDiagrams(): StoredDiagram[] {
  if (typeof window === "undefined") return [];
  try {
    const index = readIndex();
    const fresh: Index = {};
    let changed = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RECORD_PREFIX)) continue;
      const id = key.slice(RECORD_PREFIX.length);
      const cached = index[id];
      if (cached?.id === id) {
        fresh[id] = cached;
        continue;
      }
      // Records written before the index existed are read once, then cached.
      const project = loadProject(id);
      changed = true;
      if (project) fresh[id] = toEntry(project);
    }
    if (changed || Object.keys(index).length !== Object.keys(fresh).length) writeIndex(fresh);
    return Object.values(fresh).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function sameDiagram(a: Project, b: Project): boolean {
  return encodeState(a.diagram) === encodeState(b.diagram);
}
function sameContent(a: Project, b: Project): boolean {
  return sameDiagram(a, b) && JSON.stringify(a.annotations) === JSON.stringify(b.annotations);
}
function fork(project: Project): Project {
  return { ...project, diagram: { ...project.diagram, id: generateId() } };
}

/** An incoming project never silently overwrites a different local project with the same id. */
export function withoutIdConflict(incoming: Project): Project {
  const stored = loadProject(incoming.diagram.id);
  return stored && !sameContent(stored, incoming) ? fork(incoming) : incoming;
}

/**
 * A reload reopens the local copy of the link; any other visit to a link whose id exists
 * locally with different content opens it under a new id.
 */
export function resolveSharedProject(shared: Project, reload: boolean): Project {
  const stored = loadProject(shared.diagram.id);
  if (!stored) return shared;
  if (reload) return stored;
  // Only restore a source belonging to exactly the same shared schema and layout.
  const withSource = stored.diagram.sourceContent && sameDiagram(stored, shared)
    ? { ...shared, diagram: { ...shared.diagram, sourceContent: stored.diagram.sourceContent } }
    : shared;
  return sameContent(stored, shared) ? withSource : fork(withSource);
}
