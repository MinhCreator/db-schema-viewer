import type {
  DatabaseType,
  Diagram,
  DBTable,
  DBField,
  DBIndex,
  DBRelationship,
} from "../domain";
import { generateId, getTableColor } from "../utils";
import type { ParsedTable, ParsedRelationship } from "./types";

/**
 * Convert parser-agnostic intermediate tables + relationships into a Diagram.
 *
 * This is the single, shared "second half" that every parser delegates to
 * after it has produced its own ParsedTable[] and ParsedRelationship[].
 *
 * Relationships are built from two sources (deduplicated):
 *   1. Inline FK references already stored on columns (col.references)
 *   2. The explicit `relationships` array (e.g. ALTER TABLE, relations(), Ref:)
 */
export function buildDiagram(
  parsedTables: ParsedTable[],
  parsedRelationships: ParsedRelationship[],
  databaseType: DatabaseType,
  name?: string,
): Diagram {
  const tables: DBTable[] = parsedTables.map((pt, index) => {
    const fields: DBField[] = pt.columns.map((col) => ({
      id: generateId(),
      name: col.name,
      type: col.type,
      primaryKey: col.primaryKey,
      unique: col.unique,
      nullable: col.nullable,
      default: col.default,
      comment: col.comment,
      isForeignKey: !!col.references,
      references: col.references
        ? { table: col.references.table, field: col.references.column }
        : undefined,
    }));

    const indexes: DBIndex[] = pt.indexes.map((idx) => ({
      id: generateId(),
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
    }));

    return {
      id: generateId(),
      name: pt.name,
      schema: pt.schema,
      fields,
      indexes,
      x: 0,
      y: 0,
      color: getTableColor(index),
      isView: pt.isView,
      comment: pt.comment,
    };
  });

  const relationships = resolveRelationships(tables, parsedRelationships);

  return {
    id: generateId(),
    name: name ?? "Untitled Schema",
    databaseType,
    tables,
    relationships,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build DBRelationship[] from two sources (deduplicated):
 *   1. Explicit: the ParsedRelationship[] array (processed first — may carry cardinality).
 *   2. Inline: fields that already have `references` set.
 */
function resolveRelationships(
  tables: DBTable[],
  parsedRelationships: ParsedRelationship[],
): DBRelationship[] {
  const lookup = createTableLookup(tables);

  const relationships: DBRelationship[] = [];
  const seen = new Set<string>();

  const addRel = (
    source: DBTable,
    sourceField: DBField,
    target: DBTable,
    targetField: DBField,
    cardinality?: ParsedRelationship["cardinality"],
  ) => {
    const key = `${source.id}|${sourceField.id}|${target.id}|${targetField.id}`;
    if (seen.has(key)) return;
    seen.add(key);

    relationships.push({
      id: generateId(),
      sourceTableId: source.id,
      sourceFieldId: sourceField.id,
      targetTableId: target.id,
      targetFieldId: targetField.id,
      cardinality:
        cardinality ?? (sourceField.unique ? "one-to-one" : "one-to-many"),
    });
  };

  // 1. Explicit relationships first (may carry parser-specific cardinality)
  for (const rel of parsedRelationships) {
    const sourceTable = lookup(rel.sourceTable);
    if (!sourceTable) continue;
    const targetTable = lookup(rel.targetTable, sourceTable.schema);
    if (!targetTable) continue;

    const sourceField = sourceTable.fields.find(
      (f) => f.name.toLowerCase() === rel.sourceColumn.toLowerCase(),
    );
    const targetField = targetTable.fields.find(
      (f) => f.name.toLowerCase() === rel.targetColumn.toLowerCase(),
    );
    if (!sourceField || !targetField) continue;

    // Mark field as FK when coming from DB-level constraints (not ORM-only relations)
    if (!sourceField.isForeignKey && !rel.isOrmOnly) {
      sourceField.isForeignKey = true;
      // Qualify the name only when the bare name would resolve elsewhere from
      // the source's schema, so unambiguous references keep their plain form.
      const bareResolves = lookup(targetTable.name, sourceTable.schema) === targetTable;
      sourceField.references = {
        table:
          bareResolves || !targetTable.schema
            ? targetTable.name
            : `${targetTable.schema}.${targetTable.name}`,
        field: targetField.name,
      };
    }

    addRel(sourceTable, sourceField, targetTable, targetField, rel.cardinality);
  }

  // 2. From inline FK references on fields (fills in anything not already covered)
  for (const table of tables) {
    for (const field of table.fields) {
      if (!field.references) continue;

      const targetTable = lookup(field.references.table, table.schema);
      if (!targetTable) continue;

      const targetField = targetTable.fields.find(
        (f) => f.name.toLowerCase() === field.references!.field.toLowerCase(),
      );
      if (!targetField) continue;

      addRel(table, field, targetTable, targetField);
    }
  }

  return relationships;
}

/**
 * Build a table resolver keyed by `schema.name` when a schema exists and by
 * bare name otherwise. A reference resolves, in order, to:
 *   1. the explicitly qualified table (`auth.users`);
 *   2. the same name in `contextSchema` (the source table's schema);
 *   3. the bare name (last table registered under it, as before);
 *   4. for a qualified reference with no match, its unqualified part.
 */
function createTableLookup(
  tables: DBTable[],
): (reference: string, contextSchema?: string) => DBTable | undefined {
  const byQualified = new Map<string, DBTable>();
  const byName = new Map<string, DBTable>();
  for (const t of tables) {
    const name = t.name.toLowerCase();
    byName.set(name, t);
    if (t.schema) byQualified.set(`${t.schema.toLowerCase()}.${name}`, t);
  }

  return (reference, contextSchema) => {
    const ref = reference.toLowerCase();
    const explicit = byQualified.get(ref);
    if (explicit) return explicit;

    if (contextSchema) {
      const sameSchema = byQualified.get(`${contextSchema.toLowerCase()}.${ref}`);
      if (sameSchema) return sameSchema;
    }

    const bare = byName.get(ref);
    if (bare) return bare;

    const dot = ref.lastIndexOf(".");
    return dot === -1 ? undefined : byName.get(ref.slice(dot + 1));
  };
}
