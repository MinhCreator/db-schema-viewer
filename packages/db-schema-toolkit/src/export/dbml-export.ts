import type { Diagram } from "../domain";

/**
 * Export a Diagram to DBML (Database Markup Language) format.
 * Compatible with dbdiagram.io and other DBML tools.
 */
export function exportDiagramToDBML(diagram: Diagram): string {
  const lines: string[] = [];

  for (const table of diagram.tables) {
    // DBML has no view syntax: views are emitted as a fully commented block.
    const start = lines.length;
    const keyword = table.isView ? "View:" : "Table";
    const schemaPrefix = table.schema ? `${table.schema}.` : "";
    lines.push(`${keyword} ${schemaPrefix}${table.name} {`);

    for (const field of table.fields) {
      const type = field.type || "varchar";
      const attrs = buildAttributes(field);
      const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
      lines.push(`  ${field.name} ${type}${attrStr}`);
    }

    if (table.indexes.length > 0) {
      lines.push("");
      lines.push("  indexes {");
      for (const idx of table.indexes) {
        const cols =
          idx.columns.length === 1
            ? idx.columns[0]!
            : `(${idx.columns.join(", ")})`;
        const idxAttrs: string[] = [];
        if (idx.unique) idxAttrs.push("unique");
        if (idx.name) idxAttrs.push(`name: '${idx.name}'`);
        const idxAttrStr = idxAttrs.length > 0 ? ` [${idxAttrs.join(", ")}]` : "";
        lines.push(`    ${cols}${idxAttrStr}`);
      }
      lines.push("  }");
    }

    if (table.comment) {
      lines.push("");
      lines.push(`  Note: ${dbmlString(table.comment)}`);
    }

    lines.push("}");
    if (table.isView) {
      for (let i = start; i < lines.length; i++) {
        lines[i] = lines[i] ? `// ${lines[i]}` : "//";
      }
    }
    lines.push("");
  }

  // Relationships as standalone Ref lines
  const tablesById = new Map(diagram.tables.map((t) => [t.id, t]));
  for (const rel of diagram.relationships) {
    const srcTable = tablesById.get(rel.sourceTableId);
    const tgtTable = tablesById.get(rel.targetTableId);
    if (!srcTable || !tgtTable) continue;
    // Views are commented out, so a Ref to one would point at an unknown table.
    if (srcTable.isView || tgtTable.isView) continue;

    const srcField = srcTable.fields.find((f) => f.id === rel.sourceFieldId);
    const tgtField = tgtTable.fields.find((f) => f.id === rel.targetFieldId);
    if (!srcField || !tgtField) continue;

    // In DBML: source (FK side) > target (PK side) for many-to-one / one-to-many
    let symbol: string;
    switch (rel.cardinality) {
      case "one-to-one":
        symbol = "-";
        break;
      case "one-to-many":
        symbol = ">";
        break;
      case "many-to-many":
        symbol = "<>";
        break;
      default:
        symbol = ">";
    }

    lines.push(
      `Ref: ${srcTable.name}.${srcField.name} ${symbol} ${tgtTable.name}.${tgtField.name}`,
    );
  }

  return lines.join("\n");
}

function buildAttributes(field: {
  primaryKey: boolean;
  unique: boolean;
  nullable: boolean;
  default?: string;
  comment?: string;
}): string[] {
  const attrs: string[] = [];

  if (field.primaryKey) attrs.push("pk");
  if (field.unique && !field.primaryKey) attrs.push("unique");
  if (!field.nullable && !field.primaryKey) attrs.push("not null");
  if (field.default) attrs.push(`default: ${formatDefault(field.default)}`);
  if (field.comment) attrs.push(`note: ${dbmlString(field.comment)}`);

  return attrs;
}

/** DBML string literal: single-quoted with backslash escapes. */
function dbmlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const SQL_VALUE_KEYWORDS = new Set([
  "current_timestamp",
  "current_date",
  "current_time",
  "localtimestamp",
  "localtime",
  "current_user",
  "session_user",
]);

/**
 * Format a default value for DBML: numbers, booleans and null stay bare,
 * quoted SQL strings become escaped DBML strings, and anything else that looks
 * like an expression (function calls, casts, SQL keywords) goes in backticks.
 */
function formatDefault(raw: string): string {
  const value = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (/^(true|false|null)$/i.test(value)) return value.toLowerCase();

  const quoted = value.match(/^'((?:[^']|'')*)'$/) ?? value.match(/^"((?:[^"]|"")*)"$/);
  if (quoted) {
    const quote = value[0]!;
    return dbmlString(quoted[1]!.split(quote + quote).join(quote));
  }

  if (/[()]|::|[+*/|]/.test(value) || SQL_VALUE_KEYWORDS.has(value.toLowerCase())) {
    return `\`${value.replace(/`/g, "")}\``;
  }

  return dbmlString(value);
}
