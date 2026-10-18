import type { Diagram, Cardinality } from "../domain";
import type { ParsedColumn, ParsedRelationship } from "../parsing/types";
import { buildDiagram } from "../parsing/build-diagram";
import { extractBraceBlock } from "../parsing/extract-brace-block";

interface DBMLColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  unique: boolean;
  nullable: boolean;
  increment: boolean;
  default?: string;
  note?: string;
  ref?: InlineRef;
}

interface InlineRef {
  type: ">" | "<" | "-" | "<>";
  schema?: string;
  table: string;
  column: string;
}

interface DBMLTable {
  name: string;
  alias?: string;
  schema?: string;
  columns: DBMLColumn[];
}

interface DBMLRef {
  sourceSchema?: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema?: string;
  targetTable: string;
  targetColumn: string;
  type: ">" | "<" | "-" | "<>";
}

/** `[schema.]table.column` endpoint of a ref. */
interface RefEndpoint {
  schema?: string;
  table: string;
  column: string;
}

type TableResolver = (name: string, schema?: string) => string;

/** Ref operator: captures `>`, `<`, `-` or `<>`. */
const REF_OP = String.raw`([><\-]|<>)`;
/** `[schema.]table.column`: captures schema (optional), table, column. */
const REF_ENDPOINT = String.raw`(?:(\w+)\.)?(\w+)\.(\w+)`;

/**
 * Parse a DBML (Database Markup Language) schema into a Diagram.
 * Uses regex-based parsing.
 */
export function parseDBMLSchema(content: string, name?: string): Diagram {
  const cleaned = stripComments(content);

  const tables = extractTables(cleaned);
  const standaloneRefs = extractStandaloneRefs(cleaned);

  // Build alias → real name lookup
  const aliasMap = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const t of tables) {
    if (t.alias) aliasMap.set(t.alias.toLowerCase(), t.name);
    const key = t.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  // Refs may be schema-qualified. Keep the schema only when the bare table
  // name is declared in several schemas; otherwise the bare name resolves.
  const resolveTable: TableResolver = (ref, schema) => {
    if (!schema) return aliasMap.get(ref.toLowerCase()) || ref;
    return (nameCounts.get(ref.toLowerCase()) ?? 0) > 1 ? `${schema}.${ref}` : ref;
  };

  // Convert to shared types
  const parsedTables = tables.map((dt) => ({
    name: dt.name,
    schema: dt.schema,
    columns: dbmlColumnsToShared(dt.columns, resolveTable),
    indexes: [] as { name: string; columns: string[]; unique: boolean }[],
    isView: false,
  }));

  // Merge all refs: inline + standalone, normalize direction, deduplicate
  const allRefs = collectAllRefs(tables, standaloneRefs);
  const relationships = deduplicateRefs(allRefs, resolveTable);

  return buildDiagram(parsedTables, relationships, "generic", name ?? "DBML Schema");
}

// ── Comment stripping ──────────────────────────────────────────────

/**
 * Remove line and block comments outside of string literals (single, double,
 * backtick and triple-quoted). Newlines inside block comments are kept so
 * line-based column parsing is unaffected.
 */
function stripComments(content: string): string {
  let result = "";
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = content.startsWith("'''", i) ? "'''" : ch;
      let end = i + quote.length;
      while (end < content.length && !content.startsWith(quote, end)) {
        end += content[end] === "\\" ? 2 : 1;
      }
      end = Math.min(content.length, end + quote.length);
      result += content.slice(i, end);
      i = end;
      continue;
    }

    if (content.startsWith("//", i)) {
      const newline = content.indexOf("\n", i);
      i = newline === -1 ? content.length : newline;
      continue;
    }

    if (content.startsWith("/*", i)) {
      const close = content.indexOf("*/", i + 2);
      const end = close === -1 ? content.length : close + 2;
      result += content.slice(i, end).replace(/[^\n]/g, "");
      i = end;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ── Table extraction ───────────────────────────────────────────────

function extractTables(content: string): DBMLTable[] {
  const tables: DBMLTable[] = [];

  const tableRegex =
    /Table\s+((?:(\w+)\.)?(\w+))(?:\s+as\s+(\w+))?(?:\s*\[[^\]]*\])?\s*\{/gi;

  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const schema = match[2] || undefined;
    const tableName = match[3]!;
    const alias = match[4] || undefined;

    const startIdx = content.indexOf("{", match.index + match[0].length - 1);
    if (startIdx === -1) continue;

    const body = extractBraceBlock(content, startIdx);
    if (!body) continue;

    tables.push({
      name: tableName,
      alias,
      schema,
      columns: parseDBMLColumns(body),
    });
  }

  return tables;
}

// ── Column parsing ─────────────────────────────────────────────────

function parseDBMLColumns(body: string): DBMLColumn[] {
  const columns: DBMLColumn[] = [];
  const lines = body.split("\n");

  let inIndexesBlock = false;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^indexes\s*\{/i.test(line)) {
      inIndexesBlock = true;
      braceDepth = 1;
      continue;
    }

    if (inIndexesBlock) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0) inIndexesBlock = false;
      continue;
    }

    if (/^Note\s*[:{]/i.test(line)) continue;

    const colMatch = line.match(
      /^(\w+)\s+([\w().,\s]+?)(?:\s*\[([^\]]*)\])?\s*$/,
    );
    if (!colMatch) continue;

    const attrs = parseAttributes(colMatch[3] || "");

    columns.push({
      name: colMatch[1]!,
      type: colMatch[2]!.trim().toUpperCase(),
      primaryKey: attrs.pk,
      unique: attrs.unique,
      nullable: attrs.nullable,
      increment: attrs.increment,
      default: attrs.default,
      note: attrs.note,
      ref: attrs.ref,
    });
  }

  return columns;
}

interface ParsedAttributes {
  pk: boolean;
  increment: boolean;
  unique: boolean;
  nullable: boolean;
  notNull: boolean;
  default?: string;
  note?: string;
  ref?: InlineRef;
}

function parseAttributes(attrsStr: string): ParsedAttributes {
  const result: ParsedAttributes = {
    pk: false,
    increment: false,
    unique: false,
    nullable: false,
    notNull: false,
  };

  if (!attrsStr.trim()) {
    result.nullable = true;
    return result;
  }

  if (/\bpk\b/i.test(attrsStr) || /\bprimary\s+key\b/i.test(attrsStr))
    result.pk = true;
  if (/\bincrement\b/i.test(attrsStr)) result.increment = true;
  if (/\bunique\b/i.test(attrsStr)) result.unique = true;
  if (/\bnot\s+null\b/i.test(attrsStr)) result.notNull = true;
  if (
    /(?<!\bnot\s)\bnull\b/i.test(attrsStr) &&
    !/\bnot\s+null\b/i.test(attrsStr)
  )
    result.nullable = true;

  if (!result.notNull && !result.nullable) result.nullable = !result.pk;
  if (result.notNull) result.nullable = false;

  const defaultMatch = attrsStr.match(
    /\bdefault\s*:\s*(`[^`]*`|'[^']*'|"[^"]*"|\S+)/i,
  );
  if (defaultMatch) {
    let val = defaultMatch[1]!;
    if (
      (val.startsWith("`") && val.endsWith("`")) ||
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1);
    }
    result.default = val;
  }

  const noteMatch = attrsStr.match(/\bnote\s*:\s*'([^']*)'/i);
  if (noteMatch) result.note = noteMatch[1];

  const refMatch = attrsStr.match(
    new RegExp(String.raw`\bref\s*:\s*${REF_OP}\s*${REF_ENDPOINT}`, "i"),
  );
  if (refMatch) {
    result.ref = {
      type: refMatch[1] as InlineRef["type"],
      schema: refMatch[2] || undefined,
      table: refMatch[3]!,
      column: refMatch[4]!,
    };
  }

  return result;
}

// ── Standalone Ref extraction ──────────────────────────────────────

function extractStandaloneRefs(content: string): DBMLRef[] {
  const refs: DBMLRef[] = [];

  const refPair = String.raw`${REF_ENDPOINT}\s*${REF_OP}\s*${REF_ENDPOINT}`;
  const toRef = (m: RegExpExecArray): DBMLRef =>
    normalizeRef(
      { schema: m[1] || undefined, table: m[2]!, column: m[3]! },
      m[4] as DBMLRef["type"],
      { schema: m[5] || undefined, table: m[6]!, column: m[7]! },
    );

  // Ref: / Ref name:
  const refLineRegex = new RegExp(
    String.raw`Ref(?:\s+\w+)?\s*:\s*${refPair}`,
    "gi",
  );

  let match;
  while ((match = refLineRegex.exec(content)) !== null) {
    refs.push(toRef(match));
  }

  // Ref blocks: Ref name { ... }
  const refBlockRegex = /Ref(?:\s+\w+)?\s*\{([^}]*)\}/gi;
  let blockMatch;
  while ((blockMatch = refBlockRegex.exec(content)) !== null) {
    const body = blockMatch[1]!;
    const innerRefRegex = new RegExp(refPair, "g");
    let innerMatch;
    while ((innerMatch = innerRefRegex.exec(body)) !== null) {
      refs.push(toRef(innerMatch));
    }
  }

  return refs;
}

/** Normalize a ref so source is always the FK side. */
function normalizeRef(
  left: RefEndpoint,
  type: DBMLRef["type"],
  right: RefEndpoint,
): DBMLRef {
  // `<` means the right side is the FK side
  const [source, target] = type === "<" ? [right, left] : [left, right];
  return {
    sourceSchema: source.schema,
    sourceTable: source.table,
    sourceColumn: source.column,
    targetSchema: target.schema,
    targetTable: target.table,
    targetColumn: target.column,
    type,
  };
}

// ── Ref merging / deduplication ────────────────────────────────────

function dbmlColumnsToShared(
  columns: DBMLColumn[],
  resolveTable: TableResolver,
): ParsedColumn[] {
  return columns.map((col) => ({
    name: col.name,
    type: col.type,
    primaryKey: col.primaryKey,
    unique: col.unique,
    nullable: col.nullable,
    default: col.default,
    comment: col.note,
    // Inline refs are handled via collectAllRefs, not on ParsedColumn
    references: col.ref
      ? {
          table: resolveTable(col.ref.table, col.ref.schema),
          column: col.ref.column,
        }
      : undefined,
  }));
}

function collectAllRefs(tables: DBMLTable[], standaloneRefs: DBMLRef[]): DBMLRef[] {
  const allRefs: DBMLRef[] = [...standaloneRefs];

  for (const dt of tables) {
    for (const col of dt.columns) {
      if (!col.ref) continue;

      allRefs.push(
        normalizeRef(
          { schema: dt.schema, table: dt.name, column: col.name },
          col.ref.type,
          {
            schema: col.ref.schema,
            table: col.ref.table,
            column: col.ref.column,
          },
        ),
      );
    }
  }

  return allRefs;
}

function refTypeToCardinality(type: DBMLRef["type"]): Cardinality {
  switch (type) {
    case ">":
    case "<":
      return "one-to-many";
    case "-":
      return "one-to-one";
    case "<>":
      return "many-to-many";
  }
}

function deduplicateRefs(
  allRefs: DBMLRef[],
  resolveTable: TableResolver,
): ParsedRelationship[] {
  const relationships: ParsedRelationship[] = [];
  const seen = new Set<string>();

  for (const ref of allRefs) {
    const src = resolveTable(ref.sourceTable, ref.sourceSchema);
    const tgt = resolveTable(ref.targetTable, ref.targetSchema);
    const key = `${src.toLowerCase()}.${ref.sourceColumn.toLowerCase()}-${tgt.toLowerCase()}.${ref.targetColumn.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    relationships.push({
      sourceTable: src,
      sourceColumn: ref.sourceColumn,
      targetTable: tgt,
      targetColumn: ref.targetColumn,
      cardinality: refTypeToCardinality(ref.type),
    });
  }

  return relationships;
}
