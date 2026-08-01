export class TitleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleValidationError";
  }
}

const fenceLine = /^```[^\s`]*$/;
const leadingMarkers = [
  /^#{1,6}(?:\s+|$)/,
  /^>(?:\s+|$)/,
  /^(?:-|\*|\+)(?:\s+|$)/,
  /^\d+[.)](?:\s+|$)/,
];

const quotePairs: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["【", "】"],
];

export function validateTitle(raw: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TitleValidationError("maxChars must be a positive safe integer");
  }

  const title = unwrapQuotes(
    collapseWhitespace(
      raw
        .split(/\r\n|[\r\n]/)
        .map((line) => line.trim())
        .filter((line) => !fenceLine.test(line))
        .map(stripLeadingMarkers)
        .map(stripMarkdown)
        .filter((line) => line.length > 0)
        .join(" "),
    ),
  );

  if (title.length === 0) {
    throw new TitleValidationError("title must not be empty");
  }

  if (Array.from(title).length > maxChars) {
    throw new TitleValidationError("title exceeds the maximum length");
  }

  return title;
}

function stripLeadingMarkers(line: string): string {
  let result = line;
  let changed = true;

  while (changed) {
    changed = false;
    for (const marker of leadingMarkers) {
      const stripped = result.replace(marker, "");
      if (stripped !== result) {
        result = stripped;
        changed = true;
        break;
      }
    }
  }

  return result;
}

function stripMarkdown(line: string): string {
  const urls: string[] = [];
  const protectedLine = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s`~*]+/g, (url) => {
      const index = urls.push(url) - 1;
      return `\u0000${index}\u0000`;
    });

  return protectedLine
    .replace(/`/g, "")
    .replace(/(\*\*|__|~~)(?=\S)(.*?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.*?)\1/g, "$2")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => urls[Number(index)] ?? "");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unwrapQuotes(value: string): string {
  let result = value;
  let changed = true;

  while (changed) {
    changed = false;
    for (const [opening, closing] of quotePairs) {
      if (result.startsWith(opening) && result.endsWith(closing) && result.length >= opening.length + closing.length) {
        result = result.slice(opening.length, -closing.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}
