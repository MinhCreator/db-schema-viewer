import type { Diagram, Cardinality } from "../domain";
import type { ParsedColumn, ParsedRelationship } from "../parsing/types";
import { buildDiagram } from "../parsing/build-diagram";
import { extractBraceBlock } from "../parsing/extract-brace-block";
import { resolveClassInheritance } from "../parsing/inline-helpers";

type EntityColumn = ParsedColumn & { cardinality?: Cardinality };

/** Owner side of a @ManyToMany with @JoinTable: the join table TypeORM creates. */
interface JoinTableSpec {
  propertyName: string;
  targetClass: string;
  options: string;
}

interface TypeORMEntity {
  className: string;
  tableName: string;
  columns: EntityColumn[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  joinTables: JoinTableSpec[];
}

/**
 * Parse TypeORM entity definitions from TypeScript source into a Diagram.
 * Uses regex-based parsing since we can't run TypeScript in the browser.
 */
export function parseTypeORMSchema(content: string, name?: string): Diagram {
  const entities = extractEntities(content);

  // Build className → tableName map for resolving FK references
  const classToTable = new Map<string, string>();
  for (const entity of entities) {
    classToTable.set(entity.className, entity.tableName);
  }

  entities.push(...buildJoinTables(entities, classToTable));

  // Convert to shared types, resolving class names to table names
  const parsedTables = entities.map((entity) => ({
    name: entity.tableName,
    columns: entity.columns.map((col) => {
      const resolved = col.references
        ? {
            table: classToTable.get(col.references.table) || col.references.table,
            column: col.references.column,
          }
        : undefined;
      return {
        name: col.name,
        type: col.type,
        primaryKey: col.primaryKey,
        unique: col.unique,
        nullable: col.nullable,
        default: col.default,
        comment: col.comment,
        references: resolved,
      };
    }),
    indexes: entity.indexes,
    isView: false,
  }));

  // Build explicit relationships from FK columns (TypeORM resolves to PK)
  const relationships: ParsedRelationship[] = [];
  for (const entity of entities) {
    for (const col of entity.columns) {
      if (!col.references) continue;

      const resolvedTargetTable =
        classToTable.get(col.references.table) || col.references.table;

      // TypeORM FK → target PK. Find the target entity's PK field name.
      const targetEntity = entities.find(
        (e) =>
          e.className === col.references!.table ||
          e.tableName === resolvedTargetTable,
      );
      const targetPKName = targetEntity?.columns.find((c) => c.primaryKey)?.name;

      relationships.push({
        sourceTable: entity.tableName,
        sourceColumn: col.name,
        targetTable: resolvedTargetTable,
        targetColumn: targetPKName || col.references.column,
        cardinality: col.cardinality,
      });
    }
  }

  return buildDiagram(parsedTables, relationships, "postgresql", name ?? "TypeORM Schema");
}

// ── Entity extraction ──────────────────────────────────────────────

function extractEntities(content: string): TypeORMEntity[] {
  const entities: TypeORMEntity[] = [];

  // Extract all class bodies for inheritance resolution (AST-based when available)
  const classBodies = resolveClassInheritance(content);

  const entityRegex =
    /@Entity\s*\(\s*(?:["'`](\w+)["'`]|(\{[^}]*\}))?\s*\)\s*(?:@\w+(?:\s*\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*)*(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;

  let match;
  while ((match = entityRegex.exec(content)) !== null) {
    const entityDecoTableName = match[1];
    const entityOpts = match[2];
    const className = match[3]!;
    const parentClassName = match[4];

    let tableName = className;
    if (entityDecoTableName) {
      tableName = entityDecoTableName;
    } else if (entityOpts) {
      const nameMatch = entityOpts.match(/name\s*:\s*["'`](\w+)["'`]/);
      if (nameMatch) {
        tableName = nameMatch[1]!;
      }
    }

    // Find the opening brace of the class body
    let braceStart = -1;
    for (let i = match.index + match[0].length; i < content.length; i++) {
      if (content[i] === "{") {
        braceStart = i;
        break;
      }
    }
    if (braceStart === -1) continue;

    let body = extractBraceBlock(content, braceStart);
    if (!body) continue;

    // Merge parent class columns if this entity extends another class
    if (parentClassName) {
      const parentBody = classBodies.get(parentClassName);
      if (parentBody) {
        body = parentBody + "\n" + body;
      }
    }

    const { columns, joinTables } = parseEntityColumns(body);
    const indexes = parseEntityIndexes(
      content,
      match.index,
      match.index + match[0].length,
    );

    entities.push({ className, tableName, columns, indexes, joinTables });
  }

  return entities;
}


// ── Column parsing ─────────────────────────────────────────────────

function parseEntityColumns(body: string): { columns: EntityColumn[]; joinTables: JoinTableSpec[] } {
  const columns: EntityColumn[] = [];
  const joinTables: JoinTableSpec[] = [];
  // A @ManyToOne join column often repeats as a plain @Column: merge them by name.
  const byName = new Map<string, { column: EntityColumn; explicit: boolean }>();

  const propertyRegex =
    /((?:@\w+(?:\s*\([^()]*(?:\([^()]*\)[^()]*)*\))\s*)+)\s*(\w+)\s*(?:!|(?:\?))?\s*:\s*([^;\n]+);?/g;

  let match;
  while ((match = propertyRegex.exec(body)) !== null) {
    const decorators = match[1]!;
    const fieldName = match[2]!;
    const tsType = match[3]!.trim();

    const manyToMany = /@ManyToMany\s*\(\s*(?:\(\s*\)\s*=>\s*)?(\w+)/.exec(decorators);
    if (manyToMany && /@JoinTable\s*\(/.test(decorators)) {
      joinTables.push({
        propertyName: fieldName,
        targetClass: manyToMany[1]!,
        options: decoratorArgs(decorators, "JoinTable") ?? "",
      });
    }

    // Skip relation fields that don't create columns
    const isRelation = /@(?:OneToMany|ManyToMany)\s*\(/.test(decorators);
    if (isRelation) continue;

    const isManyToOne = /@ManyToOne\s*\(/.test(decorators);
    const isOneToOne = /@OneToOne\s*\(/.test(decorators);
    const hasJoinColumn = /@JoinColumn\s*\(/.test(decorators);

    if (isOneToOne && !hasJoinColumn) continue;

    const isPrimaryGenerated = /@PrimaryGeneratedColumn\s*\(/.test(decorators);
    const isPrimaryColumn = /@PrimaryColumn\s*\(/.test(decorators);
    const isPK = isPrimaryGenerated || isPrimaryColumn;

    const isCreateDate = /@CreateDateColumn\s*\(/.test(decorators);
    const isUpdateDate = /@UpdateDateColumn\s*\(/.test(decorators);
    const isDeleteDate = /@DeleteDateColumn\s*\(/.test(decorators);
    const isDateColumn = isCreateDate || isUpdateDate || isDeleteDate;

    const isColumn = /@Column\s*\(/.test(decorators);

    if (!isPK && !isColumn && !isDateColumn && !isManyToOne && !isOneToOne)
      continue;

    // Resolve column type and options
    let colType = mapTSTypeToSQL(tsType);
    let nullable = false;
    let unique = false;
    let defaultValue: string | undefined;
    let columnName = fieldName;

    if (isPrimaryGenerated) {
      const pgMatch = decorators.match(
        /@PrimaryGeneratedColumn\s*\(\s*["'`](\w+)["'`]?\s*\)/,
      );
      colType = pgMatch && pgMatch[1] === "uuid" ? "UUID" : "INTEGER";
    }

    if (isPrimaryColumn) {
      const pcMatch = decorators.match(
        /@PrimaryColumn\s*\(\s*(?:\{([^}]*)\}|["'`](\w+)["'`])?\s*\)/,
      );
      if (pcMatch) {
        if (pcMatch[2]) {
          colType = pcMatch[2].toUpperCase();
        } else if (pcMatch[1]) {
          const typeMatch = pcMatch[1].match(/type\s*:\s*["'`](\w+)["'`]/);
          if (typeMatch) colType = typeMatch[1]!.toUpperCase();
        }
      }
    }

    if (isDateColumn) {
      colType = "TIMESTAMP";
      if (isDeleteDate) nullable = true;
    }

    // name option of the primary key and date decorators (@Column is handled below)
    for (const decorator of ["PrimaryGeneratedColumn", "PrimaryColumn", "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn"]) {
      const optionName = /\bname\s*:\s*["'`](\w+)["'`]/.exec(decoratorArgs(decorators, decorator) ?? "")?.[1];
      if (optionName) columnName = optionName;
    }

    if (isColumn) {
      const colOptMatch = decorators.match(
        /@Column\s*\(\s*(?:\{([^}]*)\}|["'`](\w+)["'`])?\s*\)/,
      );
      if (colOptMatch) {
        if (colOptMatch[2]) {
          colType = colOptMatch[2].toUpperCase();
        } else if (colOptMatch[1]) {
          const opts = colOptMatch[1];

          const typeMatch = opts.match(/type\s*:\s*["'`](\w+)["'`]/);
          if (typeMatch) colType = typeMatch[1]!.toUpperCase();

          const lengthMatch = opts.match(/length\s*:\s*(\d+)/);
          if (lengthMatch) {
            colType =
              colType === "VARCHAR"
                ? `VARCHAR(${lengthMatch[1]})`
                : `${colType}(${lengthMatch[1]})`;
          }

          if (/nullable\s*:\s*true/.test(opts)) nullable = true;
          if (/unique\s*:\s*true/.test(opts)) unique = true;

          const defaultMatch = opts.match(
            /default\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/,
          );
          if (defaultMatch) {
            let val = defaultMatch[1]!.trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            defaultValue = val;
          }

          const nameMatch = opts.match(/name\s*:\s*["'`](\w+)["'`]/);
          if (nameMatch) columnName = nameMatch[1]!;
        }
      }
    }

    // Handle ManyToOne / OneToOne FK columns
    let references: ParsedColumn["references"] | undefined;
    let cardinality: Cardinality | undefined;

    if (isManyToOne || (isOneToOne && hasJoinColumn)) {
      cardinality = isManyToOne ? "one-to-many" : "one-to-one";

      const relMatch = decorators.match(
        /@(?:ManyToOne|OneToOne)\s*\(\s*\(\)\s*=>\s*(\w+)/,
      );
      if (relMatch) {
        references = {
          table: relMatch[1]!,
          column: "id", // Convention: FK references 'id' by default
        };
      }

      const joinColMatch = decorators.match(
        /@JoinColumn\s*\(\s*\{([^}]*)\}\s*\)/,
      );
      if (joinColMatch) {
        const jcNameMatch = joinColMatch[1]!.match(
          /name\s*:\s*["'`](\w+)["'`]/,
        );
        if (jcNameMatch) {
          columnName = jcNameMatch[1]!;
        }
      }

      if (!isColumn) {
        colType = "INTEGER";
      }
    }

    const column: EntityColumn = {
      name: columnName,
      type: colType,
      primaryKey: isPK,
      unique: unique || isPK,
      nullable: isPK ? false : nullable,
      default: defaultValue,
      references,
      cardinality,
    };
    const explicit = isColumn || isPK || isDateColumn;
    const existing = byName.get(columnName);
    if (!existing) {
      byName.set(columnName, { column, explicit });
      columns.push(column);
      continue;
    }
    // The explicit @Column carries type and nullability; the relation carries the FK.
    const primary = existing.explicit || !explicit ? existing.column : column;
    const secondary = primary === column ? existing.column : column;
    Object.assign(existing.column, {
      ...primary,
      primaryKey: primary.primaryKey || secondary.primaryKey,
      unique: primary.unique || secondary.unique,
      references: primary.references ?? secondary.references,
      cardinality: primary.cardinality ?? secondary.cardinality,
    });
    existing.explicit = existing.explicit || explicit;
  }

  return { columns, joinTables };
}

/** Raw arguments of the first `@Name(...)` in a decorator list. */
function decoratorArgs(decorators: string, name: string): string | undefined {
  const start = new RegExp(`@${name}\\s*\\(`).exec(decorators);
  if (!start) return undefined;
  let depth = 1;
  const from = start.index + start[0].length;
  for (let i = from; i < decorators.length; i++) {
    const ch = decorators[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return decorators.slice(from, i);
  }
  return undefined;
}

// ── Join tables ────────────────────────────────────────────────────

/** TypeORM's DefaultNamingStrategy camelCase: `questions_id` → `questionsId`. */
function camelCase(value: string): string {
  return value.replace(/_([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

function joinColumnOption(options: string, key: "joinColumn" | "inverseJoinColumn", option: string): string | undefined {
  const block = new RegExp(`\\b${key}\\s*:\\s*\\{([^}]*)\\}`).exec(options)?.[1];
  return block ? new RegExp(`\\b${option}\\s*:\\s*["'\`](\\w+)["'\`]`).exec(block)?.[1] : undefined;
}

function buildJoinTables(entities: TypeORMEntity[], classToTable: Map<string, string>): TypeORMEntity[] {
  const byClass = new Map(entities.map((e) => [e.className, e]));
  const joins: TypeORMEntity[] = [];

  for (const owner of entities) {
    for (const spec of owner.joinTables) {
      const target = byClass.get(spec.targetClass);
      const targetTable = classToTable.get(spec.targetClass) ?? spec.targetClass;
      const tableName = /\bname\s*:\s*["'`](\w+)["'`]/.exec(
        spec.options.replace(/\b(?:joinColumn|inverseJoinColumn)\s*:\s*\{[^}]*\}/g, ""),
      )?.[1] ?? `${owner.tableName}_${spec.propertyName}_${targetTable}`;

      const side = (entity: TypeORMEntity | undefined, table: string, key: "joinColumn" | "inverseJoinColumn"): EntityColumn => {
        const referenced = joinColumnOption(spec.options, key, "referencedColumnName")
          ?? entity?.columns.find((c) => c.primaryKey)?.name
          ?? "id";
        const type = entity?.columns.find((c) => c.name === referenced)?.type ?? "INTEGER";
        return {
          name: joinColumnOption(spec.options, key, "name") ?? camelCase(`${table}_${referenced}`),
          type,
          primaryKey: true,
          unique: false,
          nullable: false,
          references: { table, column: referenced },
          cardinality: "one-to-many",
        };
      };

      joins.push({
        className: tableName,
        tableName,
        columns: [side(owner, owner.tableName, "joinColumn"), side(target, targetTable, "inverseJoinColumn")],
        indexes: [],
        joinTables: [],
      });
    }
  }
  return joins;
}

// ── Index parsing ──────────────────────────────────────────────────

function parseEntityIndexes(
  content: string,
  entityStart: number,
  entityHeaderEnd: number,
): { name: string; columns: string[]; unique: boolean }[] {
  const indexes: { name: string; columns: string[]; unique: boolean }[] = [];

  // Class-level @Index decorators may sit before @Entity or between it and `class`
  const before = content.substring(
    Math.max(0, entityStart - 500),
    entityHeaderEnd,
  );

  const indexRegex =
    /@Index\s*\(\s*(?:["'`](\w+)["'`]\s*,\s*)?\[([^\]]*)\](?:\s*,\s*\{([^}]*)\})?\s*\)/g;
  let idxMatch;
  while ((idxMatch = indexRegex.exec(before)) !== null) {
    const idxName = idxMatch[1] || `idx_${indexes.length}`;
    const cols = idxMatch[2]!
      .split(",")
      .map((s) => s.trim().replace(/["'`]/g, ""))
      .filter(Boolean);
    const opts = idxMatch[3] || "";
    const isUnique = /unique\s*:\s*true/.test(opts);

    indexes.push({ name: idxName, columns: cols, unique: isUnique });
  }

  return indexes;
}

// ── Type mapping ──────────────────────────────────────────────────

function mapTSTypeToSQL(tsType: string): string {
  const cleanType = tsType.replace(/\[\]$/, "").replace(/<.*>/, "").trim();

  const map: Record<string, string> = {
    string: "VARCHAR",
    number: "INTEGER",
    boolean: "BOOLEAN",
    Date: "TIMESTAMP",
    bigint: "BIGINT",
    Buffer: "BYTEA",
  };

  return map[cleanType] || "VARCHAR";
}
