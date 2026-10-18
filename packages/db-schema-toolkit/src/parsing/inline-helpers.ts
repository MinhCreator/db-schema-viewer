import { extractBraceBlock } from "./extract-brace-block";

// ── Types ────────────────────────────────────────────────────────

interface FunctionHelper {
  paramName: string;
  /** Source text of the object body (between { and }) */
  returnBody: string;
}

// ══════════════════════════════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════════════════════════════

/**
 * Inline helper functions that return object literals into their call sites.
 */
export function inlineHelperFunctions(content: string): string {
  return regexInlineHelperFunctions(content);
}

/**
 * Inline constant object literals into their spread sites.
 */
export function inlineObjectSpreads(content: string): string {
  return regexInlineObjectSpreads(content);
}

/**
 * Resolve class inheritance by prepending parent class body to child.
 * Returns a map of className → merged body text (parent + own).
 */
export function resolveClassInheritance(content: string): Map<string, string> {
  return regexResolveClassInheritance(content);
}

// ── Shared utility ───────────────────────────────────────────────

function renameParam(body: string, oldParam: string, newParam: string): string {
  if (oldParam === newParam) return body;
  return body.replace(
    new RegExp(`\\b${escapeRegExp(oldParam)}(?=\\s*\\.)`, "g"),
    newParam,
  );
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ══════════════════════════════════════════════════════════════════
//  Regex-based implementation
// ══════════════════════════════════════════════════════════════════

function regexInlineHelperFunctions(content: string): string {
  const helpers = regexExtractFunctionHelpers(content);
  if (helpers.size === 0) return content;

  for (const [funcName, helper] of helpers) {
    const directCallRegex = new RegExp(
      `\\(\\s*(\\w+)[^)]*\\)\\s*=>\\s*${escapeRegExp(funcName)}\\s*\\(\\s*\\w+\\s*\\)`,
      "g",
    );
    content = content.replace(directCallRegex, (_match, callParam: string) => {
      const body = renameParam(helper.returnBody, helper.paramName, callParam);
      return `(${callParam}) => ({ ${body} })`;
    });

    const spreadRegex = new RegExp(
      `\\.\\.\\.\\s*${escapeRegExp(funcName)}\\s*\\(\\s*(\\w+)\\s*\\)`,
      "g",
    );
    content = content.replace(spreadRegex, (_match, callArg: string) => {
      return renameParam(helper.returnBody, helper.paramName, callArg);
    });
  }

  return content;
}

function regexInlineObjectSpreads(content: string): string {
  const objects = regexExtractObjectConstants(content);
  if (objects.size === 0) return content;

  for (const [varName, body] of objects) {
    const spreadRegex = new RegExp(
      `\\.\\.\\.\\s*${escapeRegExp(varName)}(?!\\w)`,
      "g",
    );
    // A replacer function keeps `$&`, `$1`, `$$` in the body literal.
    content = content.replace(spreadRegex, () => body);
  }

  return content;
}

function regexResolveClassInheritance(content: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const classRegex = /\bclass\s+(\w+)(?:\s+extends\s+(\w+))?/g;

  let match;
  while ((match = classRegex.exec(content)) !== null) {
    const className = match[1]!;
    const parentName = match[2];

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

    if (parentName) {
      const parentBody = bodies.get(parentName);
      if (parentBody) {
        body = parentBody + "\n" + body;
      }
    }

    bodies.set(className, body);
  }

  return bodies;
}

// ── Regex: Extract function helpers ──────────────────────────────

function regexExtractFunctionHelpers(content: string): Map<string, FunctionHelper> {
  const helpers = new Map<string, FunctionHelper>();

  const funcDeclRegex = /\bfunction\s+(\w+)\s*\(/g;
  let match;
  while ((match = funcDeclRegex.exec(content)) !== null) {
    regexProcessFuncCandidate(content, match[1]!, match.index + match[0].length, helpers);
  }

  const constExprRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:function\s*)?\(/g;
  while ((match = constExprRegex.exec(content)) !== null) {
    const openParen = match.index + match[0].length - 1;
    regexProcessFuncCandidate(content, match[1]!, openParen + 1, helpers);
    // A declarator without a usable parameter must not end the scan:
    // `const now = () => new Date(), cols = (d) => ({ ... })`
    let next = nextFunctionDeclarator(content, openParen);
    while (next) {
      regexProcessFuncCandidate(content, next.name, next.openParen + 1, helpers);
      next = nextFunctionDeclarator(content, next.openParen);
    }
  }

  return helpers;
}

const FUNCTION_DECLARATOR = /\s*(\w+)\s*=\s*(?:function\s*)?\(/y;

/**
 * From the `(` of a declarator's initializer, find the next `name = (` or
 * `name = function (` declarator of the same declaration. Stops at the end
 * of the statement.
 */
function nextFunctionDeclarator(
  content: string,
  from: number,
): { name: string; openParen: number } | null {
  let depth = 0;
  let i = from;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(content, i);
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const lineEnd = content.indexOf("\n", i);
      if (lineEnd === -1) return null;
      i = lineEnd;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const commentEnd = content.indexOf("*/", i + 2);
      if (commentEnd === -1) return null;
      i = commentEnd + 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (depth === 0) {
      if (ch === ";") return null;
      if (ch === "\n" && !declarationContinues(content, i)) return null;
      if (ch === ",") {
        FUNCTION_DECLARATOR.lastIndex = i + 1;
        const declarator = FUNCTION_DECLARATOR.exec(content);
        if (declarator) {
          return { name: declarator[1]!, openParen: i + declarator[0].length };
        }
      }
    }
    i++;
  }
  return null;
}

function skipStringLiteral(content: string, quoteIdx: number): number {
  const quote = content[quoteIdx];
  let i = quoteIdx + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return content.length;
}

/** A newline continues a declaration only when a comma sits on either side of it. */
function declarationContinues(content: string, newlineIdx: number): boolean {
  let before = newlineIdx - 1;
  while (before >= 0 && /\s/.test(content[before]!)) before--;
  if (before >= 0 && content[before] === ",") return true;
  let after = newlineIdx + 1;
  while (after < content.length && /\s/.test(content[after]!)) after++;
  return content[after] === ",";
}

function regexProcessFuncCandidate(
  content: string,
  funcName: string,
  afterOpenParen: number,
  helpers: Map<string, FunctionHelper>,
): void {
  if (helpers.has(funcName)) return;

  const paramSlice = content.substring(afterOpenParen);
  const paramMatch = /^\s*(\w+)/.exec(paramSlice);
  if (!paramMatch) return;
  const paramName = paramMatch[1]!;

  let depth = 1;
  let pos = afterOpenParen;
  while (pos < content.length && depth > 0) {
    if (content[pos] === "(") depth++;
    else if (content[pos] === ")") depth--;
    pos++;
  }
  if (depth !== 0) return;

  const remaining = content.substring(pos);
  const arrowIdx = remaining.search(/=>/);
  const braceIdx = remaining.search(/\{/);

  if (arrowIdx !== -1 && (braceIdx === -1 || arrowIdx < braceIdx)) {
    const absoluteArrowPos = pos + arrowIdx + 2;
    const afterArrow = content.substring(absoluteArrowPos).trimStart();

    if (afterArrow.startsWith("(")) {
      const parenPos = content.indexOf("(", absoluteArrowPos);
      const innerBraceIdx = content.indexOf("{", parenPos);
      if (innerBraceIdx === -1) return;
      const returnBody = extractBraceBlock(content, innerBraceIdx);
      if (returnBody) helpers.set(funcName, { paramName, returnBody });
    } else if (afterArrow.startsWith("{")) {
      const funcBodyStart = content.indexOf("{", absoluteArrowPos);
      if (funcBodyStart === -1) return;
      regexExtractReturnObject(content, funcBodyStart, paramName, funcName, helpers);
    }
  } else if (braceIdx !== -1) {
    const funcBodyStart = pos + braceIdx;
    regexExtractReturnObject(content, funcBodyStart, paramName, funcName, helpers);
  }
}

function regexExtractReturnObject(
  content: string,
  funcBodyStart: number,
  paramName: string,
  funcName: string,
  helpers: Map<string, FunctionHelper>,
): void {
  const funcBody = extractBraceBlock(content, funcBodyStart);
  if (!funcBody) return;

  const returnMatch = /\breturn\s*\{/.exec(funcBody);
  if (!returnMatch) return;

  const braceRelativeIdx = returnMatch.index + returnMatch[0].length - 1;
  const absoluteReturnIdx = funcBodyStart + 1 + braceRelativeIdx;
  const returnBody = extractBraceBlock(content, absoluteReturnIdx);
  if (!returnBody) return;

  helpers.set(funcName, { paramName, returnBody });
}

function regexExtractObjectConstants(content: string): Map<string, string> {
  const objects = new Map<string, string>();
  const objRegex = /(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?\s*=\s*\{/g;

  let match;
  while ((match = objRegex.exec(content)) !== null) {
    const varName = match[1]!;
    const braceIdx = content.indexOf("{", match.index + match[0].length - 1);
    const body = extractBraceBlock(content, braceIdx);
    if (!body) continue;
    if (/\breturn\s/.test(body)) continue;
    objects.set(varName, body);
  }

  return objects;
}
