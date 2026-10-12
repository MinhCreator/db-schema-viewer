import type { Diagram, DBTable, DBField, DatabaseType } from "../domain";

const TYPE_MAP: Record<string, Partial<Record<DatabaseType, string>>> = {
  serial: { mysql: "INT AUTO_INCREMENT", sqlite: "INTEGER", bigquery: "INT64" },
  bigserial: { mysql: "BIGINT AUTO_INCREMENT", sqlite: "INTEGER", bigquery: "INT64" },
  boolean: { mysql: "TINYINT(1)", bigquery: "BOOL" },
  jsonb: { mysql: "JSON", sqlite: "TEXT", bigquery: "STRING" },
  json: { sqlite: "TEXT", bigquery: "STRING" },
  uuid: { mysql: "CHAR(36)", sqlite: "TEXT", bigquery: "STRING" },
  timestamptz: { mysql: "TIMESTAMP", sqlite: "TEXT", bigquery: "TIMESTAMP" },
  text: { bigquery: "STRING" },
  varchar: { bigquery: "STRING" },
  integer: { bigquery: "INT64" },
  bigint: { bigquery: "INT64" },
  smallint: { bigquery: "INT64" },
  real: { bigquery: "FLOAT64" },
  "double precision": { bigquery: "FLOAT64" },
  numeric: { bigquery: "NUMERIC" },
  bytea: { mysql: "BLOB", sqlite: "BLOB", bigquery: "BYTES" },
};

function mapType(type: string, targetDb: DatabaseType): string {
  const lower = type.toLowerCase().replace(/\(.*\)/, "").trim();
  const mapped = TYPE_MAP[lower];
  if (mapped?.[targetDb]) {
    return mapped[targetDb]!;
  }
  return type;
}

function quoteIdentifier(name: string, dbType: DatabaseType): string {
  switch (dbType) {
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return `\`${name.replace(/`/g, "``")}\``;
    case "postgresql":
    case "supabase":
    case "cockroachdb":
      return `"${name.replace(/"/g, '""')}"`;
    case "sqlite":
      return `"${name.replace(/"/g, '""')}"`;
    case "bigquery":
    case "snowflake":
      return name;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

const POSTGRES_FAMILY: readonly DatabaseType[] = ["postgresql", "supabase", "cockroachdb"];

/** Placeholder enum type emitted by Prisma/Drizzle parsers when values are unknown, e.g. `ENUM(Status)`. */
const VALUELESS_ENUM = /^ENUM\((\w+)\)$/i;

/** Default markers meaning "the database generates this value" (Kysely `Generated<>`, Prisma `autoincrement()`). */
function isGeneratedMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.trim().toLowerCase();
  return lower === "auto" || lower === "autoincrement()";
}

function isIntegerType(type: string): boolean {
  return /^(int|integer|smallint|bigint|tinyint|mediumint|int2|int4|int8)$/i.test(
    type.replace(/\(.*\)/, "").trim(),
  );
}

function isTemporalType(type: string): boolean {
  return /^(timestamp|timestamptz|datetime|date|time)\b/i.test(type.trim());
}

function qualifiedName(table: DBTable, targetDb: DatabaseType): string {
  return table.schema
    ? `${quoteIdentifier(table.schema, targetDb)}.${quoteIdentifier(table.name, targetDb)}`
    : quoteIdentifier(table.name, targetDb);
}

interface ResolvedFK {
  field: DBField;
  targetTable: DBTable | undefined;
  targetTableName: string;
  targetFieldName: string;
}

/**
 * Resolve each FK column of a table to its referenced table, preferring the
 * diagram relationship (exact table identity) over the field's `references`
 * name, then a same-schema table, then any table with that name.
 */
interface DiagramIndex {
  tablesById: Map<string, DBTable>;
  relationshipBySourceField: Map<string, Diagram["relationships"][number]>;
}

const diagramIndexes = new WeakMap<Diagram, DiagramIndex>();

/** Lookup tables built once per diagram, so FK resolution stays linear on large schemas. */
function indexDiagram(diagram: Diagram): DiagramIndex {
  let index = diagramIndexes.get(diagram);
  if (!index) {
    const relationshipBySourceField = new Map<string, Diagram["relationships"][number]>();
    for (const rel of diagram.relationships) {
      const key = `${rel.sourceTableId}\u0000${rel.sourceFieldId}`;
      if (!relationshipBySourceField.has(key)) relationshipBySourceField.set(key, rel);
    }
    index = { tablesById: new Map(diagram.tables.map((t) => [t.id, t])), relationshipBySourceField };
    diagramIndexes.set(diagram, index);
  }
  return index;
}

function resolveForeignKeys(table: DBTable, diagram: Diagram): ResolvedFK[] {
  const result: ResolvedFK[] = [];
  const { tablesById, relationshipBySourceField } = indexDiagram(diagram);
  for (const field of table.fields) {
    if (!field.references) continue;
    const rel = relationshipBySourceField.get(`${table.id}\u0000${field.id}`);
    let targetTable = rel ? tablesById.get(rel.targetTableId) : undefined;
    let targetFieldName = field.references.field;
    if (targetTable && rel) {
      targetFieldName = targetTable.fields.find((f) => f.id === rel.targetFieldId)?.name ?? targetFieldName;
    } else {
      const refName = field.references.table;
      const candidates = diagram.tables.filter(
        (t) => t.name === refName || (t.schema !== undefined && `${t.schema}.${t.name}` === refName),
      );
      targetTable = candidates.find((t) => t.schema === table.schema) ?? candidates[0];
    }
    result.push({
      field,
      targetTable,
      targetTableName: field.references.table,
      targetFieldName,
    });
  }
  return result;
}

function referenceClause(fk: ResolvedFK, targetDb: DatabaseType): string {
  const refTable = fk.targetTable
    ? qualifiedName(fk.targetTable, targetDb)
    : quoteIdentifier(fk.targetTableName, targetDb);
  // BigQuery doesn't support ON DELETE/UPDATE actions
  const cascade = targetDb === "bigquery" ? "" : " ON DELETE CASCADE ON UPDATE CASCADE";
  return `REFERENCES ${refTable} (${quoteIdentifier(fk.targetFieldName, targetDb)})${cascade}`;
}

function columnType(field: DBField, targetDb: DatabaseType): string {
  if (VALUELESS_ENUM.test(field.type.trim())) return mapType("TEXT", targetDb);
  return mapType(field.type, targetDb);
}

function generateCreateTable(table: DBTable, diagram: Diagram, targetDb: DatabaseType): string {
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${qualifiedName(table, targetDb)} (`);

  const fieldDefs: string[] = [];
  const pkFields = table.fields.filter((f) => f.primaryKey);
  let inlinePrimaryKey = false;

  for (const field of table.fields) {
    const parts: string[] = [];
    parts.push(`  ${quoteIdentifier(field.name, targetDb)}`);

    const generated = isGeneratedMarker(field.default);
    const autoIncrement = generated && isIntegerType(field.type);
    let type = columnType(field, targetDb);
    const suffixes: string[] = [];
    let defaultClause = field.default && !generated ? `DEFAULT ${field.default}` : "";

    if (autoIncrement) {
      const base = field.type.replace(/\(.*\)/, "").trim().toUpperCase();
      if (POSTGRES_FAMILY.includes(targetDb)) {
        type = base === "BIGINT" || base === "INT8" ? "BIGSERIAL" : base === "SMALLINT" || base === "INT2" ? "SMALLSERIAL" : "SERIAL";
      } else if (targetDb === "mysql" || targetDb === "mariadb") {
        suffixes.push("AUTO_INCREMENT");
      } else if (targetDb === "sqlite") {
        if (field.primaryKey && pkFields.length === 1) {
          type = "INTEGER PRIMARY KEY AUTOINCREMENT";
          inlinePrimaryKey = true;
        }
      } else if (targetDb === "snowflake") {
        suffixes.push("AUTOINCREMENT");
      } else if (targetDb === "generic") {
        suffixes.push("GENERATED BY DEFAULT AS IDENTITY");
      }
      // ClickHouse and BigQuery have no auto-increment columns.
    } else if (generated && isTemporalType(field.type)) {
      defaultClause = "DEFAULT CURRENT_TIMESTAMP";
    }

    parts.push(type);
    if (!field.nullable && !(inlinePrimaryKey && field.primaryKey)) parts.push("NOT NULL");
    if (field.unique && !field.primaryKey) parts.push("UNIQUE");
    if (defaultClause) parts.push(defaultClause);
    parts.push(...suffixes);

    fieldDefs.push(parts.join(" "));
  }

  if (pkFields.length > 0 && !inlinePrimaryKey) {
    fieldDefs.push(
      `  PRIMARY KEY (${pkFields.map((pk) => quoteIdentifier(pk.name, targetDb)).join(", ")})`
    );
  }

  // SQLite cannot add constraints with ALTER TABLE: declare FKs inline.
  if (targetDb === "sqlite") {
    for (const fk of resolveForeignKeys(table, diagram)) {
      fieldDefs.push(
        `  FOREIGN KEY (${quoteIdentifier(fk.field.name, targetDb)}) ${referenceClause(fk, targetDb)}`
      );
    }
  }

  lines.push(fieldDefs.join(",\n"));
  lines.push(");");

  return lines.join("\n");
}

function generateFKs(table: DBTable, diagram: Diagram, targetDb: DatabaseType): string[] {
  if (targetDb === "sqlite") return [];
  return resolveForeignKeys(table, diagram).map((fk) => {
    const constraint = `fk_${table.name}_${fk.field.name}`;
    return `ALTER TABLE ${qualifiedName(table, targetDb)} ADD CONSTRAINT ${constraint} FOREIGN KEY (${quoteIdentifier(fk.field.name, targetDb)}) ${referenceClause(fk, targetDb)};`;
  });
}

function generateIndexes(table: DBTable, targetDb: DatabaseType): string[] {
  const statements: string[] = [];
  const tableName = qualifiedName(table, targetDb);
  for (const idx of table.indexes) {
    const cols = idx.columns.map((c) => quoteIdentifier(c, targetDb)).join(", ");
    const unique = idx.unique ? "UNIQUE " : "";
    const idxName = idx.name || `idx_${table.name}_${idx.columns.join("_")}`;
    statements.push(`CREATE ${unique}INDEX ${quoteIdentifier(idxName, targetDb)} ON ${tableName} (${cols});`);
  }
  return statements;
}

function generateComments(table: DBTable, targetDb: DatabaseType): string[] {
  // COMMENT ON is only supported by PostgreSQL-family and Snowflake
  if (![...POSTGRES_FAMILY, "snowflake"].includes(targetDb)) return [];

  const statements: string[] = [];
  const tableName = qualifiedName(table, targetDb);

  if (table.comment) {
    statements.push(`COMMENT ON TABLE ${tableName} IS '${table.comment.replace(/'/g, "''")}';`);
  }

  for (const field of table.fields) {
    if (field.comment) {
      statements.push(`COMMENT ON COLUMN ${tableName}.${quoteIdentifier(field.name, targetDb)} IS '${field.comment.replace(/'/g, "''")}';`);
    }
  }

  return statements;
}

/** Enum type names referenced as `ENUM(Name)` whose values the diagram does not carry. */
function collectValuelessEnums(diagram: Diagram): string[] {
  const names = new Set<string>();
  for (const table of diagram.tables) {
    for (const field of table.fields) {
      const enumName = field.type.trim().match(VALUELESS_ENUM)?.[1];
      if (enumName) names.add(enumName);
    }
  }
  return [...names];
}

function generateViews(diagram: Diagram, targetDb: DatabaseType): string[] {
  const statements: string[] = [];
  for (const table of diagram.tables) {
    if (!table.isView) continue;
    const qName = qualifiedName(table, targetDb);
    const cols = table.fields.map((f) => quoteIdentifier(f.name, targetDb)).join(", ");
    statements.push(`-- View: ${table.name} (columns: ${table.fields.map((f) => f.name).join(", ")})`);
    statements.push(`CREATE OR REPLACE VIEW ${qName} AS`);
    statements.push(`  SELECT ${cols || "*"}`);
    statements.push(`  FROM /* source table */;`);
  }
  return statements;
}

export function exportDiagramToSQL(diagram: Diagram, targetDb?: DatabaseType): string {
  const db = targetDb ?? diagram.databaseType;
  const parts: string[] = [];

  parts.push(`-- Generated by db-schema-viewer`);
  parts.push(`-- Database: ${db}`);
  parts.push(`-- Date: ${new Date().toISOString()}`);
  parts.push("");

  // Enum types referenced without their values cannot be declared: export them as text.
  const valuelessEnums = collectValuelessEnums(diagram);
  if (valuelessEnums.length > 0) {
    parts.push(`-- Enum types: values unknown, columns exported as ${mapType("TEXT", db)}`);
    if (POSTGRES_FAMILY.includes(db)) {
      // Template only: an enum without values cannot hold any data.
      for (const name of valuelessEnums) {
        parts.push(`-- CREATE TYPE ${quoteIdentifier(name, db)} AS ENUM (/* values */);`);
      }
    } else {
      parts.push(`-- ${valuelessEnums.join(", ")}`);
    }
    parts.push("");
  }

  // Create tables
  for (const table of diagram.tables) {
    if (table.isView) continue;
    parts.push(generateCreateTable(table, diagram, db));
    parts.push("");
  }

  // Foreign keys
  const fkStatements: string[] = [];
  for (const table of diagram.tables) {
    if (table.isView) continue;
    fkStatements.push(...generateFKs(table, diagram, db));
  }
  if (fkStatements.length > 0) {
    parts.push(...fkStatements);
    parts.push("");
  }

  // Indexes
  const indexStatements: string[] = [];
  for (const table of diagram.tables) {
    if (table.isView) continue;
    indexStatements.push(...generateIndexes(table, db));
  }
  if (indexStatements.length > 0) {
    parts.push("-- Indexes");
    parts.push(...indexStatements);
    parts.push("");
  }

  // Comments (PostgreSQL-family only)
  const commentStatements: string[] = [];
  for (const table of diagram.tables) {
    commentStatements.push(...generateComments(table, db));
  }
  if (commentStatements.length > 0) {
    parts.push("-- Comments");
    parts.push(...commentStatements);
    parts.push("");
  }

  // Views
  const viewStatements = generateViews(diagram, db);
  if (viewStatements.length > 0) {
    parts.push("-- Views");
    parts.push(...viewStatements);
    parts.push("");
  }

  return parts.join("\n");
}
