import type { DatabaseType } from "../../domain";
import type { ParseResult, ParsedTable, ParsedColumn, ParsedRelationship } from "../../parsing/types";

// One identifier: quoted ("x", `x`, [x]) or bare. Quoted forms may hold dashes and dots.
const IDENT = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|'[^']+'|\w+)`;
// Dotted, optionally quoted, qualified name such as `my-project.ds.t` or warehouse.public.events.
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

export function parseWithRegex(sql: string, _dbType: DatabaseType): ParseResult {
  const tables: ParsedTable[] = [];
  const relationships: ParsedRelationship[] = [];

  // Match CREATE TABLE headers; the body is read with a balanced-parenthesis scan
  const createTableRegex = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|TRANSIENT|EXTERNAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})\s*\(`,
    "gi",
  );

  let match;
  while ((match = createTableRegex.exec(sql)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findClosingParen(sql, openIndex);
    if (closeIndex === -1) continue;

    const { name: tableName, schema } = splitQualifiedName(match[1]!);
    const body = sql.slice(openIndex + 1, closeIndex);
    createTableRegex.lastIndex = closeIndex + 1;

    const columns = parseColumns(body);
    const tableRels = parseInlineFK(body, tableName);
    relationships.push(...tableRels);

    tables.push({
      name: tableName,
      schema,
      columns,
      indexes: [],
      isView: false,
    });
  }

  // Match CREATE VIEW
  const createViewRegex = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:SECURE|RECURSIVE)\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
    "gi",
  );

  while ((match = createViewRegex.exec(sql)) !== null) {
    const { name, schema } = splitQualifiedName(match[1]!);
    tables.push({
      name,
      schema,
      columns: [],
      indexes: [],
      isView: true,
    });
  }

  // ALTER TABLE FK
  const alterFKRegex = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+ADD\s+(?:CONSTRAINT\s+${IDENT}\s+)?FOREIGN\s+KEY\s*\(\s*(${IDENT})\s*\)\s*REFERENCES\s+(${QUALIFIED})\s*\(\s*(${IDENT})\s*\)`,
    "gi",
  );

  while ((match = alterFKRegex.exec(sql)) !== null) {
    relationships.push({
      sourceTable: splitQualifiedName(match[1]!).name,
      sourceColumn: unquote(match[2]!),
      targetTable: splitQualifiedName(match[3]!).name,
      targetColumn: unquote(match[4]!),
    });
  }

  return { tables, relationships };
}

function unquote(ident: string): string {
  const first = ident[0];
  if (first === '"' || first === "`" || first === "'" || first === "[") {
    return ident.slice(1, -1);
  }
  return ident;
}

/**
 * Split a qualified name into its parts. A single backticked name may hold the
 * whole path (BigQuery `my-project.dataset.table`), so backticked parts are split on dots.
 */
function splitQualifiedName(raw: string): { name: string; schema?: string } {
  const parts: string[] = [];
  const partRegex = new RegExp(IDENT, "g");
  let part;
  while ((part = partRegex.exec(raw)) !== null) {
    const token = part[0];
    if (token.startsWith("`")) {
      parts.push(...unquote(token).split(".").filter(Boolean));
    } else {
      parts.push(unquote(token));
    }
  }
  const name = parts[parts.length - 1] ?? raw;
  // Keep the first qualifier part as schema (e.g. "mydb." or "warehouse.public.")
  const schema = parts.length > 1 ? parts[0] : undefined;
  return { name, schema };
}

/** Skip a quoted section starting at `index`; returns the index just past it. */
function skipQuoted(text: string, index: number): number {
  const quote = text[index]!;
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === "\\" && quote === "'") {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

function isQuote(char: string | undefined): boolean {
  return char === "'" || char === '"' || char === "`";
}

/** Index of the `)` matching the `(` at `openIndex`, or -1 when unbalanced. */
function findClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const char = text[i];
    if (isQuote(char)) {
      i = skipQuoted(text, i);
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const GENERIC_TYPE = /\b(?:STRUCT|ARRAY|MAP|RANGE)\s*$/i;

/** Split on commas outside parentheses, `STRUCT<…>` / `ARRAY<…>` and quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let parenDepth = 0;
  let angleDepth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    if (isQuote(char)) {
      i = skipQuoted(body, i);
      continue;
    }
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "<" && (angleDepth > 0 || GENERIC_TYPE.test(body.slice(start, i)))) angleDepth++;
    else if (char === ">" && angleDepth > 0) angleDepth--;
    else if (char === "," && parenDepth === 0 && angleDepth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const last = body.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** Read a type name followed by optional `<…>` and `(…)` sections. */
function readType(text: string): string {
  const head = text.match(/^\w+/);
  if (!head) return "";
  let end = head[0].length;
  for (const [open, close] of [["<", ">"], ["(", ")"]] as const) {
    const gap = text.slice(end).match(/^\s*/)![0].length;
    if (text[end + gap] !== open) continue;
    let depth = 0;
    for (let i = end + gap; i < text.length; i++) {
      if (text[i] === open) depth++;
      if (text[i] === close && --depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return text.slice(0, end).trim();
}

const COLUMN_HEAD = new RegExp(String.raw`^(${IDENT})\s+`);
const INLINE_REFERENCES = new RegExp(
  String.raw`\bREFERENCES\s+(${QUALIFIED})\s*\(\s*(${IDENT})\s*\)`,
  "i",
);

function parseColumns(body: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];

  for (const part of splitTopLevel(body)) {
    // Skip constraints
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT|INDEX|KEY)\b/i.test(part)) {
      continue;
    }

    const head = part.match(COLUMN_HEAD);
    if (!head) continue;
    const type = readType(part.slice(head[0].length));
    if (!type) continue;
    // Inspect modifiers after the type only, so STRUCT<… NOT NULL> fields don't leak out
    const modifiers = part.slice(head[0].length + type.length);

    const column: ParsedColumn = {
      name: unquote(head[1]!),
      type,
      primaryKey: /PRIMARY\s+KEY/i.test(modifiers),
      unique: /\bUNIQUE\b/i.test(modifiers),
      nullable: !/NOT\s+NULL/i.test(modifiers),
    };

    const ref = modifiers.match(INLINE_REFERENCES);
    if (ref) {
      column.references = {
        table: splitQualifiedName(ref[1]!).name,
        column: unquote(ref[2]!),
      };
    }

    columns.push(column);
  }

  return columns;
}

function parseInlineFK(body: string, tableName: string): ParsedRelationship[] {
  const relationships: ParsedRelationship[] = [];
  const fkRegex = new RegExp(
    String.raw`FOREIGN\s+KEY\s*\(\s*(${IDENT})\s*\)\s*REFERENCES\s+(${QUALIFIED})\s*\(\s*(${IDENT})\s*\)`,
    "gi",
  );

  let match;
  while ((match = fkRegex.exec(body)) !== null) {
    relationships.push({
      sourceTable: tableName,
      sourceColumn: unquote(match[1]!),
      targetTable: splitQualifiedName(match[2]!).name,
      targetColumn: unquote(match[3]!),
    });
  }

  return relationships;
}
