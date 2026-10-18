/**
 * Round-trip tests: export a diagram, re-parse the output with the matching
 * parser, and check that tables, columns and foreign keys survive.
 */
import { describe, it, expect } from "vitest";
import { exportDiagramToSQL } from "../../src/sql-export";
import { exportDiagramToDBML } from "../../src/export/dbml-export";
import { exportDiagramToPrisma } from "../../src/export/prisma-export";
import { exportDiagramToDrizzle } from "../../src/export/drizzle-export";
import { parseSQLWithType } from "../../src/sql/sql-import";
import { parseDBMLSchema } from "../../src/dbml/dbml-parser";
import { parsePrismaSchema } from "../../src/prisma/prisma-parser";
import { parseDrizzleSchema } from "../../src/drizzle/drizzle-parser";
import type { DatabaseType, Diagram } from "../../src/domain";

const SOURCE_SQL = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  body TEXT
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL
);
`;

interface Shape {
  tables: Record<string, string[]>;
  foreignKeys: string[];
}

/** Table and column names, normalised so camelCase and snake_case compare equal. */
function shapeOf(diagram: Diagram): Shape {
  const norm = (s: string) => s.replace(/_/g, "").toLowerCase();
  const tables: Record<string, string[]> = {};
  for (const t of diagram.tables) {
    tables[norm(t.name)] = t.fields.map((f) => norm(f.name)).sort();
  }
  const foreignKeys = diagram.relationships
    .map((r) => {
      const src = diagram.tables.find((t) => t.id === r.sourceTableId);
      const tgt = diagram.tables.find((t) => t.id === r.targetTableId);
      const sf = src?.fields.find((f) => f.id === r.sourceFieldId);
      const tf = tgt?.fields.find((f) => f.id === r.targetFieldId);
      if (!src || !tgt || !sf || !tf) return "";
      return `${norm(src.name)}.${norm(sf.name)}->${norm(tgt.name)}.${norm(tf.name)}`;
    })
    .filter(Boolean)
    .sort();
  return { tables, foreignKeys };
}

function source(db: DatabaseType = "postgresql"): Diagram {
  return { ...parseSQLWithType(SOURCE_SQL, "postgresql"), databaseType: db };
}

describe("export round-trips", () => {
  const expected = shapeOf(source());

  it("source fixture has the expected shape", () => {
    expect(Object.keys(expected.tables).sort()).toEqual(["comments", "posts", "users"]);
    expect(expected.foreignKeys).toEqual([
      "comments.postid->posts.id",
      "comments.userid->users.id",
      "posts.authorid->users.id",
    ]);
  });

  for (const db of ["postgresql", "mysql", "sqlite"] as const) {
    it(`SQL (${db})`, () => {
      const sql = exportDiagramToSQL(source(db), db);
      expect(shapeOf(parseSQLWithType(sql, db))).toEqual(expected);
    });
  }

  it("DBML", () => {
    const dbml = exportDiagramToDBML(source());
    expect(shapeOf(parseDBMLSchema(dbml))).toEqual(expected);
  });

  it("Prisma", () => {
    const prisma = exportDiagramToPrisma(source());
    expect(shapeOf(parsePrismaSchema(prisma))).toEqual(expected);
  });

  it("Drizzle", () => {
    const drizzle = exportDiagramToDrizzle(source());
    expect(shapeOf(parseDrizzleSchema(drizzle))).toEqual(expected);
  });
});
