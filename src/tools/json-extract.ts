/** Index of the brace closing the object that starts at `start`, or -1. Linear time */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function extractBalancedJsonAt(
  text: string,
  start: number,
): string | null {
  if (text[start] !== "{") return null;
  const end = findBalancedEnd(text, start);
  return end === -1 ? null : text.slice(start, end + 1);
}

/** Top-level balanced `{...}` candidates, scanned once (an unclosed brace ends the scan) */
export function extractBalancedJsonObjects(
  text: string,
  maxObjects = 32,
): string[] {
  const objects: string[] = [];
  let from = 0;
  while (objects.length < maxObjects) {
    const start = text.indexOf("{", from);
    if (start === -1) break;
    const end = findBalancedEnd(text, start);
    if (end === -1) break;
    objects.push(text.slice(start, end + 1));
    from = end + 1;
  }
  return objects;
}
