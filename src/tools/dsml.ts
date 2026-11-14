import type { ToolCall } from "../types.js";
import { extractBalancedJsonObjects } from "./json-extract.js";
import {
  buildToolCall,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_MARKUP_CHARS,
} from "./tool-call.js";

/**
 * DeepSeek sometimes answers tool requests in its own "DSML" markup, e.g
 *   <｜DSML｜tool_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="k">v</｜DSML｜parameter>..
 * plus a doubled-bar web variant (`<｜｜DSML｜｜ Tool Calls>`). The parser below only
 * executes a call when the markup is complete, correctly nested and fully consumed
 */
export const DSML_MARKER =
  /[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i;

const MAX_PARAMETERS = 128;
const MAX_STRUCTURAL_TAGS = MAX_PARAMETERS * 2 + 16;
const MAX_TAG_CHARS = 2048;
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

type TagName = "tool_calls" | "invoke" | "parameter" | "direct";

interface Tag {
  name: TagName;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
}

type TagRead = Tag | "invalid" | null;

function canonicalizeTag(rawTag: string): string | null {
  let token = rawTag
    .trim()
    .replace(/｜/g, "|")
    .replace(/[“”＂]/g, '"')
    .replace(/[‘’＇]/g, "'");
  let closing = false;
  if (token.startsWith("/")) {
    closing = true;
    token = token.slice(1).trim();
  }
  token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, "");
  if (token.startsWith("/")) {
    closing = true;
    token = token.slice(1).trim();
  }
  token = token.replace(
    /^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i,
    "",
  );

  if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

  const semantic = token.match(
    /^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i,
  );
  if (!semantic) return null;
  const local = (semantic[1] as string).replace(/[\s_-]/g, "").toLowerCase();
  const canonical =
    local === "toolcalls" || local === "functioncalls" ? "tool_calls" : local;
  const attrs = closing ? "" : (semantic[2] as string);
  return `<${closing ? "/" : ""}${canonical}${attrs}>`;
}

/** Rewrites every DSML spelling into plain `<tool_calls>/<invoke>/<parameter>` tags */
export function normalizeMarkupTags(text: string): string {
  const ascii = text.replace(/＜/g, "<").replace(/＞/g, ">");
  return ascii.replace(
    /<([^<>]{0,1024})>/g,
    (whole, raw: string) => canonicalizeTag(raw) ?? whole,
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function decodeParameterValue(value: string): string {
  const cdata = value.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return cdata ? (cdata[1] as string) : decodeEntities(value);
}

function getAttribute(attrs: string, attribute: string): string | null {
  const match = attrs.match(
    new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, "i"),
  );
  return match ? (match[2] as string) : null;
}

function readTagAt(text: string, start: number): TagRead {
  if (text[start] !== "<") return null;
  const prefix = text
    .slice(start + 1, Math.min(text.length, start + 40))
    .trimStart();
  if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix))
    return null;

  let quote: string | null = null;
  let end = -1;
  const scanEnd = Math.min(text.length, start + MAX_TAG_CHARS + 1);
  for (let i = start + 1; i < scanEnd; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      end = i;
      break;
    }
  }
  if (end === -1) return "invalid";

  let token = text.slice(start + 1, end).trim();
  let closing = false;
  if (token.startsWith("/")) {
    closing = true;
    token = token.slice(1).trim();
  }
  let selfClosing = false;
  if (!closing && token.endsWith("/")) {
    selfClosing = true;
    token = token.slice(0, -1).trim();
  }
  const match = token.match(
    /^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i,
  );
  if (!match) return null;
  return {
    name: (match[1] as string).toLowerCase() as TagName,
    attrs: closing ? "" : (match[2] as string),
    closing,
    selfClosing,
    start,
    end: end + 1,
  };
}

/** All structural tags in order (CDATA skipped); null when malformed or over the bounds */
function scanStructuralTags(text: string): Tag[] | null {
  const tags: Tag[] = [];
  for (let i = 0; i < text.length; ) {
    if (text.slice(i, i + 9).toUpperCase() === "<![CDATA[") {
      const cdataEnd = text.indexOf("]]>", i + 9);
      if (cdataEnd === -1) return null;
      i = cdataEnd + 3;
      continue;
    }
    if (text[i] !== "<") {
      i++;
      continue;
    }
    const tag = readTagAt(text, i);
    if (tag === null) {
      i++;
      continue;
    }
    if (tag === "invalid") return null;
    tags.push(tag);
    if (tags.length > MAX_STRUCTURAL_TAGS) return null;
    i = tag.end;
  }
  return tags;
}

function parseParameter(
  attrs: string,
  rawBody: string,
  args: Record<string, unknown>,
  seen: Set<string>,
): boolean {
  const name = getAttribute(attrs, "name");
  if (!name || !NAME_PATTERN.test(name) || seen.has(name)) return false;
  seen.add(name);

  const rawValue = decodeParameterValue(rawBody);
  if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
  let value: unknown = rawValue;
  if (getAttribute(attrs, "string")?.toLowerCase() === "false") {
    try {
      value = JSON.parse(rawValue.trim()) as unknown;
    } catch {
      return false;
    }
  }
  args[name] = value;
  return true;
}

function parseInvoke(name: string | null, body: string): ToolCall | null {
  const tags = scanStructuralTags(body);
  if (!tags) return null;
  if (tags.some((tag) => tag.name !== "parameter")) return null;

  const args: Record<string, unknown> = {};
  const seen = new Set<string>();
  let cursor = 0;
  let count = 0;
  for (let i = 0; i < tags.length; i += 2) {
    const opening = tags[i] as Tag;
    const closing = tags[i + 1];
    if (opening.closing || opening.selfClosing || !closing || !closing.closing)
      return null;
    if (body.slice(cursor, opening.start).trim()) return null;
    count++;
    if (count > MAX_PARAMETERS) return null;
    if (
      !parseParameter(
        opening.attrs,
        body.slice(opening.end, closing.start),
        args,
        seen,
      )
    )
      return null;
    cursor = closing.end;
  }
  if (count > 0)
    return body.slice(cursor).trim() ? null : buildToolCall(name, args);

  // No <parameter> tags: either empty arguments or a single JSON object body
  const decoded = decodeEntities(body).trim();
  if (!decoded) return buildToolCall(name, {});
  const objects = extractBalancedJsonObjects(decoded, 2);
  if (objects.length !== 1 || decoded !== objects[0]) return null;
  try {
    return buildToolCall(name, JSON.parse(objects[0] as string) as unknown);
  } catch {
    return null;
  }
}

/** Returns the markup inside the (single) tool_calls wrapper, or null if the wrapper is not well formed */
function extractToolCallScope(normalized: string): string | null {
  const tags = scanStructuralTags(normalized);
  if (!tags) return null;
  const wrappers = tags.filter((tag) => tag.name === "tool_calls");
  const openings = wrappers.filter((tag) => !tag.closing);
  const closings = wrappers.filter((tag) => tag.closing);

  if (openings.length > 0) {
    const opening = openings[0] as Tag;
    if (openings.length !== 1 || opening.selfClosing || closings.length === 0)
      return null;
    const closing = closings[closings.length - 1] as Tag;
    if (
      wrappers.some((tag) => tag.closing && tag.start < opening.end) ||
      closing.start < opening.end
    )
      return null;
    if (
      tags.some(
        (tag) =>
          tag.name !== "tool_calls" &&
          (tag.start < opening.end || tag.start >= closing.start),
      )
    )
      return null;
    return normalized.slice(opening.end, closing.start);
  }

  // Narrow repair: tolerate a missing opening wrapper only when a closing wrapper exists
  if (closings.length > 0) {
    const closing = closings[closings.length - 1] as Tag;
    const invokes = tags.filter(
      (tag) =>
        tag.name === "invoke" && !tag.closing && tag.start < closing.start,
    );
    const invoke = invokes[0];
    if (invokes.length === 1 && invoke && !invoke.selfClosing) {
      if (
        tags.some(
          (tag) =>
            tag.name !== "tool_calls" &&
            (tag.start < invoke.start || tag.start >= closing.start),
        )
      )
        return null;
      return normalized.slice(invoke.start, closing.start);
    }
  }
  return null;
}

/** Parses exactly one complete DSML tool call. Anything partial or ambiguous returns null */
export function parseDsmlToolCall(text: string): ToolCall | null {
  if (text.length > MAX_TOOL_MARKUP_CHARS) return null;
  const scope = extractToolCallScope(normalizeMarkupTags(text));
  if (scope === null) return null;
  const tags = scanStructuralTags(scope);
  const first = tags?.[0];
  if (!tags || !first) return null;
  if (scope.slice(0, first.start).trim()) return null;
  if (first.closing || first.selfClosing) return null;

  if (first.name === "invoke") {
    const invokes = tags.filter((tag) => tag.name === "invoke");
    const last = invokes[1];
    if (invokes.length !== 2 || invokes[0] !== first || !last || !last.closing)
      return null;
    if (scope.slice(last.end).trim()) return null;
    if (tags.some((tag) => tag.name === "tool_calls" || tag.name === "direct"))
      return null;
    return parseInvoke(
      getAttribute(first.attrs, "name"),
      scope.slice(first.end, last.start),
    );
  }

  if (first.name === "direct") {
    if (
      tags.some(
        (tag, index) =>
          index > 0 && ["direct", "invoke", "tool_calls"].includes(tag.name),
      )
    )
      return null;
    return parseInvoke(
      getAttribute(first.attrs, "name"),
      scope.slice(first.end),
    );
  }
  return null;
}
