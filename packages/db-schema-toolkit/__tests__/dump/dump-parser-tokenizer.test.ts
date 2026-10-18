import { describe, it, expect } from "vitest";
import { parseSQLDump } from "../../src/dump/dump-parser";

describe("parseSQLDump tokenizer", () => {
  it("parses unbalanced parentheses in linear time", () => {
    const evil = "(" + "(a".repeat(4000);
    const sql = `INSERT INTO t (a) VALUES ${evil};`;

    const start = performance.now();
    expect(() => parseSQLDump(sql)).not.toThrow();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it("ignores semicolons inside string values", () => {
    const sql = `INSERT INTO t (id, note) VALUES (1, 'a;b'), (2, 'c');`;
    const tables = parseSQLDump(sql);

    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toEqual([
      { id: 1, note: "a;b" },
      { id: 2, note: "c" },
    ]);
  });

  it("ignores parentheses inside string values", () => {
    const sql = `INSERT INTO t (id, note) VALUES (1, 'a)b'), (2, '(c'), (3, 'd');`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.rows).toEqual([
      { id: 1, note: "a)b" },
      { id: 2, note: "(c" },
      { id: 3, note: "d" },
    ]);
  });

  it("does not treat INSERT text inside a string as a statement", () => {
    const sql = `INSERT INTO logs (id, msg) VALUES (1, 'x; INSERT INTO fake (a) VALUES (9);');`;
    const tables = parseSQLDump(sql);

    expect(tables.map((t) => t.name)).toEqual(["logs"]);
    expect(tables[0]!.rows).toEqual([{ id: 1, msg: "x; INSERT INTO fake (a) VALUES (9);" }]);
  });

  it("does not treat INSERT inside a dollar-quoted function body as data", () => {
    const sql = `
      CREATE FUNCTION f() RETURNS void AS $$
      BEGIN
        INSERT INTO audit (id) VALUES (1);
      END;
      $$ LANGUAGE plpgsql;
      INSERT INTO users (id) VALUES (7);
    `;
    const tables = parseSQLDump(sql);

    expect(tables.map((t) => t.name)).toEqual(["users"]);
    expect(tables[0]!.rows).toEqual([{ id: 7 }]);
  });

  it("unescapes doubled single quotes", () => {
    const sql = `INSERT INTO t (id, note) VALUES (1, 'it''s'), (2, '''quoted''');`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.rows).toEqual([
      { id: 1, note: "it's" },
      { id: 2, note: "'quoted'" },
    ]);
  });

  it("unescapes backslash-escaped quotes and a trailing escaped backslash", () => {
    const sql = `INSERT INTO t (a, b) VALUES ('it\\'s', 'C:\\\\'), ('x', 'y');`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.rows).toEqual([
      { a: "it's", b: "C:\\" },
      { a: "x", b: "y" },
    ]);
  });

  it("keeps integers beyond 2^53 as strings", () => {
    const sql = `INSERT INTO t (id, neg, small, ratio) VALUES (9007199254740993, -9007199254740993, 42, 1.5);`;
    const row = parseSQLDump(sql)[0]!.rows[0]!;

    expect(row.id).toBe("9007199254740993");
    expect(row.neg).toBe("-9007199254740993");
    expect(row.small).toBe(42);
    expect(row.ratio).toBe(1.5);
  });

  it("names columns col_1..n when an INSERT has no column list and the table is unknown", () => {
    const sql = `INSERT INTO t VALUES (1, 'a'), (2, 'b');`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.columns).toEqual(["col_1", "col_2"]);
    expect(tables[0]!.rows).toEqual([
      { col_1: 1, col_2: "a" },
      { col_1: 2, col_2: "b" },
    ]);
  });

  it("uses CREATE TABLE columns for an INSERT without a column list", () => {
    const sql = `
      CREATE TABLE \`users\` (
        \`id\` int NOT NULL,
        \`name\` varchar(255) DEFAULT 'a,b',
        \`price\` decimal(10,2),
        PRIMARY KEY (\`id\`),
        KEY \`idx_name\` (\`name\`)
      ) ENGINE=InnoDB;
      INSERT INTO \`users\` VALUES (1, 'Alice', 9.99);
    `;
    const tables = parseSQLDump(sql);

    expect(tables).toHaveLength(1);
    expect(tables[0]!.columns).toEqual(["id", "name", "price"]);
    expect(tables[0]!.rows).toEqual([{ id: 1, name: "Alice", price: 9.99 }]);
  });

  it("reuses columns from an earlier INSERT on the same table", () => {
    const sql = `
      INSERT INTO t (id, name) VALUES (1, 'a');
      INSERT INTO t VALUES (2, 'b');
    `;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.columns).toEqual(["id", "name"]);
    expect(tables[0]!.rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("ignores apostrophes inside comments", () => {
    const sql = `
      -- don't break here
      /* it's a block comment; */
      INSERT INTO t (id) VALUES (1);
    `;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.rows).toEqual([{ id: 1 }]);
  });

  it("parses schema-qualified quoted table names", () => {
    const sql = `INSERT INTO "public"."users" ("id", "name") VALUES (1, 'a');`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.name).toBe("users");
    expect(tables[0]!.columns).toEqual(["id", "name"]);
  });

  it("keeps function calls and casts as raw text", () => {
    const sql = `INSERT INTO t (a, b) VALUES (now(), '1'::int);`;
    const row = parseSQLDump(sql)[0]!.rows[0]!;

    expect(row.a).toBe("now()");
    expect(row.b).toBe("'1'::int");
  });

  it("accumulates more rows than the spread argument limit", () => {
    const rowCount = 300_000;
    const sql = `INSERT INTO t (a) VALUES ${"(1),".repeat(rowCount - 1)}(1);`;
    const tables = parseSQLDump(sql);

    expect(tables[0]!.rows).toHaveLength(rowCount);
  });
});
