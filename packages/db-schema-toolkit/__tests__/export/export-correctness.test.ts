import { describe, it, expect } from "vitest";
import { exportDiagramToSQL } from "../../src/sql-export";
import { exportDiagramToDBML } from "../../src/export/dbml-export";
import { exportDiagramToMermaid } from "../../src/export/mermaid-export";
import { exportDiagramToPrisma } from "../../src/export/prisma-export";
import { exportDiagramToDrizzle } from "../../src/export/drizzle-export";
import { parseKyselySchema } from "../../src/kysely/kysely-parser";
import type { DatabaseType, DBField, DBTable, Diagram, DBRelationship } from "../../src/domain";

type FieldInput = Partial<DBField> & { name: string; type: string };

function field(tableName: string, input: FieldInput): DBField {
  return {
    id: `${tableName}.${input.name}`,
    primaryKey: false,
    unique: false,
    nullable: true,
    isForeignKey: false,
    ...input,
  };
}

function table(
  name: string,
  fields: FieldInput[],
  extra: Partial<Omit<DBTable, "fields">> = {},
): DBTable {
  const id = extra.schema ? `${extra.schema}.${name}` : name;
  return {
    id,
    name,
    fields: fields.map((f) => field(id, f)),
    indexes: [],
    x: 0,
    y: 0,
    isView: false,
    ...extra,
  };
}

function fk(source: DBTable, column: string, target: DBTable, targetColumn = "id"): DBRelationship {
  return {
    id: `${source.id}.${column}->${target.id}.${targetColumn}`,
    sourceTableId: source.id,
    sourceFieldId: `${source.id}.${column}`,
    targetTableId: target.id,
    targetFieldId: `${target.id}.${targetColumn}`,
    cardinality: "one-to-many",
  };
}

function diagram(
  tables: DBTable[],
  relationships: DBRelationship[],
  databaseType: DatabaseType = "postgresql",
): Diagram {
  return {
    id: "d",
    name: "test",
    databaseType,
    tables,
    relationships,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const users = table("users", [
  { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
  { name: "email", type: "VARCHAR(255)", unique: true, nullable: false },
]);
const messages = table("messages", [
  { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
  {
    name: "sender_id",
    type: "INTEGER",
    nullable: false,
    isForeignKey: true,
    references: { table: "users", field: "id" },
  },
  {
    name: "receiver_id",
    type: "INTEGER",
    nullable: false,
    isForeignKey: true,
    references: { table: "users", field: "id" },
  },
]);
const messagingDiagram = (db: DatabaseType = "postgresql") =>
  diagram([users, messages], [fk(messages, "sender_id", users), fk(messages, "receiver_id", users)], db);

function blockOf(output: string, header: string): string {
  const start = output.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = output.indexOf("\n}", start);
  return output.slice(start, end === -1 ? undefined : end + 2);
}

describe("SQL export correctness", () => {
  it("declares SQLite foreign keys inside CREATE TABLE instead of ALTER TABLE", () => {
    const sql = exportDiagramToSQL(messagingDiagram("sqlite"));
    expect(sql).not.toContain("ALTER TABLE");
    const create = sql.slice(sql.indexOf('CREATE TABLE "messages"'), sql.indexOf(");", sql.indexOf('CREATE TABLE "messages"')));
    expect(create).toContain('FOREIGN KEY ("sender_id") REFERENCES "users" ("id")');
    expect(create).toContain('FOREIGN KEY ("receiver_id") REFERENCES "users" ("id")');
  });

  it("prefixes foreign keys, indexes and comments with the table schema", () => {
    const appUsers = table(
      "users",
      [{ name: "id", type: "INTEGER", primaryKey: true, nullable: false, comment: "User id" }],
      { schema: "app", comment: "Accounts" },
    );
    const appPosts = table(
      "posts",
      [
        { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
        {
          name: "author_id",
          type: "INTEGER",
          isForeignKey: true,
          references: { table: "users", field: "id" },
        },
      ],
      { schema: "app", indexes: [{ id: "i", name: "idx_posts_author", columns: ["author_id"], unique: false }] },
    );
    const sql = exportDiagramToSQL(diagram([appUsers, appPosts], [fk(appPosts, "author_id", appUsers)]));

    expect(sql).toMatch(/ALTER TABLE "app"\."posts" ADD CONSTRAINT .* REFERENCES "app"\."users" \("id"\)/);
    expect(sql).toContain('CREATE INDEX "idx_posts_author" ON "app"."posts" ("author_id");');
    expect(sql).toContain(`COMMENT ON TABLE "app"."users" IS 'Accounts';`);
    expect(sql).toContain(`COMMENT ON COLUMN "app"."users"."id" IS 'User id';`);
  });

  it("never emits an empty CREATE TYPE ... AS ENUM ()", () => {
    const t = table("tickets", [
      { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
      { name: "status", type: "ENUM(Status)", nullable: false },
    ]);
    const sql = exportDiagramToSQL(diagram([t], []));
    expect(sql).not.toMatch(/AS ENUM \(\s*\)/);
    expect(sql).not.toMatch(/"status" ENUM\(Status\)/);
  });

  it("exports Kysely Generated<> columns as auto-increment rather than DEFAULT auto", () => {
    const parsed = parseKyselySchema(`
interface Database {
  users: UsersTable;
}

interface UsersTable {
  id: Generated<number>;
  name: string;
  created_at: Generated<Date>;
}
`);
    const pg = exportDiagramToSQL(parsed, "postgresql");
    expect(pg).not.toMatch(/DEFAULT auto\b/);
    expect(pg).toMatch(/"id" SERIAL NOT NULL/);
    expect(pg).toMatch(/"created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/);

    const mysql = exportDiagramToSQL(parsed, "mysql");
    expect(mysql).not.toMatch(/DEFAULT auto\b/);
    expect(mysql).toMatch(/`id` INTEGER NOT NULL AUTO_INCREMENT/);

    const sqlite = exportDiagramToSQL(parsed, "sqlite");
    expect(sqlite).not.toMatch(/DEFAULT auto\b/);
    expect(sqlite).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
  });
});

describe("DBML export correctness", () => {
  it("comments out every line of a view block", () => {
    const view = table("active_users", [{ name: "id", type: "INTEGER" }, { name: "email", type: "VARCHAR(255)" }], {
      isView: true,
    });
    const dbml = exportDiagramToDBML(diagram([users, view], []));
    const lines = dbml.split("\n");
    const start = lines.findIndex((l) => l.includes("View:") && l.includes("active_users"));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l.trim() === "// }");
    expect(end).toBeGreaterThan(start);
    for (const line of lines.slice(start, end + 1)) {
      expect(line.startsWith("//")).toBe(true);
    }
  });

  it("wraps expression defaults in backticks and escapes string defaults", () => {
    const t = table("accounts", [
      { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
      { name: "created_at", type: "TIMESTAMP", default: "now()" },
      { name: "updated_at", type: "TIMESTAMP", default: "CURRENT_TIMESTAMP" },
      { name: "status", type: "VARCHAR(20)", default: "'active'" },
      { name: "motto", type: "TEXT", default: "'it''s fine'" },
      { name: "balance", type: "INTEGER", default: "0" },
      { name: "enabled", type: "BOOLEAN", default: "true" },
    ]);
    const dbml = exportDiagramToDBML(diagram([t], []));
    expect(dbml).toContain("created_at TIMESTAMP [default: `now()`]");
    expect(dbml).toContain("updated_at TIMESTAMP [default: `CURRENT_TIMESTAMP`]");
    expect(dbml).toContain("status VARCHAR(20) [default: 'active']");
    expect(dbml).toContain("motto TEXT [default: 'it\\'s fine']");
    expect(dbml).toContain("balance INTEGER [default: 0]");
    expect(dbml).toContain("enabled BOOLEAN [default: true]");
  });
});

describe("Mermaid export correctness", () => {
  it("strips type parameters that Mermaid cannot parse", () => {
    const t = table("prices", [
      { name: "amount", type: "DECIMAL(10,2)" },
      { name: "label", type: "VARCHAR(255)" },
    ]);
    const mermaid = exportDiagramToMermaid(diagram([t], []));
    expect(mermaid).toContain("        DECIMAL amount");
    expect(mermaid).toContain("        VARCHAR label");
    expect(mermaid).not.toMatch(/DECIMAL10|,2/);
  });

  it("gives tables with the same name in different schemas distinct entity names", () => {
    const a = table("users", [{ name: "id", type: "INTEGER", primaryKey: true }], { schema: "auth" });
    const b = table("users", [{ name: "id", type: "INTEGER", primaryKey: true }], { schema: "public" });
    const c = table("posts", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "user_id", type: "INTEGER", isForeignKey: true },
    ]);
    const mermaid = exportDiagramToMermaid(diagram([a, b, c], [fk(c, "user_id", a)]));
    const entities = [...mermaid.matchAll(/^ {4}(\w+) \{$/gm)].map((m) => m[1]);
    expect(entities).toHaveLength(3);
    expect(new Set(entities).size).toBe(3);
    expect(mermaid).toContain('auth_users ||--o{ posts : "user_id to id"');
  });
});

describe("Prisma export correctness", () => {
  function modelFieldNames(prisma: string, model: string): string[] {
    return blockOf(prisma, `model ${model} {`)
      .split("\n")
      .slice(1, -1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)[0]!);
  }

  it("uses @@id for composite primary keys", () => {
    const courses = table("courses", [{ name: "id", type: "INTEGER", primaryKey: true, nullable: false }]);
    const enrollments = table("enrollments", [
      { name: "user_id", type: "INTEGER", primaryKey: true, nullable: false, isForeignKey: true },
      { name: "course_id", type: "INTEGER", primaryKey: true, nullable: false, isForeignKey: true },
    ]);
    const prisma = exportDiagramToPrisma(
      diagram([users, courses, enrollments], [fk(enrollments, "user_id", users), fk(enrollments, "course_id", courses)]),
    );
    const block = blockOf(prisma, "model Enrollment {");
    expect(block).toContain("@@id([userId, courseId])");
    expect(block).not.toMatch(/\s@id\b/);
  });

  it("singularizes model names correctly", () => {
    const courses = table("courses", [{ name: "id", type: "INTEGER", primaryKey: true, nullable: false }]);
    const classes = table("classes", [{ name: "id", type: "INTEGER", primaryKey: true, nullable: false }]);
    const statuses = table("statuses", [{ name: "id", type: "INTEGER", primaryKey: true, nullable: false }]);
    const prisma = exportDiagramToPrisma(diagram([courses, classes, statuses], []));
    expect(prisma).toContain("model Course {");
    expect(prisma).toContain("model Class {");
    expect(prisma).toContain("model Status {");
  });

  it("derives relation field names from FK columns without duplicates", () => {
    const prisma = exportDiagramToPrisma(messagingDiagram());
    const userFields = modelFieldNames(prisma, "User");
    const messageFields = modelFieldNames(prisma, "Message");
    expect(new Set(userFields).size).toBe(userFields.length);
    expect(new Set(messageFields).size).toBe(messageFields.length);
    expect(messageFields).toEqual(expect.arrayContaining(["sender", "receiver"]));
    expect(userFields).toEqual(expect.arrayContaining(["messagesAsSender", "messagesAsReceiver"]));
  });

  it("does not reuse the target table name for FK columns without an Id suffix", () => {
    const posts = table("posts", [
      { name: "id", type: "INTEGER", primaryKey: true, nullable: false },
      { name: "created_by", type: "INTEGER", isForeignKey: true },
      { name: "updated_by", type: "INTEGER", isForeignKey: true },
    ]);
    const prisma = exportDiagramToPrisma(
      diagram([users, posts], [fk(posts, "created_by", users), fk(posts, "updated_by", users)]),
    );
    const postFields = modelFieldNames(prisma, "Post");
    expect(new Set(postFields).size).toBe(postFields.length);
    expect(postFields).not.toContain("users");
  });
});

describe("Drizzle export correctness", () => {
  it("imports sql from drizzle-orm when a sql`` default is emitted", () => {
    const t = table("tokens", [{ name: "id", type: "UUID", primaryKey: true, nullable: false, default: "gen_random_uuid()" }]);
    const drizzle = exportDiagramToDrizzle(diagram([t], []));
    expect(drizzle).toContain("sql`gen_random_uuid()`");
    expect(drizzle).toContain('import { sql } from "drizzle-orm";');
  });

  it("does not import sql when it is unused", () => {
    const drizzle = exportDiagramToDrizzle(diagram([users], []));
    expect(drizzle).not.toContain('from "drizzle-orm";');
  });
});
