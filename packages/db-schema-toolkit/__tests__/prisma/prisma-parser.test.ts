import { describe, it, expect } from "vitest";
import { parsePrismaSchema } from "../../src/prisma/prisma-parser";

describe("parsePrismaSchema", () => {
  it("detects PostgreSQL provider from datasource", () => {
    const content = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.databaseType).toBe("postgresql");
  });

  it("detects MySQL provider", () => {
    const content = `
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model Post {
  id    Int    @id @default(autoincrement())
  title String
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.databaseType).toBe("mysql");
  });

  it("detects SQLite provider", () => {
    const content = `
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Task {
  id   Int    @id @default(autoincrement())
  name String
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.databaseType).toBe("sqlite");
  });

  it("parses basic model with fields", () => {
    const content = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String
  bio       String?
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
}
    `;
    const diagram = parsePrismaSchema(content, "Test");
    expect(diagram.tables).toHaveLength(1);
    expect(diagram.name).toBe("Test");

    const user = diagram.tables[0]!;
    expect(user.name).toBe("User");
    expect(user.fields.length).toBeGreaterThanOrEqual(5);

    const idField = user.fields.find((f) => f.name === "id");
    expect(idField?.primaryKey).toBe(true);
    expect(idField?.type).toBe("INTEGER");

    const emailField = user.fields.find((f) => f.name === "email");
    expect(emailField?.unique).toBe(true);
    expect(emailField?.type).toBe("VARCHAR");

    const bioField = user.fields.find((f) => f.name === "bio");
    expect(bioField?.nullable).toBe(true);

    const activeField = user.fields.find((f) => f.name === "isActive");
    expect(activeField?.type).toBe("BOOLEAN");
  });

  it("parses multiple models", () => {
    const content = `
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  content  String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.tables).toHaveLength(2);

    const user = diagram.tables.find((t) => t.name === "User")!;
    const post = diagram.tables.find((t) => t.name === "Post")!;

    expect(user.fields.length).toBeGreaterThanOrEqual(3);
    expect(post.fields.length).toBeGreaterThanOrEqual(3);

    // authorId should be detected as FK
    const authorIdField = post.fields.find((f) => f.name === "authorId");
    expect(authorIdField).toBeDefined();
  });

  it("resolves FK relationships via convention", () => {
    const content = `
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  userId   Int
  user     User   @relation(fields: [userId], references: [id])
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.relationships).toHaveLength(1);

    const rel = diagram.relationships[0]!;
    expect(rel.sourceTableId).toBeDefined();
    expect(rel.targetTableId).toBeDefined();
    expect(rel.cardinality).toBe("one-to-many");
  });

  it("parses enums and maps them to ENUM type", () => {
    const content = `
enum Role {
  USER
  ADMIN
  MODERATOR
}

model User {
  id   Int    @id @default(autoincrement())
  name String
  role Role   @default(USER)
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.tables).toHaveLength(1);

    const roleField = diagram.tables[0]!.fields.find((f) => f.name === "role");
    expect(roleField?.type).toBe("ENUM(Role)");
  });

  it("handles composite primary key (@@id)", () => {
    const content = `
model PostTag {
  postId Int
  tagId  Int

  @@id([postId, tagId])
}
    `;
    const diagram = parsePrismaSchema(content);
    const table = diagram.tables[0]!;

    const postId = table.fields.find((f) => f.name === "postId");
    const tagId = table.fields.find((f) => f.name === "tagId");
    expect(postId?.primaryKey).toBe(true);
    expect(tagId?.primaryKey).toBe(true);
  });

  it("handles @@index", () => {
    const content = `
model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int

  @@index([authorId])
}
    `;
    const diagram = parsePrismaSchema(content);
    const table = diagram.tables[0]!;
    expect(table.indexes.length).toBeGreaterThanOrEqual(1);
    expect(table.indexes[0]!.columns).toContain("authorId");
  });

  it("maps Prisma types correctly", () => {
    const content = `
model Data {
  id        Int      @id
  name      String
  count     BigInt
  price     Float
  amount    Decimal
  active    Boolean
  createdAt DateTime
  meta      Json
  avatar    Bytes
}
    `;
    const diagram = parsePrismaSchema(content);
    const fields = diagram.tables[0]!.fields;

    expect(fields.find((f) => f.name === "id")?.type).toBe("INTEGER");
    expect(fields.find((f) => f.name === "name")?.type).toBe("VARCHAR");
    expect(fields.find((f) => f.name === "count")?.type).toBe("BIGINT");
    expect(fields.find((f) => f.name === "price")?.type).toBe("FLOAT");
    expect(fields.find((f) => f.name === "amount")?.type).toBe("DECIMAL");
    expect(fields.find((f) => f.name === "active")?.type).toBe("BOOLEAN");
    expect(fields.find((f) => f.name === "createdAt")?.type).toBe("TIMESTAMP");
    expect(fields.find((f) => f.name === "meta")?.type).toBe("JSON");
    expect(fields.find((f) => f.name === "avatar")?.type).toBe("BYTEA");
  });

  it("parses a complete e-commerce schema", () => {
    const content = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum OrderStatus {
  PENDING
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String
  createdAt DateTime @default(now())
  orders    Order[]
  reviews   Review[]
}

model Product {
  id          Int      @id @default(autoincrement())
  name        String
  description String?
  price       Decimal
  stock       Int      @default(0)
  reviews     Review[]
  orderItems  OrderItem[]
}

model Order {
  id        Int         @id @default(autoincrement())
  userId    Int
  user      User        @relation(fields: [userId], references: [id])
  status    OrderStatus @default(PENDING)
  total     Decimal
  createdAt DateTime    @default(now())
  items     OrderItem[]
}

model OrderItem {
  id        Int     @id @default(autoincrement())
  orderId   Int
  order     Order   @relation(fields: [orderId], references: [id])
  productId Int
  product   Product @relation(fields: [productId], references: [id])
  quantity  Int     @default(1)
  price     Decimal
}

model Review {
  id        Int      @id @default(autoincrement())
  userId    Int
  user      User     @relation(fields: [userId], references: [id])
  productId Int
  product   Product  @relation(fields: [productId], references: [id])
  rating    Int
  comment   String?
  createdAt DateTime @default(now())
}
    `;
    const diagram = parsePrismaSchema(content, "E-commerce");
    expect(diagram.tables).toHaveLength(5);
    expect(diagram.databaseType).toBe("postgresql");
    expect(diagram.relationships.length).toBeGreaterThanOrEqual(4);

    // Check all tables are present
    const tableNames = diagram.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(["Order", "OrderItem", "Product", "Review", "User"]);
  });

  it("skips relation list fields (e.g., posts Post[])", () => {
    const content = `
model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id       Int  @id
  userId   Int
  user     User @relation(fields: [userId], references: [id])
}
    `;
    const diagram = parsePrismaSchema(content);
    const user = diagram.tables.find((t) => t.name === "User")!;

    // "posts" should not appear as a field (it's a relation list)
    const postsField = user.fields.find((f) => f.name === "posts");
    expect(postsField).toBeUndefined();
  });

  it("keeps nested parentheses in @default values", () => {
    const content = `
model Event {
  id        Int      @id @default(autoincrement())
  uuid      String   @default(dbgenerated("gen_random_uuid()"))
  label     String   @default("a (b) c")
  createdAt DateTime @default(now()) @map("created_at")
}
    `;
    const fields = parsePrismaSchema(content).tables[0]!.fields;
    expect(fields.find((f) => f.name === "id")?.default).toBe("autoincrement()");
    expect(fields.find((f) => f.name === "uuid")?.default).toBe(
      'dbgenerated("gen_random_uuid()")',
    );
    expect(fields.find((f) => f.name === "label")?.default).toBe('"a (b) c"');
    expect(fields.find((f) => f.name === "created_at")?.default).toBe("now()");
  });

  it("reads @relation arguments in any order, with name, map and actions", () => {
    const content = `
model User {
  id    Int    @id
  email String @unique
  posts Post[] @relation("owner")
}

model Post {
  id         Int    @id
  ownerId    Int
  owner      User   @relation("owner", references: [id], fields: [ownerId], onDelete: Cascade)
  editorMail String
  editor     User   @relation(name: "editor", map: "fk_editor", fields: [editorMail], references: [email], onUpdate: NoAction)
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.relationships).toHaveLength(2);

    const post = diagram.tables.find((t) => t.name === "Post")!;
    expect(post.fields.find((f) => f.name === "ownerId")?.references).toEqual({
      table: "User",
      field: "id",
    });
    expect(post.fields.find((f) => f.name === "editorMail")?.references).toEqual({
      table: "User",
      field: "email",
    });
    expect(post.fields.find((f) => f.name === "owner")).toBeUndefined();
    expect(post.fields.find((f) => f.name === "editor")).toBeUndefined();
  });

  it("prefers @relation targets over the xxxId naming convention", () => {
    const content = `
model User {
  id Int @id
}

model Account {
  id Int @id
}

model Post {
  id      Int     @id
  userId  Int
  account Account @relation(fields: [userId], references: [id])
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.relationships).toHaveLength(1);

    const post = diagram.tables.find((t) => t.name === "Post")!;
    expect(post.fields.find((f) => f.name === "userId")?.references).toEqual({
      table: "Account",
      field: "id",
    });
  });

  it("maps composite @relation fields pairwise", () => {
    const content = `
model Tenant {
  orgId  Int
  userId Int

  @@id([orgId, userId])
}

model Membership {
  id        Int    @id
  tOrg      Int
  tUser     Int
  tenant    Tenant @relation(fields: [tOrg, tUser], references: [orgId, userId])
}
    `;
    const diagram = parsePrismaSchema(content);
    const membership = diagram.tables.find((t) => t.name === "Membership")!;
    expect(membership.fields.find((f) => f.name === "tOrg")?.references).toEqual({
      table: "Tenant",
      field: "orgId",
    });
    expect(membership.fields.find((f) => f.name === "tUser")?.references).toEqual({
      table: "Tenant",
      field: "userId",
    });
  });

  it("skips singular back-relation fields (e.g., profile Profile?)", () => {
    const content = `
model User {
  id      Int      @id
  profile Profile?
  manager User?    @relation("managed")
}

model Profile {
  id     Int  @id
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}
    `;
    const diagram = parsePrismaSchema(content);
    const user = diagram.tables.find((t) => t.name === "User")!;
    expect(user.fields.map((f) => f.name)).toEqual(["id"]);

    expect(diagram.relationships).toHaveLength(1);
    expect(diagram.relationships[0]!.cardinality).toBe("one-to-one");
  });

  it("still applies the xxxId convention when no @relation covers the field", () => {
    const content = `
model User {
  id Int @id
}

model Post {
  id     Int @id
  userId Int
}
    `;
    const diagram = parsePrismaSchema(content);
    expect(diagram.relationships).toHaveLength(1);
    const post = diagram.tables.find((t) => t.name === "Post")!;
    expect(post.fields.find((f) => f.name === "userId")?.references).toEqual({
      table: "User",
      field: "id",
    });
  });
});
