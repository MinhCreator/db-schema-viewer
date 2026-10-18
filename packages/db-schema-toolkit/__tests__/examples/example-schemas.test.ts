import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseSchemaFile } from "../../src/parsing/parse-schema-file";

const EXAMPLES_DIR = resolve(__dirname, "../../../../examples");

function readExample(filename: string): string {
  return readFileSync(resolve(EXAMPLES_DIR, filename), "utf-8");
}

describe("example schemas", () => {
  describe("Drizzle ORM (schema.drizzle.ts)", () => {
    const content = readExample("schema.drizzle.ts");
    const diagram = parseSchemaFile(content, "schema.drizzle.ts");

    it("detects as PostgreSQL", () => {
      expect(diagram.databaseType).toBe("postgresql");
    });

    it("parses all 12 tables", () => {
      expect(diagram.tables).toHaveLength(12);
    });

    it("finds expected table names", () => {
      const names = diagram.tables.map((t) => t.name).sort();
      expect(names).toEqual([
        "bookmarks",
        "comments",
        "conversation_participants",
        "conversations",
        "follows",
        "hashtags",
        "likes",
        "messages",
        "notifications",
        "post_hashtags",
        "posts",
        "users",
      ]);
    });

    it("parses users table fields", () => {
      const users = diagram.tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      expect(users!.fields.length).toBeGreaterThanOrEqual(10);
      const id = users!.fields.find((f) => f.name === "id");
      expect(id?.primaryKey).toBe(true);
    });

    it("finds relationships", () => {
      expect(diagram.relationships.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("Prisma (schema.prisma)", () => {
    const content = readExample("schema.prisma");
    const diagram = parseSchemaFile(content, "schema.prisma");

    it("parses all 12 models", () => {
      expect(diagram.tables).toHaveLength(12);
    });

    it("finds expected table names (uses @@map names)", () => {
      const names = diagram.tables.map((t) => t.name).sort();
      expect(names).toEqual([
        "bookmarks",
        "comments",
        "conversation_participants",
        "conversations",
        "follows",
        "hashtags",
        "likes",
        "messages",
        "notifications",
        "post_hashtags",
        "posts",
        "users",
      ]);
    });

    it("parses users model fields", () => {
      const user = diagram.tables.find((t) => t.name === "users");
      expect(user).toBeDefined();
      expect(user!.fields.length).toBeGreaterThanOrEqual(10);
    });

    it("finds relationships", () => {
      expect(diagram.relationships.length).toBeGreaterThanOrEqual(9);
    });
  });

  describe("DBML (schema.dbml)", () => {
    const content = readExample("schema.dbml");
    const diagram = parseSchemaFile(content, "schema.dbml");

    it("parses all 12 tables", () => {
      expect(diagram.tables).toHaveLength(12);
    });

    it("finds expected table names", () => {
      const names = diagram.tables.map((t) => t.name).sort();
      expect(names).toEqual([
        "bookmarks",
        "comments",
        "conversation_participants",
        "conversations",
        "follows",
        "hashtags",
        "likes",
        "messages",
        "notifications",
        "post_hashtags",
        "posts",
        "users",
      ]);
    });

    it("parses users table fields", () => {
      const users = diagram.tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      expect(users!.fields.length).toBeGreaterThanOrEqual(10);
    });

    it("finds relationships", () => {
      expect(diagram.relationships.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("TypeORM (schema.typeorm.ts)", () => {
    const content = readExample("schema.typeorm.ts");
    const diagram = parseSchemaFile(content, "schema.typeorm.ts");

    it("parses tables", () => {
      expect(diagram.tables.length).toBeGreaterThanOrEqual(7);
    });

    it("finds users table", () => {
      const users = diagram.tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      expect(users!.fields.length).toBeGreaterThanOrEqual(8);
    });

    it("finds relationships", () => {
      expect(diagram.relationships.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("cross-format consistency", () => {
    // The four examples describe the same schema, so they must parse to the same shape.
    function shape(filename: string) {
      const diagram = parseSchemaFile(readExample(filename), filename);
      const byId = new Map(diagram.tables.map((t) => [t.id, t]));
      const fieldName = (tableId: string, fieldId: string) =>
        `${byId.get(tableId)!.name}.${byId.get(tableId)!.fields.find((f) => f.id === fieldId)!.name}`;
      return {
        columns: diagram.tables.flatMap((t) => t.fields.map((f) => `${t.name}.${f.name}`)).sort(),
        relationships: diagram.relationships
          .map((r) => `${fieldName(r.sourceTableId, r.sourceFieldId)} -> ${fieldName(r.targetTableId, r.targetFieldId)}`)
          .sort(),
      };
    }

    const reference = shape("schema.prisma");

    it.each(["schema.dbml", "schema.drizzle.ts"])("%s matches the Prisma example", (filename) => {
      const other = shape(filename);
      expect(other.columns).toEqual(reference.columns);
      expect(other.relationships).toEqual(reference.relationships);
    });

    it("schema.typeorm.ts matches the Prisma example", () => {
      const other = shape("schema.typeorm.ts");
      // TypeORM derives post_hashtags from @JoinTable, which has no surrogate id;
      // the Prisma example declares it as a model with one.
      expect(other.columns).toEqual(reference.columns.filter((c) => c !== "post_hashtags.id"));
      expect(other.relationships).toEqual(reference.relationships);
    });
  });
});
