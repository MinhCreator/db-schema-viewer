import type { Diagram, DatabaseType } from "../domain";
import type { ParsedColumn, ParsedRelationship, ParsedIndex } from "../parsing/types";
import { buildDiagram } from "../parsing/build-diagram";
import { extractBraceBlock } from "../parsing/extract-brace-block";

interface PrismaField {
  name: string;
  type: string;
  isOptional: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  default?: string;
  map?: string;
}

/** A relation field with `@relation(fields: [...], references: [...])`. */
interface PrismaRelation {
  targetModel: string;
  fields: string[];
  references: string[];
}

interface PrismaModel {
  name: string;
  dbName?: string;
  fields: PrismaField[];
  relations: PrismaRelation[];
  compositeId?: string[];
  indexes?: string[][];
}

interface PrismaEnum {
  name: string;
  values: string[];
}

/**
 * Parse a Prisma schema (.prisma) file into a Diagram.
 * Beta feature — uses regex-based parsing.
 */
export function parsePrismaSchema(content: string, name?: string): Diagram {
  const databaseType = detectPrismaProvider(content);
  const enums = extractEnums(content);
  const models = extractModels(content, enums);

  const parsedTables = models.map((model) => ({
    name: model.dbName || model.name,
    columns: modelFieldsToColumns(model),
    indexes: modelIndexes(model),
    isView: false,
  }));

  const relationships = resolveRelationships(models);

  return buildDiagram(parsedTables, relationships, databaseType, name ?? "Prisma Schema");
}

// ── Provider detection ─────────────────────────────────────────────

function detectPrismaProvider(content: string): DatabaseType {
  const dsMatch = /datasource\s+\w+\s*\{([^}]*)\}/s.exec(content);
  if (!dsMatch) return "postgresql";

  const providerMatch = /provider\s*=\s*["'](\w+)["']/.exec(dsMatch[1]!);
  if (!providerMatch) return "postgresql";

  switch (providerMatch[1]!.toLowerCase()) {
    case "postgresql":
    case "postgres":
      return "postgresql";
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "cockroachdb":
      return "cockroachdb";
    default:
      return "postgresql";
  }
}

// ── Enum extraction ────────────────────────────────────────────────

function extractEnums(content: string): PrismaEnum[] {
  const enums: PrismaEnum[] = [];
  const enumRegex = /enum\s+(\w+)\s*\{([^}]*)\}/g;

  let match;
  while ((match = enumRegex.exec(content)) !== null) {
    const enumName = match[1]!;
    const body = match[2]!;
    const values = body
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    enums.push({ name: enumName, values });
  }

  return enums;
}

// ── Model extraction ───────────────────────────────────────────────

function extractModels(content: string, enums: PrismaEnum[]): PrismaModel[] {
  const models: PrismaModel[] = [];
  const modelRegex = /model\s+(\w+)\s*\{/g;
  const enumNames = new Set(enums.map((e) => e.name));
  const modelNames = new Set(
    Array.from(content.matchAll(/model\s+(\w+)\s*\{/g), (m) => m[1]!),
  );

  let match;
  while ((match = modelRegex.exec(content)) !== null) {
    const modelName = match[1]!;
    const startIdx = content.indexOf("{", match.index);
    const body = extractBraceBlock(content, startIdx);
    if (!body) continue;

    const model = parseModelBody(modelName, body, enumNames, modelNames);
    models.push(model);
  }

  return models;
}

function parseModelBody(
  modelName: string,
  body: string,
  enumNames: Set<string>,
  modelNames: Set<string>,
): PrismaModel {
  const fields: PrismaField[] = [];
  const relations: PrismaRelation[] = [];
  let compositeId: string[] | undefined;
  const indexes: string[][] = [];
  let dbName: string | undefined;

  const lines = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim());

  for (const line of lines) {
    if (!line || line.startsWith("//")) continue;

    // @@id([field1, field2])
    const compositeIdMatch = line.match(/@@id\s*\(\s*\[([^\]]+)\]\s*\)/);
    if (compositeIdMatch) {
      compositeId = compositeIdMatch[1]!.split(",").map((s) => s.trim());
      continue;
    }

    // @@index([field1, field2])
    const indexMatch = line.match(/@@index\s*\(\s*\[([^\]]+)\]\s*\)/);
    if (indexMatch) {
      indexes.push(indexMatch[1]!.split(",").map((s) => s.trim()));
      continue;
    }

    // @@map("table_name")
    const mapMatch = line.match(/@@map\s*\(\s*["'](\w+)["']\s*\)/);
    if (mapMatch) {
      dbName = mapMatch[1];
      continue;
    }

    // Skip other model-level attributes
    if (line.startsWith("@@")) continue;

    // Parse field: name Type? @attributes
    const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?\s*(\?)?\s*(.*)?$/);
    if (!fieldMatch) continue;

    const fieldName = fieldMatch[1]!;
    const fieldType = fieldMatch[2]!;
    const isOptional = !!fieldMatch[4];
    const attrs = fieldMatch[5] || "";

    // Relation fields (type is another model) are not columns. Those with
    // `@relation(fields: [...], references: [...])` carry the FK definition.
    if (modelNames.has(fieldType)) {
      const relationArgs = extractAttributeArgs(attrs, "relation");
      const relation =
        relationArgs !== undefined ? parseRelationArgs(relationArgs) : undefined;
      if (relation) relations.push({ targetModel: fieldType, ...relation });
      continue;
    }

    const isPK = /@id\b/.test(attrs);
    const isUnique = /@unique\b/.test(attrs);
    const defaultValue = extractAttributeArgs(attrs, "default")?.trim() || undefined;

    // Extract @map
    const fieldMapMatch = attrs.match(/@map\s*\(\s*["'](\w+)["']\s*\)/);

    fields.push({
      name: fieldName,
      type: mapPrismaType(fieldType, enumNames),
      isOptional,
      isPrimaryKey: isPK,
      isUnique,
      default: defaultValue,
      map: fieldMapMatch?.[1],
    });
  }

  // Mark composite PK fields
  if (compositeId) {
    for (const fieldName of compositeId) {
      const field = fields.find((f) => f.name === fieldName);
      if (field) field.isPrimaryKey = true;
    }
  }

  return {
    name: modelName,
    dbName,
    fields,
    relations,
    compositeId,
    indexes,
  };
}

// ── Convert Prisma model fields to shared ParsedColumn[] ──────────

function modelFieldsToColumns(model: PrismaModel): ParsedColumn[] {
  return model.fields.map((field) => ({
    name: field.map || field.name,
    type: field.type,
    primaryKey: field.isPrimaryKey,
    unique: field.isUnique,
    nullable: field.isOptional,
    default: field.default,
  }));
}

function modelIndexes(model: PrismaModel): ParsedIndex[] {
  return (model.indexes || []).map((cols) => ({
    name: `idx_${model.name.toLowerCase()}_${cols.join("_")}`,
    columns: cols,
    unique: false,
  }));
}

// ── Relationship resolution ────────────────────────────────────────

function resolveRelationships(models: PrismaModel[]): ParsedRelationship[] {
  const relationships: ParsedRelationship[] = [];
  for (const model of models) {
    const sourceTableName = model.dbName || model.name;
    const coveredFields = new Set<string>();

    // 1. Explicit `@relation(fields: [...], references: [...])`
    for (const relation of model.relations) {
      const targetModel = models.find((m) => m.name === relation.targetModel);
      if (!targetModel) continue;
      const targetTableName = targetModel.dbName || targetModel.name;

      relation.fields.forEach((fieldName, i) => {
        const referenceName = relation.references[i];
        if (referenceName === undefined) return;
        const field = model.fields.find((f) => f.name === fieldName);
        const targetField = targetModel.fields.find((f) => f.name === referenceName);
        if (!field || !targetField) return;

        coveredFields.add(field.name);
        relationships.push({
          sourceTable: sourceTableName,
          sourceColumn: field.map || field.name,
          targetTable: targetTableName,
          targetColumn: targetField.map || targetField.name,
          cardinality:
            field.isUnique && relation.fields.length === 1 ? "one-to-one" : "one-to-many",
        });
      });
    }

    // 2. Fallback convention: field ending with Id (e.g., authorId) references Author model
    for (const field of model.fields) {
      if (coveredFields.has(field.name)) continue;
      const idMatch = field.name.match(/^(.+?)Id$/i);
      if (!idMatch) continue;

      const refName = idMatch[1]!;
      const targetModel = models.find(
        (m) =>
          m.name.toLowerCase() === refName.toLowerCase() ||
          m.name.toLowerCase() === refName.toLowerCase() + "s",
      );

      if (!targetModel) continue;

      const targetTableName = targetModel.dbName || targetModel.name;

      // Find PK field in target model
      const targetPK = targetModel.fields.find((f) => f.isPrimaryKey);
      if (!targetPK) continue;

      const sourceColumnName = field.map || field.name;
      const targetColumnName = targetPK.map || targetPK.name;

      relationships.push({
        sourceTable: sourceTableName,
        sourceColumn: sourceColumnName,
        targetTable: targetTableName,
        targetColumn: targetColumnName,
        cardinality: field.isUnique ? "one-to-one" : "one-to-many",
      });
    }
  }

  return relationships;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Return the raw text between the parentheses of `@name(...)`, balancing
 * nested parentheses and skipping quoted strings. `undefined` if absent.
 */
function extractAttributeArgs(attrs: string, name: string): string | undefined {
  const attrRegex = new RegExp(`@${name}\\s*\\(`);
  const match = attrRegex.exec(attrs);
  if (!match) return undefined;

  const start = match.index + match[0].length;
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < attrs.length; i++) {
    const ch = attrs[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return attrs.slice(start, i);
  }
  return undefined;
}

/** Split on commas that are not nested in brackets, parentheses or strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    current += ch;
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) current += text[++i]!;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.slice(0, -1));
      current = "";
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Parse `@relation` arguments in any order: an optional positional or `name:`
 * relation name, `fields`, `references`, `onDelete`, `onUpdate` and `map`.
 * Returns the FK mapping only when both `fields` and `references` are present.
 */
function parseRelationArgs(
  args: string,
): Pick<PrismaRelation, "fields" | "references"> | undefined {
  let fields: string[] | undefined;
  let references: string[] | undefined;

  for (const part of splitTopLevel(args)) {
    const named = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
    if (!named) continue; // positional relation name
    const key = named[1]!;
    const list = /^\[([\s\S]*)\]$/.exec(named[2]!.trim());
    if (!list) continue;
    const names = list[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (key === "fields") fields = names;
    else if (key === "references") references = names;
  }

  return fields && references ? { fields, references } : undefined;
}

function mapPrismaType(type: string, enumNames: Set<string>): string {
  if (enumNames.has(type)) return `ENUM(${type})`;

  const map: Record<string, string> = {
    String: "VARCHAR",
    Int: "INTEGER",
    BigInt: "BIGINT",
    Float: "FLOAT",
    Decimal: "DECIMAL",
    Boolean: "BOOLEAN",
    DateTime: "TIMESTAMP",
    Json: "JSON",
    Bytes: "BYTEA",
  };
  return map[type] || type;
}

