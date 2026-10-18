import type { Diagram, DBTable, DBField } from "../domain";
import { toCamelCase } from "./case-utils";

/**
 * Naively singularize a word (handles common English plural suffixes).
 */
function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies") && word.length > 3) {
    return word.slice(0, -3) + "y";
  }
  // classes -> class, boxes -> box, matches -> match, wishes -> wish
  if (/(ss|x|ch|sh)es$/.test(lower)) {
    return word.slice(0, -2);
  }
  // statuses -> status, buses -> bus (but houses -> house, causes -> cause)
  if (lower.endsWith("uses") && !/[ao]uses$/.test(lower)) {
    return word.slice(0, -2);
  }
  // courses -> course, cases -> case, sizes -> size
  if (lower.endsWith("s") && !lower.endsWith("ss") && !lower.endsWith("us") && !lower.endsWith("is")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Convert a snake_case or lowercase table name to PascalCase model name.
 * Singularizes the last segment (e.g., "user_roles" -> "UserRole").
 */
function toPascalCase(name: string): string {
  const parts = name.split(/[_\-\s]+/);
  if (parts.length > 0) {
    parts[parts.length - 1] = singularize(parts[parts.length - 1]!);
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

/**
 * Map a databaseType to a Prisma datasource provider string.
 */
function mapDatabaseTypeToProvider(dbType: string): string {
  switch (dbType) {
    case "postgresql":
    case "supabase":
      return "postgresql";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "cockroachdb":
      return "cockroachdb";
    default:
      return "postgresql";
  }
}

/**
 * Check if a SQL type represents an auto-incrementing column.
 */
function isAutoIncrement(sqlType: string): boolean {
  const upper = sqlType.toUpperCase();
  return upper === "SERIAL" || upper === "BIGSERIAL" || upper === "SMALLSERIAL" || upper.includes("AUTO_INCREMENT");
}

/**
 * Map a SQL type string to a Prisma scalar type.
 */
function mapSqlTypeToPrisma(sqlType: string): string {
  const upper = sqlType.toUpperCase().replace(/\(.*\)/, "").trim();

  switch (upper) {
    case "INT":
    case "INTEGER":
    case "SMALLINT":
    case "TINYINT":
    case "MEDIUMINT":
    case "SERIAL":
    case "SMALLSERIAL":
      return "Int";
    case "BIGINT":
    case "BIGSERIAL":
      return "BigInt";
    case "FLOAT":
    case "REAL":
    case "DOUBLE":
    case "DOUBLE PRECISION":
    case "DECIMAL":
    case "NUMERIC":
      return "Float";
    case "BOOLEAN":
    case "BOOL":
      return "Boolean";
    case "VARCHAR":
    case "CHAR":
    case "CHARACTER VARYING":
    case "TEXT":
    case "NVARCHAR":
    case "NTEXT":
    case "CLOB":
    case "UUID":
      return "String";
    case "TIMESTAMP":
    case "TIMESTAMPTZ":
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMP WITHOUT TIME ZONE":
    case "DATETIME":
    case "DATE":
      return "DateTime";
    case "JSON":
    case "JSONB":
      return "Json";
    case "BYTEA":
    case "BLOB":
    case "BINARY":
    case "VARBINARY":
      return "Bytes";
    default:
      return "String";
  }
}

/**
 * Build Prisma attribute annotations for a field.
 */
function buildFieldAttributes(field: DBField, compositePrimaryKey: boolean): string {
  const attrs: string[] = [];

  if (field.primaryKey && !compositePrimaryKey) {
    attrs.push("@id");
  }

  if (isAutoIncrement(field.type)) {
    attrs.push("@default(autoincrement())");
  } else if (field.default !== undefined && field.default !== "") {
    const defVal = String(field.default);
    if (defVal.toLowerCase() === "uuid()" || defVal.toLowerCase() === "gen_random_uuid()") {
      attrs.push("@default(uuid())");
    } else if (defVal.toLowerCase() === "now()" || defVal.toLowerCase() === "current_timestamp") {
      attrs.push("@default(now())");
    } else if (defVal === "true" || defVal === "false") {
      attrs.push(`@default(${defVal})`);
    } else if (!isNaN(Number(defVal))) {
      attrs.push(`@default(${defVal})`);
    } else {
      attrs.push(`@default("${defVal}")`);
    }
  }

  if (field.unique && !field.primaryKey) {
    attrs.push("@unique");
  }

  // Map column name if camelCase differs from original
  const camelName = toCamelCase(field.name);
  if (camelName !== field.name) {
    attrs.push(`@map("${field.name}")`);
  }

  return attrs.length > 0 ? " " + attrs.join(" ") : "";
}

interface RelationInfo {
  sourceTable: DBTable;
  sourceField: DBField;
  targetTable: DBTable;
  targetField: DBField;
  cardinality: string;
  relationshipId: string;
}

/**
 * Gather all relationship info for a diagram.
 */
function gatherRelations(diagram: Diagram): RelationInfo[] {
  const result: RelationInfo[] = [];
  const tablesById = new Map(diagram.tables.map((t) => [t.id, t]));
  for (const rel of diagram.relationships) {
    const sourceTable = tablesById.get(rel.sourceTableId);
    const targetTable = tablesById.get(rel.targetTableId);
    if (!sourceTable || !targetTable) continue;
    const sourceField = sourceTable.fields.find((f) => f.id === rel.sourceFieldId);
    const targetField = targetTable.fields.find((f) => f.id === rel.targetFieldId);
    if (!sourceField || !targetField) continue;
    result.push({
      sourceTable,
      sourceField,
      targetTable,
      targetField,
      cardinality: rel.cardinality,
      relationshipId: rel.id,
    });
  }
  return result;
}

/**
 * Count how many relations exist between the same pair of tables (for disambiguation).
 */
function countRelationsBetween(relations: RelationInfo[], tableA: string, tableB: string): number {
  return relations.filter(
    (r) =>
      (r.sourceTable.id === tableA && r.targetTable.id === tableB) ||
      (r.sourceTable.id === tableB && r.targetTable.id === tableA),
  ).length;
}

/** Return `base`, or `base2`, `base3`, ... — the first name not yet taken in the model. */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}${n}`;
    n++;
  }
  taken.add(name);
  return name;
}

/** Relation field name derived from the FK column: `author_id` -> `author`, `created_by` -> `createdByUser`. */
function relationFieldBase(rel: RelationInfo): string {
  const fkFieldCamel = toCamelCase(rel.sourceField.name);
  const stripped = fkFieldCamel.replace(/Id$/, "");
  if (stripped && stripped !== fkFieldCamel) return stripped;
  return `${fkFieldCamel}${toPascalCase(rel.targetTable.name)}`;
}

export function exportDiagramToPrisma(diagram: Diagram): string {
  const lines: string[] = [];
  const provider = mapDatabaseTypeToProvider(diagram.databaseType);

  // Generator block
  lines.push("generator client {");
  lines.push('  provider = "prisma-client-js"');
  lines.push("}");
  lines.push("");

  // Datasource block
  lines.push("datasource db {");
  lines.push(`  provider = "${provider}"`);
  lines.push('  url      = env("DATABASE_URL")');
  lines.push("}");

  const allRelations = gatherRelations(diagram);

  // Name each relation's forward field once, so the reverse side can refer to it.
  const forwardNames = new Map<RelationInfo, string>();
  const takenByTable = new Map<string, Set<string>>();
  for (const table of diagram.tables) {
    takenByTable.set(table.id, new Set(table.fields.map((f) => toCamelCase(f.name))));
  }
  for (const rel of allRelations) {
    const taken = takenByTable.get(rel.sourceTable.id)!;
    forwardNames.set(rel, uniqueName(relationFieldBase(rel), taken));
  }

  // Generate each model
  for (const table of diagram.tables) {
    lines.push("");
    const modelName = toPascalCase(table.name);
    lines.push(`model ${modelName} {`);

    const pkFields = table.fields.filter((f) => f.primaryKey);
    const compositePrimaryKey = pkFields.length > 1;
    const taken = takenByTable.get(table.id)!;

    // Regular scalar fields
    for (const field of table.fields) {
      const prismaType = mapSqlTypeToPrisma(field.type);
      const camelName = toCamelCase(field.name);
      const nullable = field.nullable && !field.primaryKey ? "?" : "";
      const attrs = buildFieldAttributes(field, compositePrimaryKey);
      lines.push(`  ${camelName} ${prismaType}${nullable}${attrs}`);
    }

    // Relation fields where this table is the SOURCE (has the FK)
    const outgoingRelations = allRelations.filter((r) => r.sourceTable.id === table.id);
    for (const rel of outgoingRelations) {
      const targetModelName = toPascalCase(rel.targetTable.name);
      const fkFieldCamel = toCamelCase(rel.sourceField.name);
      const targetFieldCamel = toCamelCase(rel.targetField.name);
      const relationFieldName = forwardNames.get(rel)!;

      const needsName = countRelationsBetween(allRelations, rel.sourceTable.id, rel.targetTable.id) > 1;
      const relationAttrParts = [`fields: [${fkFieldCamel}]`, `references: [${targetFieldCamel}]`];
      if (needsName) {
        relationAttrParts.unshift(`"${rel.relationshipId}"`);
      }

      const nullable = rel.sourceField.nullable ? "?" : "";
      lines.push(`  ${relationFieldName} ${targetModelName}${nullable} @relation(${relationAttrParts.join(", ")})`);
    }

    // Reverse relation fields where this table is the TARGET (other table has FK pointing here)
    const incomingRelations = allRelations.filter((r) => r.targetTable.id === table.id);
    for (const rel of incomingRelations) {
      const sourceModelName = toPascalCase(rel.sourceTable.name);
      const needsName = countRelationsBetween(allRelations, rel.sourceTable.id, rel.targetTable.id) > 1;
      const nameAttr = needsName ? `("${rel.relationshipId}")` : "";
      // With several relations to the same table, qualify by the forward field: messagesAsSender.
      const qualifier = needsName
        ? `As${forwardNames.get(rel)!.charAt(0).toUpperCase()}${forwardNames.get(rel)!.slice(1)}`
        : "";

      if (rel.cardinality === "one-to-one") {
        // Singular: use the singularized model name in camelCase
        const base = sourceModelName.charAt(0).toLowerCase() + sourceModelName.slice(1) + qualifier;
        const reverseFieldName = uniqueName(base, taken);
        lines.push(`  ${reverseFieldName} ${sourceModelName}?${nameAttr ? ` @relation${nameAttr}` : ""}`);
      } else {
        // one-to-many or many-to-many: array - use table name directly (usually already plural)
        const reverseFieldName = uniqueName(toCamelCase(rel.sourceTable.name) + qualifier, taken);
        lines.push(`  ${reverseFieldName} ${sourceModelName}[]${nameAttr ? ` @relation${nameAttr}` : ""}`);
      }
    }

    if (compositePrimaryKey) {
      lines.push(`  @@id([${pkFields.map((f) => toCamelCase(f.name)).join(", ")}])`);
    }

    // @@map if the model name differs from the table name
    if (modelName !== table.name) {
      lines.push(`  @@map("${table.name}")`);
    }

    lines.push("}");
  }

  return lines.join("\n") + "\n";
}
