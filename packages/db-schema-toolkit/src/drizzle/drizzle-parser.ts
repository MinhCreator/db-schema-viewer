import type { Diagram, DatabaseType } from "../domain";
import type { ParsedColumn, ParsedRelationship } from "../parsing/types";
import { buildDiagram } from "../parsing/build-diagram";
import { extractBraceBlock } from "../parsing/extract-brace-block";
import { inlineHelperFunctions } from "../parsing/inline-helpers";

type DrizzleDialect = "pg" | "mysql" | "sqlite" | "unknown";

interface DrizzleTable {
  variableName: string;
  tableName: string;
  columns: ParsedColumn[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
}

interface ColumnRef {
  sourceTableName: string;
  sourceColumn: string;
  targetVar: string;
  targetColumn: string;
}

/**
 * Parse Drizzle ORM schema.ts content into a Diagram.
 * Beta feature — uses regex-based parsing since we can't run TypeScript in the browser.
 */
export function parseDrizzleSchema(content: string, name?: string): Diagram {
  const tables: DrizzleTable[] = [];
  const relationships: ParsedRelationship[] = [];

  // Detect dialect before stripping imports (imports contain dialect hints)
  const dialect = detectDrizzleDialect(content);
  const databaseType = drizzleDialectToDBType(dialect);

  // Strip imports and TypeScript-only syntax that can interfere with regex parsing
  content = stripTypeScriptImports(content);

  // Inline helper functions (e.g., shared column definitions) so their columns
  // are visible directly in table definitions for regex-based parsing
  content = inlineHelperFunctions(content);

  // Extract enum definitions (for callback-syntax type resolution)
  const enumMap = extractPgEnums(content);

  // Extract tables (returns `.references()` targets that need resolution)
  const columnRefs = extractDrizzleTables(content, tables, enumMap);

  // Resolve column references (variable name → table name)
  for (const ref of columnRefs) {
    const targetTable = tables.find((t) => t.variableName === ref.targetVar);
    const targetTableName = targetTable ? targetTable.tableName : ref.targetVar;
    const sourceTable = tables.find((t) => t.tableName === ref.sourceTableName);
    if (sourceTable) {
      const col = sourceTable.columns.find((c) => c.name === ref.sourceColumn);
      if (col) {
        col.references = { table: targetTableName, column: ref.targetColumn };
      }
    }
    relationships.push({
      sourceTable: ref.sourceTableName,
      sourceColumn: ref.sourceColumn,
      targetTable: targetTableName,
      targetColumn: ref.targetColumn,
    });
  }

  // Extract explicit relations (`relations(...)`)
  extractExplicitRelations(content, tables, relationships);

  // Convert to Diagram via shared builder
  const parsedTables = tables.map((dt) => ({
    name: dt.tableName,
    schema: undefined,
    columns: dt.columns,
    indexes: dt.indexes,
    isView: false,
  }));

  return buildDiagram(parsedTables, relationships, databaseType, name ?? "Drizzle Schema");
}

// ── Import stripping ──────────────────────────────────────────────

/**
 * Remove TypeScript import statements, $type<...>() annotations,
 * and comments that can interfere with regex-based parsing.
 */
function stripTypeScriptImports(content: string): string {
  // Remove single-line and multi-line import statements
  content = content.replace(
    /^\s*import\s[\s\S]*?from\s+["'][^"']*["']\s*;?\s*$/gm,
    "",
  );
  // Remove side-effect imports: import "module";
  content = content.replace(/^\s*import\s+["'][^"']*["']\s*;?\s*$/gm, "");
  // Remove .$type<...>() annotations (reference imported types)
  content = content.replace(/\.\$type\s*<[^>]*>\s*\(\s*\)/g, "");
  // Remove single-line comments (careful: keep string literals intact)
  content = content.replace(/\/\/.*$/gm, "");
  // Remove multi-line comments
  content = content.replace(/\/\*[\s\S]*?\*\//g, "");
  return content;
}

// ── Dialect detection ──────────────────────────────────────────────

function detectDrizzleDialect(content: string): DrizzleDialect {
  if (/from\s+["']drizzle-orm\/pg-core["']/.test(content)) return "pg";
  if (/from\s+["']drizzle-orm\/mysql-core["']/.test(content)) return "mysql";
  if (/from\s+["']drizzle-orm\/sqlite-core["']/.test(content)) return "sqlite";
  if (/\bpgTable\b/.test(content)) return "pg";
  if (/\bmysqlTable\b/.test(content)) return "mysql";
  if (/\bsqliteTable\b/.test(content)) return "sqlite";
  return "unknown";
}

function drizzleDialectToDBType(dialect: DrizzleDialect): DatabaseType {
  switch (dialect) {
    case "pg": return "postgresql";
    case "mysql": return "mysql";
    case "sqlite": return "sqlite";
    default: return "postgresql";
  }
}

// ── Enum extraction ────────────────────────────────────────────────

function extractPgEnums(content: string): Map<string, string> {
  const enums = new Map<string, string>();
  const enumRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*pgEnum\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = enumRegex.exec(content)) !== null) {
    enums.set(match[1]!, match[2]!);
  }
  return enums;
}

// ── Table extraction ───────────────────────────────────────────────

function extractDrizzleTables(
  content: string,
  tables: DrizzleTable[],
  enumMap: Map<string, string>,
): ColumnRef[] {
  const columnRefs: ColumnRef[] = [];

  // Match: export const users = pgTable('users', { ... })
  // Also: const users = mysqlTable("users", { ... })
  // Also: const users = createTable("users", (d) => ({ ... }))  (callback syntax)
  const tableRegex =
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:(\w+)Table|(\w+)\.(?:pgTable|mysqlTable|sqliteTable))\s*\(\s*["'`](\w+)["'`]\s*,\s*(?:\(\s*(\w+)\s*\)\s*=>\s*\(\s*)?\{/g;

  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const variableName = match[1]!;
    const tableName = match[4]!;
    const callbackParam = match[5]; // e.g., 'd' — undefined for old syntax

    // Extract the table body using brace counting
    const startIdx = content.indexOf("{", match.index + match[0].length - 1);
    if (startIdx === -1) continue;

    const body = extractBraceBlock(content, startIdx);
    if (!body) continue;

    const { columns, refs } = callbackParam
      ? parseDrizzleCallbackColumns(body, callbackParam, enumMap)
      : parseDrizzleColumns(body);
    for (const ref of refs) {
      columnRefs.push({ sourceTableName: tableName, ...ref });
    }

    // Extract constraints from the 3rd argument: (t) => [ primaryKey(...), unique(...), index(...) ]
    const bodyEndIdx = startIdx + 1 + body.length; // position of closing }
    const constraintResult = extractTableConstraints(content, bodyEndIdx, columns);

    tables.push({
      variableName,
      tableName,
      columns,
      indexes: constraintResult.indexes,
    });
  }

  return columnRefs;
}

// ── Constraint extraction (3rd argument) ─────────────────────────

/**
 * Extract constraints from the 3rd argument of createTable/pgTable.
 * After the column body `}`, look for `, (t) => [ ... ]` containing
 * primaryKey(), unique().on(), index().on().
 */
function extractTableConstraints(
  content: string,
  bodyEndIdx: number,
  columns: ParsedColumn[],
): { indexes: { name: string; columns: string[]; unique: boolean }[] } {
  const indexes: { name: string; columns: string[]; unique: boolean }[] = [];

  // After column body `}`, there may be `)` then `, (paramName) => [`
  // bodyEndIdx points at the `}` itself, skip past it
  const afterBody = content.substring(bodyEndIdx + 1);
  const constraintStart = afterBody.match(
    /^\s*\)?\s*,\s*\(\s*\w+\s*\)\s*=>\s*\[/,
  );
  if (!constraintStart) return { indexes };

  // Find the bracket block [...] containing constraints
  const bracketPos = bodyEndIdx + constraintStart.index! + constraintStart[0].length - 1;
  let depth = 0;
  let blockEnd = -1;
  for (let i = bracketPos; i < content.length; i++) {
    if (content[i] === "[") depth++;
    else if (content[i] === "]") {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }
  if (blockEnd === -1) return { indexes };

  const constraintBlock = content.substring(bracketPos + 1, blockEnd);

  // Parse primaryKey({ columns: [t.col1, t.col2] })
  const pkMatch = /primaryKey\s*\(\s*\{[^}]*columns\s*:\s*\[([^\]]*)\]/.exec(
    constraintBlock,
  );
  if (pkMatch) {
    const colRefs = [...pkMatch[1]!.matchAll(/\.(\w+)/g)].map((m) => m[1]!);
    for (const colName of colRefs) {
      const col = columns.find((c) => c.name === colName);
      if (col) col.primaryKey = true;
    }
  }

  // Parse unique("name").on(t.col1, t.col2)
  const uniqueRegex =
    /unique\s*\(\s*["'`]([^"'`]*)["'`]\s*\)\s*\.on\s*\(([^)]*)\)/g;
  let uniqueMatch;
  while ((uniqueMatch = uniqueRegex.exec(constraintBlock)) !== null) {
    const idxName = uniqueMatch[1]!;
    const colRefs = [...uniqueMatch[2]!.matchAll(/\.(\w+)/g)].map(
      (m) => m[1]!,
    );
    if (colRefs.length === 1) {
      // Single-column unique: mark the column directly
      const col = columns.find((c) => c.name === colRefs[0]);
      if (col) col.unique = true;
    }
    indexes.push({ name: idxName, columns: colRefs, unique: true });
  }

  // Parse index("name").on(t.col1, t.col2)
  const indexRegex =
    /index\s*\(\s*["'`]([^"'`]*)["'`]\s*\)\s*\.on\s*\(([^)]*)\)/g;
  let indexMatch;
  while ((indexMatch = indexRegex.exec(constraintBlock)) !== null) {
    const idxName = indexMatch[1]!;
    const colRefs = [...indexMatch[2]!.matchAll(/\.(\w+)/g)].map(
      (m) => m[1]!,
    );
    indexes.push({ name: idxName, columns: colRefs, unique: false });
  }

  return { indexes };
}

// ── Modifier chains ───────────────────────────────────────────────

interface ChainCall {
  name: string;
  args: string;
}

type ColumnTarget = Omit<ColumnRef, "sourceTableName">;

const SKIPPED_TYPE_FNS = ["primaryKey", "foreignKey", "uniqueIndex", "index", "unique"];

/** Index just past the string literal opening at `start`, or -1 if unterminated. */
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === quote) return i + 1;
  }
  return -1;
}

/** Index of the `)` matching the `(` at `openIdx`, ignoring string contents; -1 if unbalanced. */
function findClosingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipStringLiteral(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Read the `.name(args)` calls chained from `startIdx`, with balanced parentheses. */
function parseCallChain(text: string, startIdx: number): { calls: ChainCall[]; end: number } {
  const calls: ChainCall[] = [];
  const callRegex = /\s*\.\s*([\w$]+)\s*\(/y;
  let pos = startIdx;
  for (;;) {
    callRegex.lastIndex = pos;
    const match = callRegex.exec(text);
    if (!match) break;
    const openIdx = pos + match[0].length - 1;
    const closeIdx = findClosingParen(text, openIdx);
    if (closeIdx === -1) break;
    calls.push({ name: match[1]!, args: text.substring(openIdx + 1, closeIdx) });
    pos = closeIdx + 1;
  }
  return { calls, end: pos };
}

/**
 * Build a column from its type function and the calls chained after it.
 * `typeOpenIdx` points at the `(` of the type call inside `text`.
 */
function buildColumn(
  fieldName: string,
  typeFn: string,
  text: string,
  typeOpenIdx: number,
): { column: ParsedColumn; ref?: ColumnTarget; end: number } | null {
  const typeCloseIdx = findClosingParen(text, typeOpenIdx);
  if (typeCloseIdx === -1) return null;
  const { calls, end } = parseCallChain(text, typeCloseIdx + 1);
  const has = (name: string) => calls.some((c) => c.name === name);

  const isPK = has("primaryKey") || typeFn === "serial" || typeFn === "bigserial";

  let defaultValue: string | undefined;
  const defaultArgs = calls.find((c) => c.name === "default")?.args.trim();
  if (defaultArgs !== undefined) {
    const stringMatch = /^["'`]([^"'`]*)["'`]$/.exec(defaultArgs);
    const numberMatch = /^-?\d+(?:\.\d+)?$/.exec(defaultArgs);
    defaultValue = stringMatch ? stringMatch[1] : numberMatch?.[0];
  }

  const column: ParsedColumn = {
    name: fieldName,
    type: mapDrizzleType(typeFn),
    primaryKey: isPK,
    unique: has("unique"),
    nullable: !has("notNull") && !isPK,
    default: defaultValue,
  };

  // .references(() => table.column) or .references(() => table.column, { onDelete: ... })
  const refArgs = calls.find((c) => c.name === "references")?.args;
  const refMatch = refArgs
    ? /^\s*\(\s*\)\s*=>\s*(\w+)\.(\w+)\s*(?:,|$)/.exec(refArgs)
    : null;
  const ref = refMatch
    ? { sourceColumn: fieldName, targetVar: refMatch[1]!, targetColumn: refMatch[2]! }
    : undefined;

  return { column, ref, end };
}

// ── Column parsing (object syntax) ────────────────────────────────

function parseDrizzleColumns(body: string): {
  columns: ParsedColumn[];
  refs: ColumnTarget[];
} {
  const columns: ParsedColumn[] = [];
  const refs: ColumnTarget[] = [];

  const colStartRegex = /(\w+)\s*:\s*(\w+)\s*\(/g;

  let match;
  while ((match = colStartRegex.exec(body)) !== null) {
    const fieldName = match[1]!;
    const typeFn = match[2]!;
    const typeOpenIdx = match.index + match[0].length - 1;

    const built = buildColumn(fieldName, typeFn, body, typeOpenIdx);
    if (!built) continue;
    colStartRegex.lastIndex = built.end;

    if (SKIPPED_TYPE_FNS.includes(typeFn)) continue;

    columns.push(built.column);
    if (built.ref) refs.push(built.ref);
  }

  return { columns, refs };
}

// ── Column parsing (callback syntax) ──────────────────────────────

function splitAtTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.substring(start, i));
      start = i + 1;
    }
  }

  if (start < body.length) {
    parts.push(body.substring(start));
  }

  return parts;
}

function parseDrizzleCallbackColumns(
  body: string,
  paramName: string,
  enumMap: Map<string, string>,
): {
  columns: ParsedColumn[];
  refs: ColumnTarget[];
} {
  const columns: ParsedColumn[] = [];
  const refs: ColumnTarget[] = [];

  const fields = splitAtTopLevelCommas(body);

  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed) continue;

    const nameMatch = /^(\w+)\s*:/.exec(trimmed);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1]!;

    // Try callback syntax: fieldName: d.typeFn(...)
    const callbackTypeRegex = new RegExp(
      `:\\s*${paramName}\\s*\\.\\s*(\\w+)\\s*\\(`,
    );
    const callbackMatch = callbackTypeRegex.exec(trimmed);
    // Otherwise a standalone function (e.g., pgEnum): fieldName: enumFn(...)
    const typeMatch = callbackMatch ?? /:\s*(\w+)\s*\(/.exec(trimmed);
    if (!typeMatch) continue;

    let typeFn = typeMatch[1]!;
    if (!callbackMatch) {
      const enumName = enumMap.get(typeFn);
      if (enumName) {
        typeFn = enumName;
      }
    }

    if (SKIPPED_TYPE_FNS.includes(typeFn)) {
      continue;
    }

    const typeOpenIdx = typeMatch.index + typeMatch[0].length - 1;
    const built = buildColumn(fieldName, typeFn, trimmed, typeOpenIdx);
    if (!built) continue;

    columns.push(built.column);
    if (built.ref) refs.push(built.ref);
  }

  return { columns, refs };
}

// ── Explicit relations() blocks ───────────────────────────────────

function extractExplicitRelations(
  content: string,
  tables: DrizzleTable[],
  relationships: ParsedRelationship[],
): void {
  const relBlockRegex =
    /relations\s*\(\s*(\w+)\s*,\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\(\s*\{([\s\S]*?)\}\s*\)\s*,?\s*\)/g;

  let blockMatch;
  while ((blockMatch = relBlockRegex.exec(content)) !== null) {
    const body = blockMatch[2]!;

    const entryRegex =
      /\w+\s*:\s*(?:one|many)\s*\(\s*(\w+)\s*,\s*\{[^}]*fields\s*:\s*\[\s*(\w+)\.(\w+)\s*\][^}]*references\s*:\s*\[\s*(\w+)\.(\w+)\s*\]/g;

    let entryMatch;
    while ((entryMatch = entryRegex.exec(body)) !== null) {
      const fieldsTableVar = entryMatch[2]!;
      const fieldsCol = entryMatch[3]!;
      const refsTableVar = entryMatch[4]!;
      const refsCol = entryMatch[5]!;

      const fieldsTable = tables.find((t) => t.variableName === fieldsTableVar);
      const refsTable = tables.find((t) => t.variableName === refsTableVar);

      const fieldsTableName = fieldsTable ? fieldsTable.tableName : fieldsTableVar;
      const refsTableName = refsTable ? refsTable.tableName : refsTableVar;

      const exists = relationships.some(
        (r) =>
          r.sourceTable === fieldsTableName &&
          r.sourceColumn === fieldsCol &&
          r.targetTable === refsTableName &&
          r.targetColumn === refsCol,
      );

      if (!exists) {
        relationships.push({
          sourceTable: fieldsTableName,
          sourceColumn: fieldsCol,
          targetTable: refsTableName,
          targetColumn: refsCol,
          isOrmOnly: true,
        });
      }
    }
  }
}

// ── Type mapping ──────────────────────────────────────────────────

function mapDrizzleType(fn: string): string {
  const map: Record<string, string> = {
    serial: "SERIAL",
    bigserial: "BIGSERIAL",
    integer: "INTEGER",
    int: "INT",
    smallint: "SMALLINT",
    bigint: "BIGINT",
    boolean: "BOOLEAN",
    text: "TEXT",
    varchar: "VARCHAR",
    char: "CHAR",
    uuid: "UUID",
    timestamp: "TIMESTAMP",
    date: "DATE",
    time: "TIME",
    json: "JSON",
    jsonb: "JSONB",
    real: "REAL",
    doublePrecision: "DOUBLE PRECISION",
    numeric: "NUMERIC",
    decimal: "DECIMAL",
    blob: "BLOB",
    mysqlEnum: "ENUM",
    tinyint: "TINYINT",
    mediumint: "MEDIUMINT",
    float: "FLOAT",
    double: "DOUBLE",
    sqliteInteger: "INTEGER",
    sqliteText: "TEXT",
    sqliteReal: "REAL",
    sqliteBlob: "BLOB",
  };
  return map[fn] || fn.toUpperCase();
}
