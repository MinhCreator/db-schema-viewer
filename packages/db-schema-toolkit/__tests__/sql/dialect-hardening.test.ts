import { describe, it, expect } from "vitest";
import { parseSQLWithType } from "../../src/sql/sql-import";
import { detectDatabaseType } from "../../src/sql/detect-db-type";
import type { Diagram } from "../../src/domain";

function field(diagram: Diagram, table: string, name: string) {
  const t = diagram.tables.find((tbl) => tbl.name === table);
  return t?.fields.find((f) => f.name === name);
}

describe("node-sql-parser dialect: statement splitting", () => {
  it("does not split on semicolons inside string literals", () => {
    const sql = `
      CREATE TABLE notes (id INT PRIMARY KEY, body TEXT DEFAULT 'a;b');
      CREATE TABLE tags (id INT PRIMARY KEY);
    `;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(diagram.tables.map((t) => t.name).sort()).toEqual(["notes", "tags"]);
    expect(field(diagram, "notes", "body")?.default).toBe("a;b");
  });

  it("does not split on semicolons inside quoted identifiers", () => {
    const sql = `
      CREATE TABLE "odd;name" (id INT PRIMARY KEY);
      CREATE TABLE tags (id INT PRIMARY KEY);
    `;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(diagram.tables.map((t) => t.name).sort()).toEqual(["odd;name", "tags"]);
  });

  it("does not split inside PostgreSQL dollar-quoted bodies", () => {
    const sql = `
      CREATE FUNCTION touch() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TABLE users (id INT PRIMARY KEY, updated_at TIMESTAMP);
    `;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(diagram.tables.map((t) => t.name)).toEqual(["users"]);
  });
});

describe("node-sql-parser dialect: types and defaults", () => {
  it("keeps precision and scale of DECIMAL(10,2)", () => {
    const sql = `CREATE TABLE products (id INT PRIMARY KEY, price DECIMAL(10,2) NOT NULL);`;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(field(diagram, "products", "price")?.type).toBe("DECIMAL(10,2)");
  });

  it("keeps precision and scale of DECIMAL(10,2) in MySQL", () => {
    const sql = `CREATE TABLE products (id INT PRIMARY KEY, price DECIMAL(10,2) NOT NULL);`;
    const diagram = parseSQLWithType(sql, "mysql");
    expect(field(diagram, "products", "price")?.type).toBe("DECIMAL(10,2)");
  });

  it("reads a string literal default", () => {
    const sql = `CREATE TABLE accounts (id INT PRIMARY KEY, status VARCHAR(20) DEFAULT 'active');`;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(field(diagram, "accounts", "status")?.default).toBe("active");
  });

  it("reads a function call default", () => {
    const sql = `CREATE TABLE accounts (id INT PRIMARY KEY, created_at TIMESTAMP DEFAULT now());`;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(field(diagram, "accounts", "created_at")?.default?.toLowerCase()).toBe("now()");
  });
});

describe("node-sql-parser dialect: pg_dump ALTER TABLE ONLY", () => {
  it("extracts foreign keys from ALTER TABLE ONLY", () => {
    const sql = `
      CREATE TABLE public.users (id integer NOT NULL, email text);
      CREATE TABLE public.posts (id integer NOT NULL, user_id integer);
      ALTER TABLE ONLY public.posts
          ADD CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
    `;
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(diagram.relationships).toHaveLength(1);
    expect(field(diagram, "posts", "user_id")?.isForeignKey).toBe(true);
  });
});

describe("regex dialect", () => {
  it("parses backticked table names containing dashes", () => {
    const sql = `
      CREATE TABLE \`my-project.analytics.events\` (
        event_id INT64 NOT NULL,
        name STRING
      );
    `;
    const diagram = parseSQLWithType(sql, "bigquery");
    expect(diagram.tables).toHaveLength(1);
    expect(diagram.tables[0]!.name).toBe("events");
    expect(diagram.tables[0]!.schema).toBe("my-project");
    expect(diagram.tables[0]!.fields.map((f) => f.name)).toEqual(["event_id", "name"]);
  });

  it("parses separately backticked qualified names containing dashes", () => {
    const sql = `
      CREATE TABLE \`my-project\`.analytics.\`page-views\` (
        id INT64
      );
    `;
    const diagram = parseSQLWithType(sql, "bigquery");
    expect(diagram.tables).toHaveLength(1);
    expect(diagram.tables[0]!.name).toBe("page-views");
    expect(diagram.tables[0]!.schema).toBe("my-project");
  });

  it("keeps parsing columns after a Snowflake virtual column AS (...)", () => {
    const sql = `
      CREATE TABLE order_lines (
        price NUMBER(10,2),
        qty NUMBER(38,0),
        total NUMBER(10,2) AS (price * qty),
        note VARCHAR(100)
      );
    `;
    const diagram = parseSQLWithType(sql, "snowflake");
    expect(diagram.tables).toHaveLength(1);
    expect(diagram.tables[0]!.fields.map((f) => f.name)).toEqual(["price", "qty", "total", "note"]);
  });

  it("keeps parsing columns after a Snowflake WITH MASKING POLICY clause", () => {
    const sql = `
      CREATE TABLE customers (
        id NUMBER(38,0) NOT NULL,
        email VARCHAR(255) WITH MASKING POLICY mask_email,
        country VARCHAR(2)
      );
    `;
    const diagram = parseSQLWithType(sql, "snowflake");
    expect(diagram.tables[0]!.fields.map((f) => f.name)).toEqual(["id", "email", "country"]);
  });

  it("does not split columns inside STRUCT<...> and ARRAY<...>", () => {
    const sql = `
      CREATE TABLE dataset.sessions (
        id INT64 NOT NULL,
        device STRUCT<os STRING, version INT64>,
        hits ARRAY<STRUCT<page STRING, ts TIMESTAMP>>,
        tags ARRAY<STRING>
      );
    `;
    const diagram = parseSQLWithType(sql, "bigquery");
    const fields = diagram.tables[0]!.fields;
    expect(fields.map((f) => f.name)).toEqual(["id", "device", "hits", "tags"]);
    expect(fields[0]!.type).toBe("INT64");
    expect(fields[0]!.nullable).toBe(false);
    expect(fields[1]!.type).toBe("STRUCT<os STRING, version INT64>");
    expect(fields[2]!.type).toBe("ARRAY<STRUCT<page STRING, ts TIMESTAMP>>");
    expect(fields[3]!.type).toBe("ARRAY<STRING>");
  });

  it("extracts inline REFERENCES on columns", () => {
    const sql = `
      CREATE TABLE users (
        id NUMBER(38,0) PRIMARY KEY,
        name VARCHAR(100)
      );
      CREATE TABLE orders (
        id NUMBER(38,0) PRIMARY KEY,
        user_id NUMBER(38,0) REFERENCES users(id)
      );
    `;
    const diagram = parseSQLWithType(sql, "snowflake");
    expect(diagram.relationships).toHaveLength(1);
    const userId = field(diagram, "orders", "user_id");
    expect(userId?.isForeignKey).toBe(true);
    expect(userId?.references).toEqual({ table: "users", field: "id" });
  });

  it("does not let a table without a trailing clause swallow the next statement", () => {
    const sql = `
      CREATE TABLE a (id NUMBER(38,0)) COMMENT = 'first';
      CREATE TABLE b (id NUMBER(38,0), a_id NUMBER(38,0));
    `;
    const diagram = parseSQLWithType(sql, "snowflake");
    expect(diagram.tables.map((t) => t.name)).toEqual(["a", "b"]);
    expect(field(diagram, "b", "a_id")).toBeDefined();
  });
});

describe("detectDatabaseType hardening", () => {
  it("does not count PostgreSQL declarative partitioning as ClickHouse", () => {
    const sql = `
      CREATE TABLE measurements (
        id BIGINT NOT NULL,
        logdate DATE NOT NULL,
        recorded_at TIMESTAMPTZ
      ) PARTITION BY RANGE (logdate);
    `;
    expect(detectDatabaseType(sql)).toBe("postgresql");
  });

  it("still counts PARTITION BY for ClickHouse when paired with ENGINE =", () => {
    const sql = `
      CREATE TABLE hits (id Int32, d Date)
      ENGINE = ReplicatedMergeTree('/p', 'r')
      PARTITION BY toYYYYMM(d)
      ORDER BY id;
    `;
    expect(detectDatabaseType(sql)).toBe("clickhouse");
  });

  it("does not switch a PostgreSQL schema to SQLite on INTEGER PRIMARY KEY alone", () => {
    const sql = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        active BOOLEAN NOT NULL
      );
    `;
    expect(detectDatabaseType(sql)).toBe("postgresql");
  });

  it("still detects SQLite when INTEGER PRIMARY KEY is the only signal", () => {
    const sql = `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);`;
    expect(detectDatabaseType(sql)).toBe("sqlite");
  });
});

describe("node-sql-parser dialect: schema-qualified references", () => {
  const sql = `CREATE TABLE public.users (id uuid PRIMARY KEY);
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id));
CREATE TABLE public.sessions (id uuid PRIMARY KEY, user_id uuid, FOREIGN KEY (user_id) REFERENCES auth.users(id));
CREATE TABLE public.posts (id uuid PRIMARY KEY, author_id uuid);
ALTER TABLE public.posts ADD CONSTRAINT fk_author FOREIGN KEY (author_id) REFERENCES auth.users(id);`;

  function targetOf(diagram: Diagram, sourceTable: string) {
    const source = diagram.tables.find((t) => t.name === sourceTable)!;
    const rel = diagram.relationships.find((r) => r.sourceTableId === source.id);
    const target = diagram.tables.find((t) => t.id === rel?.targetTableId);
    return target ? `${target.schema}.${target.name}` : undefined;
  }

  it("keeps the explicit schema of inline, constraint and ALTER TABLE references", () => {
    const diagram = parseSQLWithType(sql, "postgresql");
    expect(targetOf(diagram, "profiles")).toBe("auth.users");
    expect(targetOf(diagram, "sessions")).toBe("auth.users");
    expect(targetOf(diagram, "posts")).toBe("auth.users");
  });
});
