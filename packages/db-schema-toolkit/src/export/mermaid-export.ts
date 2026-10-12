import type { Diagram, DBTable } from "../domain";

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Mermaid attribute types are a single word: drop parameters such as `(10,2)`. */
function sanitizeType(type: string): string {
  const base = type.replace(/\(.*\)/g, "").trim().replace(/\s+/g, "_");
  const safe = base.replace(/[^a-zA-Z0-9_[\]]/g, "");
  return safe || "unknown";
}

/**
 * Give every table a unique Mermaid entity name: the bare name when it is
 * unique, `schema_name` when several schemas share it, and a numeric suffix as
 * a last resort.
 */
function buildEntityNames(tables: DBTable[]): Map<string, string> {
  const bareCounts = new Map<string, number>();
  for (const t of tables) {
    const bare = sanitize(t.name);
    bareCounts.set(bare, (bareCounts.get(bare) ?? 0) + 1);
  }

  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const t of tables) {
    const bare = sanitize(t.name);
    let candidate = (bareCounts.get(bare) ?? 0) > 1 && t.schema ? sanitize(`${t.schema}_${t.name}`) : bare;
    if (used.has(candidate)) {
      let n = 2;
      while (used.has(`${candidate}_${n}`)) n++;
      candidate = `${candidate}_${n}`;
    }
    used.add(candidate);
    names.set(t.id, candidate);
  }
  return names;
}

export function exportDiagramToMermaid(diagram: Diagram): string {
  const lines: string[] = [];
  const entityNames = buildEntityNames(diagram.tables);

  lines.push("erDiagram");

  for (const table of diagram.tables) {
    lines.push(`    ${entityNames.get(table.id)!} {`);
    for (const field of table.fields) {
      const type = sanitizeType(field.type);
      const safeFName = sanitize(field.name);
      const annotations: string[] = [];
      if (field.primaryKey) annotations.push("PK");
      if (field.isForeignKey) annotations.push("FK");
      if (field.unique && !field.primaryKey) annotations.push("UK");
      const annotStr = annotations.length > 0 ? ` "${annotations.join(",")}"` : "";
      lines.push(`        ${type} ${safeFName}${annotStr}`);
    }
    lines.push("    }");
  }

  const tablesById = new Map(diagram.tables.map((t) => [t.id, t]));
  for (const rel of diagram.relationships) {
    // source = child table (has FK), target = parent table (referenced)
    const srcTable = tablesById.get(rel.sourceTableId);
    const tgtTable = tablesById.get(rel.targetTableId);
    if (!srcTable || !tgtTable) continue;

    const childName = entityNames.get(srcTable.id)!;
    const parentName = entityNames.get(tgtTable.id)!;

    // Mermaid convention: parent (referenced) on left, child (FK) on right
    let relSymbol: string;
    switch (rel.cardinality) {
      case "one-to-one":
        relSymbol = "||--||";
        break;
      case "one-to-many":
        relSymbol = "||--o{";
        break;
      case "many-to-many":
        relSymbol = "}o--o{";
        break;
      default:
        relSymbol = "||--o{";
    }

    const srcField = srcTable.fields.find((f) => f.id === rel.sourceFieldId);
    const tgtField = tgtTable.fields.find((f) => f.id === rel.targetFieldId);
    const label = srcField && tgtField
      ? `${srcField.name} to ${tgtField.name}`
      : "relates";

    lines.push(`    ${parentName} ${relSymbol} ${childName} : "${label}"`);
  }

  return lines.join("\n");
}
