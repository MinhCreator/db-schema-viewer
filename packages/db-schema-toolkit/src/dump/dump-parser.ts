export interface ParsedRow {
  [column: string]: string | number | boolean | null;
}

export interface ParsedDumpTable {
  name: string;
  columns: string[];
  rows: ParsedRow[];
}

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

type TokenKind = "word" | "number" | "string" | "quoted" | "backtick" | "punct" | "eof";

interface Token {
  kind: TokenKind;
  /** Raw text for word/number/punct; unescaped content for string/quoted/backtick. */
  text: string;
  start: number;
  end: number;
}

const CONSTRAINT_KEYWORDS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "KEY",
  "INDEX",
  "CHECK",
  "FULLTEXT",
  "SPATIAL",
  "EXCLUDE",
  "LIKE",
  "PERIOD",
]);

const CREATE_TABLE_MODIFIERS = new Set([
  "OR",
  "REPLACE",
  "TEMP",
  "TEMPORARY",
  "UNLOGGED",
  "GLOBAL",
  "LOCAL",
  "EXTERNAL",
  "TRANSIENT",
]);

const DOLLAR_TAG_REGEX = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

function isWordStart(char: string): boolean {
  return /[\p{L}_]/u.test(char);
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Single-pass, quote-aware SQL lexer. Strings, quoted identifiers, dollar-quoted
 * bodies and comments are consumed whole, so `;`, `(` and `)` inside them never
 * reach the parser.
 */
class Lexer {
  pos = 0;
  private peeked: Token | null = null;

  constructor(private readonly sql: string) {}

  peek(): Token {
    this.peeked ??= this.read();
    return this.peeked;
  }

  next(): Token {
    const token = this.peek();
    this.peeked = null;
    return token;
  }

  /** Move the cursor to an absolute offset, dropping any peeked token. */
  seek(pos: number): void {
    this.pos = pos;
    this.peeked = null;
  }

  private read(): Token {
    const sql = this.sql;
    this.skipTrivia();

    const start = this.pos;
    if (start >= sql.length) return { kind: "eof", text: "", start, end: start };

    const char = sql[start]!;

    if (char === "'") return this.readQuoted("string", "'", true);
    if (char === '"') return this.readQuoted("quoted", '"', true);
    if (char === "`") return this.readQuoted("backtick", "`", false);

    if (char === "$") {
      DOLLAR_TAG_REGEX.lastIndex = start;
      const tagMatch = DOLLAR_TAG_REGEX.exec(sql);
      if (tagMatch) {
        const tag = tagMatch[0];
        const bodyStart = start + tag.length;
        const close = sql.indexOf(tag, bodyStart);
        const bodyEnd = close === -1 ? sql.length : close;
        this.pos = close === -1 ? sql.length : close + tag.length;
        return { kind: "string", text: sql.slice(bodyStart, bodyEnd), start, end: this.pos };
      }
    }

    if (isDigit(char) || (char === "." && isDigit(sql[start + 1]))) {
      let i = start + 1;
      while (i < sql.length) {
        const c = sql[i]!;
        if ((c === "+" || c === "-") && (sql[i - 1] === "e" || sql[i - 1] === "E")) {
          i++;
        } else if (c === "." || isWordChar(c)) {
          i++;
        } else {
          break;
        }
      }
      this.pos = i;
      return { kind: "number", text: sql.slice(start, i), start, end: i };
    }

    if (isWordStart(char)) {
      let i = start + 1;
      while (i < sql.length && isWordChar(sql[i]!)) i++;
      this.pos = i;
      return { kind: "word", text: sql.slice(start, i), start, end: i };
    }

    this.pos = start + 1;
    return { kind: "punct", text: char, start, end: this.pos };
  }

  private skipTrivia(): void {
    const sql = this.sql;
    while (this.pos < sql.length) {
      const char = sql[this.pos]!;
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") {
        this.pos++;
      } else if (char === "-" && sql[this.pos + 1] === "-") {
        const newline = sql.indexOf("\n", this.pos + 2);
        this.pos = newline === -1 ? sql.length : newline + 1;
      } else if (char === "/" && sql[this.pos + 1] === "*") {
        const close = sql.indexOf("*/", this.pos + 2);
        this.pos = close === -1 ? sql.length : close + 2;
      } else {
        return;
      }
    }
  }

  /**
   * Read a quoted token. A doubled delimiter is an escaped delimiter; when
   * `backslashEscapes` is set, `\'`, `\"` and `\\` are unescaped too and other
   * backslash sequences are kept verbatim.
   */
  private readQuoted(kind: TokenKind, quote: string, backslashEscapes: boolean): Token {
    const sql = this.sql;
    const start = this.pos;
    let text = "";
    let segmentStart = start + 1;
    let i = start + 1;

    while (i < sql.length) {
      const c = sql[i]!;
      if (backslashEscapes && c === "\\" && i + 1 < sql.length) {
        const escaped = sql[i + 1]!;
        if (escaped === "'" || escaped === '"' || escaped === "\\") {
          text += sql.slice(segmentStart, i) + escaped;
          i += 2;
          segmentStart = i;
        } else {
          i += 2;
        }
      } else if (c === quote) {
        text += sql.slice(segmentStart, i);
        if (sql[i + 1] === quote) {
          text += quote;
          i += 2;
          segmentStart = i;
        } else {
          this.pos = i + 1;
          return { kind, text, start, end: this.pos };
        }
      } else {
        i++;
      }
    }

    text += sql.slice(segmentStart, sql.length);
    this.pos = sql.length;
    return { kind, text, start, end: this.pos };
  }
}

function isKeyword(token: Token, keyword: string): boolean {
  return token.kind === "word" && token.text.toUpperCase() === keyword;
}

function isPunct(token: Token, char: string): boolean {
  return token.kind === "punct" && token.text === char;
}

function isName(token: Token): boolean {
  return token.kind === "word" || token.kind === "quoted" || token.kind === "backtick";
}

function isStatementEnd(token: Token): boolean {
  return token.kind === "eof" || isPunct(token, ";");
}

/** Consume tokens up to and including the next top-level `;`. */
function skipStatement(lexer: Lexer): void {
  while (true) {
    const token = lexer.next();
    if (isStatementEnd(token)) return;
  }
}

/** Read `name` or `schema.name` (any depth) and return the last part. */
function readQualifiedName(lexer: Lexer): string | null {
  if (!isName(lexer.peek())) return null;
  let name = lexer.next().text;
  while (isPunct(lexer.peek(), ".")) {
    lexer.next();
    if (!isName(lexer.peek())) return null;
    name = lexer.next().text;
  }
  return name;
}

/** Read a parenthesised, comma-separated identifier list; the opening `(` is already consumed. */
function readColumnList(lexer: Lexer): string[] {
  const columns: string[] = [];
  let expectName = true;
  let depth = 1;

  while (true) {
    const token = lexer.peek();
    if (isStatementEnd(token)) return columns;
    lexer.next();

    if (isPunct(token, "(")) {
      depth++;
    } else if (isPunct(token, ")")) {
      depth--;
      if (depth === 0) return columns;
    } else if (depth === 1 && isPunct(token, ",")) {
      expectName = true;
    } else if (depth === 1 && expectName && isName(token)) {
      columns.push(token.text);
      expectName = false;
    }
  }
}

/** Read `CREATE TABLE name (...)` column names; `CREATE` is already consumed. */
function readCreateTable(lexer: Lexer): { name: string; columns: string[] } | null {
  while (lexer.peek().kind === "word" && !isKeyword(lexer.peek(), "TABLE")) {
    if (!CREATE_TABLE_MODIFIERS.has(lexer.peek().text.toUpperCase())) return null;
    lexer.next();
  }
  if (!isKeyword(lexer.peek(), "TABLE")) return null;
  lexer.next();

  if (isKeyword(lexer.peek(), "IF")) {
    lexer.next();
    if (isKeyword(lexer.peek(), "NOT")) lexer.next();
    if (isKeyword(lexer.peek(), "EXISTS")) lexer.next();
  }

  const name = readQualifiedName(lexer);
  if (name === null || !isPunct(lexer.peek(), "(")) return null;
  lexer.next();

  const columns: string[] = [];
  let atDefinitionStart = true;
  let depth = 1;

  while (true) {
    const token = lexer.peek();
    if (isStatementEnd(token)) break;
    lexer.next();

    if (isPunct(token, "(")) {
      depth++;
      atDefinitionStart = false;
    } else if (isPunct(token, ")")) {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && isPunct(token, ",")) {
      atDefinitionStart = true;
    } else if (atDefinitionStart) {
      atDefinitionStart = false;
      const isConstraint = token.kind === "word" && CONSTRAINT_KEYWORDS.has(token.text.toUpperCase());
      if (isName(token) && !isConstraint) columns.push(token.text);
    }
  }

  return { name, columns };
}

/**
 * Read one `(v1, v2, ...)` tuple; the opening `(` is already consumed.
 * Returns null when the input ends before the tuple closes.
 */
function readTuple(lexer: Lexer, sql: string): Array<string | number | boolean | null> | null {
  const values: Array<string | number | boolean | null> = [];
  let first: Token | null = null;
  let last: Token | null = null;
  let count = 0;
  let depth = 1;

  const finishValue = (): void => {
    if (first === null || last === null) {
      values.push("");
    } else if (count === 1 && (first.kind === "string" || first.kind === "quoted")) {
      values.push(first.text);
    } else {
      values.push(parseValue(sql.slice(first.start, last.end)));
    }
    first = null;
    last = null;
    count = 0;
  };

  while (true) {
    const token = lexer.peek();
    if (isStatementEnd(token)) return null;
    lexer.next();

    if (depth === 1 && isPunct(token, ",")) {
      finishValue();
      continue;
    }
    if (isPunct(token, ")") && depth === 1) {
      if (count > 0 || values.length > 0) finishValue();
      return values;
    }
    if (isPunct(token, "(")) depth++;
    else if (isPunct(token, ")")) depth--;

    first ??= token;
    last = token;
    count++;
  }
}

function generatedColumns(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `col_${i + 1}`);
}

export function parseSQLDump(sql: string): ParsedDumpTable[] {
  if (sql.length > MAX_SIZE) {
    throw new Error(`File too large. Maximum size is 5MB, got ${(sql.length / 1024 / 1024).toFixed(1)}MB.`);
  }

  const tables = new Map<string, ParsedDumpTable>();
  const createdColumns = new Map<string, string[]>();
  const insertedColumns = new Map<string, string[]>();
  const lexer = new Lexer(sql);

  while (lexer.peek().kind !== "eof") {
    const token = lexer.next();

    if (isKeyword(token, "CREATE")) {
      const created = readCreateTable(lexer);
      if (created && created.columns.length > 0) createdColumns.set(created.name, created.columns);
      skipStatement(lexer);
    } else if (isKeyword(token, "COPY")) {
      skipCopyStatement(lexer, sql);
    } else if (isKeyword(token, "INSERT")) {
      parseInsert(lexer, sql, tables, createdColumns, insertedColumns);
    }
  }

  return Array.from(tables.values());
}

/** Skip `COPY ... FROM stdin;` together with its raw data block terminated by `\.`. */
function skipCopyStatement(lexer: Lexer, sql: string): void {
  let fromStdin = false;
  while (true) {
    const token = lexer.next();
    if (isKeyword(token, "STDIN")) fromStdin = true;
    if (isStatementEnd(token)) break;
  }
  if (!fromStdin) return;

  const terminator = /^\\\.\r?$/m;
  const rest = sql.slice(lexer.pos);
  const match = terminator.exec(rest);
  lexer.seek(match ? lexer.pos + match.index + match[0].length : sql.length);
}

function parseInsert(
  lexer: Lexer,
  sql: string,
  tables: Map<string, ParsedDumpTable>,
  createdColumns: Map<string, string[]>,
  insertedColumns: Map<string, string[]>,
): void {
  // Skip modifiers such as IGNORE or LOW_PRIORITY up to INTO.
  while (lexer.peek().kind === "word" && !isKeyword(lexer.peek(), "INTO")) lexer.next();
  if (!isKeyword(lexer.peek(), "INTO")) return;
  lexer.next();

  const tableName = readQualifiedName(lexer);
  if (tableName === null) return;

  let explicitColumns: string[] = [];
  if (isPunct(lexer.peek(), "(")) {
    lexer.next();
    explicitColumns = readColumnList(lexer);
  }

  if (!isKeyword(lexer.peek(), "VALUES") && !isKeyword(lexer.peek(), "VALUE")) return;
  lexer.next();

  const knownColumns =
    explicitColumns.length > 0
      ? explicitColumns
      : (createdColumns.get(tableName) ?? insertedColumns.get(tableName) ?? []);
  if (explicitColumns.length > 0 && !insertedColumns.has(tableName)) {
    insertedColumns.set(tableName, explicitColumns);
  }

  let table = tables.get(tableName);
  if (!table) {
    table = { name: tableName, columns: [], rows: [] };
    tables.set(tableName, table);
  }

  let widestRow = 0;
  while (isPunct(lexer.peek(), "(")) {
    lexer.next();
    const values = readTuple(lexer, sql);
    if (values === null) break;

    const row: ParsedRow = {};
    for (let i = 0; i < values.length; i++) {
      row[knownColumns[i] ?? `col_${i + 1}`] = values[i]!;
    }
    table.rows.push(row);
    widestRow = Math.max(widestRow, values.length);

    if (!isPunct(lexer.peek(), ",")) break;
    lexer.next();
  }

  if (table.columns.length === 0) {
    table.columns = knownColumns.length > 0 ? [...knownColumns] : generatedColumns(widestRow);
  }

  skipStatement(lexer);
}

function parseValue(val: string): string | number | boolean | null {
  const upper = val.toUpperCase();
  if (upper === "NULL") return null;
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;

  // Integers beyond Number.MAX_SAFE_INTEGER would lose precision.
  if (/^[+-]?\d+$/.test(val) && !Number.isSafeInteger(Number(val))) return val;

  const num = Number(val);
  if (!isNaN(num) && val.trim() !== "") return num;

  return val;
}
