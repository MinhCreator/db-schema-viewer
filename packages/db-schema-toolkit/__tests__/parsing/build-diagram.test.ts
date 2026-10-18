import { describe, it, expect } from "vitest";
import { buildDiagram } from "../../src/parsing/build-diagram";
import type { Diagram, DBTable } from "../../src/domain";
import type { ParsedColumn, ParsedTable } from "../../src/parsing/types";

function col(
  name: string,
  overrides: Partial<ParsedColumn> = {},
): ParsedColumn {
  return {
    name,
    type: "integer",
    primaryKey: false,
    unique: false,
    nullable: true,
    ...overrides,
  };
}

function table(
  name: string,
  schema: string | undefined,
  columns: ParsedColumn[],
): ParsedTable {
  return { name, schema, columns, indexes: [], isView: false };
}

function findTable(diagram: Diagram, name: string, schema?: string): DBTable {
  const found = diagram.tables.find(
    (t) => t.name === name && t.schema === schema,
  );
  if (!found) throw new Error(`table ${schema ?? ""}.${name} not found`);
  return found;
}

function targetOf(diagram: Diagram, source: DBTable): DBTable[] {
  return diagram.relationships
    .filter((r) => r.sourceTableId === source.id)
    .map((r) => {
      const target = diagram.tables.find((t) => t.id === r.targetTableId);
      if (!target) throw new Error("dangling relationship");
      return target;
    });
}

describe("buildDiagram — schema-qualified table identity", () => {
  const authUsers = () =>
    table("users", "auth", [col("id", { primaryKey: true, nullable: false })]);
  const publicUsers = () =>
    table("users", "public", [col("id", { primaryKey: true, nullable: false })]);

  it("keeps same-named tables from different schemas as distinct tables", () => {
    const diagram = buildDiagram(
      [authUsers(), publicUsers()],
      [],
      "postgresql",
    );

    expect(diagram.tables).toHaveLength(2);
    const auth = findTable(diagram, "users", "auth");
    const pub = findTable(diagram, "users", "public");
    expect(auth.id).not.toBe(pub.id);
  });

  it("resolves an unqualified inline FK to the source table's schema first", () => {
    const diagram = buildDiagram(
      [
        publicUsers(),
        authUsers(),
        table("profiles", "public", [
          col("user_id", { references: { table: "users", column: "id" } }),
        ]),
        table("sessions", "auth", [
          col("user_id", { references: { table: "users", column: "id" } }),
        ]),
      ],
      [],
      "postgresql",
    );

    const profiles = findTable(diagram, "profiles", "public");
    const sessions = findTable(diagram, "sessions", "auth");
    expect(targetOf(diagram, profiles)).toEqual([
      findTable(diagram, "users", "public"),
    ]);
    expect(targetOf(diagram, sessions)).toEqual([
      findTable(diagram, "users", "auth"),
    ]);
  });

  it("resolves an explicitly schema-qualified inline FK to that schema", () => {
    const diagram = buildDiagram(
      [
        publicUsers(),
        authUsers(),
        table("profiles", "public", [
          col("user_id", { references: { table: "auth.users", column: "id" } }),
        ]),
      ],
      [],
      "postgresql",
    );

    const profiles = findTable(diagram, "profiles", "public");
    expect(targetOf(diagram, profiles)).toEqual([
      findTable(diagram, "users", "auth"),
    ]);
  });

  it("resolves schema-qualified explicit relationships without a duplicate edge", () => {
    const diagram = buildDiagram(
      [
        publicUsers(),
        authUsers(),
        table("profiles", "public", [col("user_id")]),
      ],
      [
        {
          sourceTable: "public.profiles",
          sourceColumn: "user_id",
          targetTable: "auth.users",
          targetColumn: "id",
        },
      ],
      "postgresql",
    );

    const profiles = findTable(diagram, "profiles", "public");
    expect(targetOf(diagram, profiles)).toEqual([
      findTable(diagram, "users", "auth"),
    ]);
    const field = profiles.fields.find((f) => f.name === "user_id");
    expect(field?.isForeignKey).toBe(true);
  });

  it("resolves an unqualified explicit relationship target in the source's schema", () => {
    const diagram = buildDiagram(
      [
        publicUsers(),
        authUsers(),
        table("profiles", "public", [col("user_id")]),
      ],
      [
        {
          sourceTable: "profiles",
          sourceColumn: "user_id",
          targetTable: "users",
          targetColumn: "id",
        },
      ],
      "postgresql",
    );

    const profiles = findTable(diagram, "profiles", "public");
    expect(targetOf(diagram, profiles)).toEqual([
      findTable(diagram, "users", "public"),
    ]);
  });

  it("falls back to the bare table name when the source schema has no match", () => {
    const diagram = buildDiagram(
      [
        authUsers(),
        table("orders", "sales", [
          col("user_id", { references: { table: "users", column: "id" } }),
        ]),
      ],
      [],
      "postgresql",
    );

    const orders = findTable(diagram, "orders", "sales");
    expect(targetOf(diagram, orders)).toEqual([
      findTable(diagram, "users", "auth"),
    ]);
  });

  it("resolves tables without a schema by name exactly as before", () => {
    const diagram = buildDiagram(
      [
        table("users", undefined, [col("id", { primaryKey: true })]),
        table("posts", undefined, [
          col("author_id", { references: { table: "Users", column: "ID" } }),
        ]),
      ],
      [],
      "sqlite",
    );

    const posts = findTable(diagram, "posts");
    expect(targetOf(diagram, posts)).toEqual([findTable(diagram, "users")]);
    expect(posts.fields[0]?.references).toEqual({ table: "Users", field: "ID" });
  });
});
