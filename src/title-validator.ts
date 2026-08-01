type ErrorReason = "empty" | "invalidMaxChars" | "tooLong";

export class TitleValidationError extends Error {
  private constructor(reason: ErrorReason) {
    super(
      {
        empty: "title must not be empty",
        invalidMaxChars: "maxChars must be a positive safe integer",
        tooLong: "title exceeds the maximum length",
      }[reason],
    );
    this.name = "TitleValidationError";
  }

  static empty(): TitleValidationError {
    return new TitleValidationError("empty");
  }

  static invalidMaxChars(): TitleValidationError {
    return new TitleValidationError("invalidMaxChars");
  }

  static tooLong(): TitleValidationError {
    return new TitleValidationError("tooLong");
  }
}

const fenceLine = /^`{3,}(?:\s.*|[^\s`].*)?$/;
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
const wordCharacter = /[\p{L}\p{N}]/u;
const markdownMarkers = ["**", "__", "~~", "*", "_", "`"];

export function validateTitle(raw: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw TitleValidationError.invalidMaxChars();
  }

  const protectedBackticks: string[] = [];
  const protectedUrls: string[] = [];
  let title = raw
    .split(/\r\n|[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => !fenceLine.test(line))
    .map(stripLeadingMarkers)
    .filter((line) => line.length > 0)
    .join(" ");

  const seenTitles = new Set<string>();
  while (!seenTitles.has(title)) {
    seenTitles.add(title);
    const previous = title;
    title = unwrapQuotes(title, protectedBackticks);
    title = stripLeadingMarkers(title);
    title = replaceMarkdownLinks(title);
    title = protectUrls(title, protectedUrls);
    title = stripEmphasis(title);
    title = stripInlineCode(title);
    title = collapseWhitespace(title);

    if (title === previous) {
      break;
    }
  }

  title = restorePlaceholders(title, protectedUrls);
  title = restoreBackticks(title, protectedBackticks);

  if (title.length === 0 || /^[*_~`]+$/.test(title)) {
    throw TitleValidationError.empty();
  }
  if (Array.from(title).length > maxChars) {
    throw TitleValidationError.tooLong();
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

function replaceMarkdownLinks(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const labelStart = value[index] === "!" && value[index + 1] === "[" ? index + 1 : value[index] === "[" ? index : -1;
    if (labelStart === -1) {
      result += value[index];
      continue;
    }
    const labelEnd = findClosingBracket(value, labelStart + 1);
    if (labelEnd === -1 || value[labelEnd + 1] !== "(") {
      result += value[index];
      continue;
    }
    const destinationEnd = findClosingParenthesis(value, labelEnd + 2);
    if (destinationEnd === -1) {
      result += value[index];
      continue;
    }
    result += value.slice(labelStart + 1, labelEnd);
    index = destinationEnd;
  }
  return result;
}

function findClosingBracket(value: string, start: number): number {
  let depth = 1;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === "[") {
      depth += 1;
    } else if (value[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingParenthesis(value: string, start: number): number {
  let depth = 1;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === "(") {
      depth += 1;
    } else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function protectUrls(value: string, placeholders: string[]): string {
  return value.replace(/https?:\/\/\S+/g, (url, offset: number, input: string) => {
    const marker = markdownMarkers.find(
      (candidate) => input.slice(offset - candidate.length, offset) === candidate && url.endsWith(candidate),
    );
    if (marker) {
      return `${placeholder(placeholders, url.slice(0, -marker.length))}${marker}`;
    }
    return placeholder(placeholders, url);
  });
}

function stripEmphasis(value: string): string {
  if (["**", "__", "~~", "*", "_"].includes(value)) return "";

  let result = "";
  for (let index = 0; index < value.length; ) {
    const marker = markdownMarkers.slice(0, -1).find((candidate) => value.startsWith(candidate, index));
    if (!marker) {
      result += value[index];
      index += 1;
      continue;
    }
    if (!isBoundaryBefore(value, index)) {
      result += marker;
      index += marker.length;
      continue;
    }
    const closing = findClosingMarker(value, marker, index + marker.length);
    if (closing === -1 || closing === index + marker.length) {
      result += marker;
      index += marker.length;
      continue;
    }
    result += value.slice(index + marker.length, closing);
    index = closing + marker.length;
  }
  return result;
}

function findClosingMarker(value: string, marker: string, start: number): number {
  for (let index = start; index <= value.length - marker.length; index += 1) {
    if (value.startsWith(marker, index) && isBoundaryAfter(value, index + marker.length)) return index;
  }
  return -1;
}

function isBoundaryBefore(value: string, index: number): boolean {
  return index === 0 || !wordCharacter.test(value[index - 1]);
}

function isBoundaryAfter(value: string, index: number): boolean {
  return index === value.length || !wordCharacter.test(value[index]);
}

function stripInlineCode(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "`") {
      result += value[index];
      continue;
    }
    const closing = value.indexOf("`", index + 1);
    if (closing === -1) {
      result += "`";
      continue;
    }
    result += value.slice(index + 1, closing);
    index = closing;
  }
  return result;
}

function unwrapQuotes(value: string, protectedBackticks: string[]): string {
  for (const [opening, closing] of quotePairs) {
    if (value.startsWith(opening) && value.endsWith(closing) && value.length >= opening.length + closing.length) {
      const inner = value.slice(opening.length, -closing.length).trim();
      return opening === "`"
        ? inner.replace(/`/g, (tick) => `\uE002${protectedBackticks.push(tick) - 1}\uE003`)
        : inner;
    }
  }
  return value;
}

function placeholder(values: string[], value: string): string {
  return `\uE000${values.push(value) - 1}\uE001`;
}

function restorePlaceholders(value: string, values: string[]): string {
  return value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => values[Number(index)] ?? "");
}

function restoreBackticks(value: string, values: string[]): string {
  return value.replace(/\uE002(\d+)\uE003/g, (_, index: string) => values[Number(index)] ?? "");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
