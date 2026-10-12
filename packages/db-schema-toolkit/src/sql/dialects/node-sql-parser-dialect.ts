import { stripSQLComments } from "../../parsing/strip-sql-comments";
import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;
const exprParser = new Parser();
import type { DatabaseType } from "../../domain";
import type { ParseResult, ParsedTable, ParsedColumn, ParsedIndex, ParsedRelationship } from "../../parsing/types";


/** Statements node-sql-parser can't handle and that carry no table structure. */
const SKIPPED_STATEMENT =
  /^(?:SET|PRAGMA|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+SEQUENCE|COMMENT\s+ON)\b/i;

/** Supabase dumps also carry function calls and privileges. */
const SKIPPED_SUPABASE_STATEMENT = /^(?:SELECT|GRANT|REVOKE)\b/i;

const DOLLAR_QUOTE = /^(?:\$\$|\$[A-Za-z_]\w*\$)/;

/**
 * Split SQL on `;` while ignoring semicolons inside quoted strings,
 * quoted identifiers and PostgreSQL dollar-quoted bodies.
 */
function splitSQLStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"' || char === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && char === "'") { i += 2; continue; }
        if (sql[i] === char) {
          if (sql[i + 1] === char) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
    } else if (char === "$" && !/\w/.test(sql[i - 1] ?? "") && DOLLAR_QUOTE.test(sql.slice(i))) {
      const delimiter = sql.slice(i).match(DOLLAR_QUOTE)![0];
      const end = sql.indexOf(delimiter, i + delimiter.length);
      i = end === -1 ? sql.length : end + delimiter.length;
    } else if (char === ";") {
      statements.push(sql.slice(start, i));
      i++;
      start = i;
    } else i++;
  }
  statements.push(sql.slice(start));
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

function preprocessStatement(stmt: string, dbType: DatabaseType): string | null {
  if (SKIPPED_STATEMENT.test(stmt)) return null;
  if (dbType === "supabase" && SKIPPED_SUPABASE_STATEMENT.test(stmt)) return null;

  let processed = stmt;

  // ClickHouse preprocessing
  if (dbType === "clickhouse") {
    // Convert ClickHouse ENGINE = ... to be more MySQL-compatible
    processed = processed.replace(/\bENGINE\s*=\s*\w+\([^)]*\)/gi, "");
    processed = processed.replace(/\bENGINE\s*=\s*\w+/gi, "");
    processed = processed.replace(/\bORDER\s+BY\s+\([^)]+\)/gi, "");
    processed = processed.replace(/\bORDER\s+BY\s+\w+/gi, "");
    processed = processed.replace(/\bPARTITION\s+BY\s+[^;]+?(?=\)|$)/gim, "");
    processed = processed.replace(/\bSETTINGS\s+[^;]+/gi, "");
    // Convert ClickHouse types to MySQL-compatible types
    processed = processed.replace(/\bUInt(?:8|16|32|64|128|256)\b/g, "INT");
    processed = processed.replace(/\bInt(?:8|16|32|64|128|256)\b/g, "INT");
    processed = processed.replace(/\bFloat(32|64)\b/g, "FLOAT");
    processed = processed.replace(/\bFixedString\(\d+\)/g, "VARCHAR(255)");
    processed = processed.replace(/\bLowCardinality\((\w+)\)/g, "$1");
    processed = processed.replace(/\bNullable\((\w+)\)/g, "$1");
  }

  // CockroachDB - remove INTERLEAVE
  if (dbType === "cockroachdb") {
    processed = processed.replace(/\bINTERLEAVE\s+IN\s+PARENT\s+\w+\s*\([^)]*\)/gi, "");
  }

  processed = processed.trim();
  return processed.length > 0 ? processed : null;
}

function preprocessSQL(sql: string, dbType: DatabaseType): string[] {
  const statements: string[] = [];
  for (const stmt of splitSQLStatements(stripSQLComments(sql))) {
    const processed = preprocessStatement(stmt, dbType);
    if (processed !== null) statements.push(processed);
  }
  return statements;
}

function extractTableName(tableObj: any): string {
  if (typeof tableObj === "string") return tableObj;
  if (tableObj?.table) return tableObj.table;
  return String(tableObj);
}

function extractSchema(tableObj: any): string | undefined {
  if (tableObj?.schema || tableObj?.db) {
    return tableObj.schema ?? tableObj.db;
  }
  return undefined;
}

/** `schema.table` when the reference names a schema, so the FK can target it explicitly. */
function extractReferencedTable(tableObj: any): string {
  const table = extractTableName(tableObj);
  const schema = extractSchema(tableObj);
  return schema ? `${schema}.${table}` : table;
}

function extractColumnName(colDef: any): string {
  // Handle nested column ref: column.column.expr.value or column.column
  const col = colDef?.column;
  if (typeof col === "string") return col;
  if (col?.column?.expr?.value) return col.column.expr.value;
  if (col?.column) return typeof col.column === "string" ? col.column : String(col.column);
  if (col?.expr?.value) return col.expr.value;
  return "unknown";
}

function extractType(colDef: any): string {
  if (!colDef?.definition?.dataType) return "unknown";
  let type = colDef.definition.dataType;
  // node-sql-parser stores DECIMAL(p,s) as { length: p, scale: s }
  const size = colDef.definition.length ?? colDef.definition.precision;
  if (size) {
    const scale = colDef.definition.scale;
    type += typeof scale === "number" ? `(${size},${scale})` : `(${size})`;
  }
  // suffix is often an array in pg dialect
  if (colDef.definition.suffix && typeof colDef.definition.suffix === "string") {
    type += ` ${colDef.definition.suffix}`;
  }
  return type;
}

function isNullable(colDef: any): boolean {
  if (!colDef?.nullable) return true;
  return colDef.nullable.value !== "not null";
}

function isPrimaryKey(colDef: any): boolean {
  return (
    colDef?.primary_key === true ||
    colDef?.primary_key === "primary key" ||
    (typeof colDef?.definition?.suffix === "string" &&
      colDef.definition.suffix.toLowerCase().includes("primary key")) ||
    false
  );
}

function isUnique(colDef: any): boolean {
  return colDef?.unique === true || colDef?.unique_or_primary === "unique" || false;
}

function getDefault(colDef: any, dialect: string): string | undefined {
  if (!colDef?.default_val) return undefined;
  const val = colDef.default_val;
  if (typeof val.value === "string") return val.value;
  const literal = val.value?.value;
  if (literal !== undefined && (literal === null || typeof literal !== "object")) {
    return String(literal);
  }
  // Expressions such as now(), CURRENT_TIMESTAMP or casts: render them back to SQL
  if (val.value && typeof val.value === "object") {
    return exprParser.exprToSQL(val.value, { database: dialect });
  }
  return undefined;
}

function extractRefColumnName(refCol: any): string | undefined {
  if (typeof refCol === "string") return refCol;
  if (refCol?.column?.expr?.value) return refCol.column.expr.value;
  if (refCol?.column && typeof refCol.column === "string") return refCol.column;
  if (refCol?.expr?.value) return refCol.expr.value;
  return undefined;
}

function extractInlineFK(colDef: any): { table: string; column: string } | undefined {
  if (colDef?.reference_definition) {
    const ref = colDef.reference_definition;
    const table = extractReferencedTable(ref.table?.[0]);
    const column = extractRefColumnName(ref.definition?.[0]) ?? extractRefColumnName(ref.columns?.[0]);
    if (table && column) {
      return { table, column };
    }
  }
  return undefined;
}

export function parseWithNodeSqlParser(
  sql: string,
  dialect: string,
  dbType: DatabaseType
): ParseResult {
  const statements = preprocessSQL(sql, dbType);
  const parser = new Parser();

  const tables: ParsedTable[] = [];
  const relationships: ParsedRelationship[] = [];

  // Statements are parsed individually for resilience
  for (const stmt of statements) {
    try {
      const ast = parser.astify(`${stmt};`, {
        database: dialect,
      });

      const astArr = Array.isArray(ast) ? ast : [ast];

      for (const node of astArr) {
        if (!node) continue;

        if (node.type === "create" && node.keyword === "table") {
          const table = parseCreateTable(node, dialect);
          if (table) {
            tables.push(table);
            // Extract inline FK relationships
            for (const col of table.columns) {
              if (col.references) {
                relationships.push({
                  sourceTable: table.name,
                  sourceColumn: col.name,
                  targetTable: col.references.table,
                  targetColumn: col.references.column,
                });
              }
            }
          }
        }

        if (node.type === "create" && node.keyword === "view") {
          const viewTable = Array.isArray(node.table) ? node.table[0] : node.table;
          tables.push({
            name: extractTableName(viewTable),
            schema: extractSchema(viewTable),
            columns: [],
            indexes: [],
            isView: true,
          });
        }

        if (node.type === "alter") {
          const alterRels = parseAlterTable(node);
          relationships.push(...alterRels);
        }
      }
    } catch {
      // Statement couldn't be parsed - try regex fallback for this statement
      const fallbackTable = tryRegexFallback(stmt);
      if (fallbackTable) {
        tables.push(fallbackTable);
      }
    }
  }

  return { tables, relationships };
}

function parseCreateTable(node: any, dialect: string): ParsedTable | null {
  const tableName = extractTableName(node.table?.[0]);
  const schema = extractSchema(node.table?.[0]);
  if (!tableName) return null;

  const columns: ParsedColumn[] = [];
  const indexes: ParsedIndex[] = [];
  const primaryKeyColumns: string[] = [];

  const definitions = node.create_definitions ?? [];

  for (const def of definitions) {
    if (def.resource === "column") {
      const col: ParsedColumn = {
        name: extractColumnName(def),
        type: extractType(def),
        primaryKey: isPrimaryKey(def),
        unique: isUnique(def),
        nullable: isNullable(def),
        default: getDefault(def, dialect),
      };

      const inlineRef = extractInlineFK(def);
      if (inlineRef) {
        col.references = inlineRef;
      }

      columns.push(col);
    }

    // Constraint: PRIMARY KEY
    if (def.resource === "constraint" && def.constraint_type === "primary key") {
      const pkCols = def.definition?.map((d: any) => extractRefColumnName(d) ?? d) ?? [];
      primaryKeyColumns.push(...pkCols);
    }

    // Constraint: UNIQUE
    if (def.resource === "constraint" && def.constraint_type === "unique") {
      const uqCols = def.definition?.map((d: any) => extractRefColumnName(d) ?? d) ?? [];
      const idxName = def.constraint ?? `uq_${tableName}_${uqCols.join("_")}`;
      indexes.push({
        name: idxName,
        columns: uqCols,
        unique: true,
      });
      // Mark columns
      for (const col of columns) {
        if (uqCols.includes(col.name)) {
          col.unique = true;
        }
      }
    }

    // Constraint: FOREIGN KEY
    if (def.resource === "constraint" && def.constraint_type === "FOREIGN KEY") {
      const fkCols = def.definition?.map((d: any) => extractRefColumnName(d) ?? d) ?? [];
      const refTable = extractReferencedTable(def.reference_definition?.table?.[0]);
      const refCols = def.reference_definition?.definition?.map(
        (d: any) => extractRefColumnName(d) ?? d
      ) ?? [];

      if (fkCols.length > 0 && refTable && refCols.length > 0) {
        for (let i = 0; i < fkCols.length; i++) {
          const col = columns.find((c) => c.name === fkCols[i]);
          if (col) {
            col.references = {
              table: refTable,
              column: refCols[i] ?? refCols[0],
            };
          }
        }
      }
    }
  }

  // Apply primary key from constraint
  for (const col of columns) {
    if (primaryKeyColumns.includes(col.name)) {
      col.primaryKey = true;
      col.nullable = false;
    }
  }

  return {
    name: tableName,
    schema,
    columns,
    indexes,
    isView: false,
  };
}

function parseAlterTable(node: any): ParsedRelationship[] {
  const relationships: ParsedRelationship[] = [];
  const tableName = extractTableName(node.table?.[0]);
  if (!tableName) return relationships;

  const exprs = node.expr ?? [];
  for (const expr of exprs) {
    if (expr.action === "add" && expr.resource === "constraint") {
      // create_definitions can be an object (single) or an array
      const defs = expr.create_definitions
        ? Array.isArray(expr.create_definitions)
          ? expr.create_definitions
          : [expr.create_definitions]
        : [];

      for (const def of defs) {
        if (def.constraint_type === "FOREIGN KEY") {
          const fkCols = def.definition?.map((d: any) => extractRefColumnName(d) ?? d) ?? [];
          const refTable = extractReferencedTable(
            def.reference_definition?.table?.[0]
          );
          const refCols = def.reference_definition?.definition?.map(
            (d: any) => extractRefColumnName(d) ?? d
          ) ?? [];

          for (let i = 0; i < fkCols.length; i++) {
            if (refTable && refCols[i]) {
              relationships.push({
                sourceTable: tableName,
                sourceColumn: fkCols[i],
                targetTable: refTable,
                targetColumn: refCols[i],
              });
            }
          }
        }
      }
    }
  }

  return relationships;
}

function tryRegexFallback(stmt: string): ParsedTable | null {
  const createMatch = stmt.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?(\w+)["'`]?\.)?["'`]?(\w+)["'`]?\s*\(([\s\S]+)\)/i
  );
  if (!createMatch) return null;

  const schema = createMatch[1];
  const tableName = createMatch[2]!;
  const body = createMatch[3]!;

  const columns: ParsedColumn[] = [];
  const lines = body.split(",").map((l) => l.trim());

  for (const line of lines) {
    // Skip constraints
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT|INDEX|KEY)\b/i.test(line)) {
      continue;
    }

    const colMatch = line.match(
      /^["'`]?(\w+)["'`]?\s+(\w+(?:\([^)]*\))?(?:\s+\w+)*)/i
    );
    if (colMatch) {
      const colName = colMatch[1]!;
      const colType = colMatch[2]!;

      columns.push({
        name: colName,
        type: colType.split(/\s+(NOT|NULL|DEFAULT|PRIMARY|UNIQUE|REFERENCES|CHECK)/i)[0]!.trim(),
        primaryKey: /PRIMARY\s+KEY/i.test(line),
        unique: /\bUNIQUE\b/i.test(line),
        nullable: !/NOT\s+NULL/i.test(line),
      });
    }
  }

  return {
    name: tableName,
    schema,
    columns,
    indexes: [],
    isView: false,
  };
}
