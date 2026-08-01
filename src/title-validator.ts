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
const urlWrapperMarkers = ["***", "___", "**", "__", "~~", "*", "_", "`"];
const MAX_RAW_TITLE_CODE_UNITS = 4096;

export function validateTitle(raw: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw TitleValidationError.invalidMaxChars();
  }
  if (raw.length > MAX_RAW_TITLE_CODE_UNITS) {
    throw TitleValidationError.tooLong();
  }

  const placeholders = new PlaceholderStore(raw);
  let title = raw
    .split(/\r\n|[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => !fenceLine.test(line))
    .map(stripLeadingMarkers)
    .filter((line) => line.length > 0)
    .join(" ");

  let stabilized = false;
  for (let pass = 0; pass <= raw.length; pass += 1) {
    const previous = title;
    title = unwrapQuotes(title);
    title = stripLeadingMarkers(title);
    title = replaceMarkdownLinks(title);
    title = protectUrls(title, placeholders);
    title = stripEmphasis(title);
    title = stripInlineCode(title);
    title = collapseWhitespace(title);

    if (title === previous) {
      stabilized = true;
      break;
    }
  }
  if (!stabilized) throw TitleValidationError.tooLong();

  title = placeholders.restore(title);

  if (title.length === 0 || /^[*_~]+$/.test(title)) {
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

function protectUrls(value: string, placeholders: PlaceholderStore): string {
  return value.replace(/'?https?:\/\/[^\s"“”‘’「」『』【】`]+/g, (url, offset: number, input: string) => {
    const suffix = url.match(/[.,;:!?。、\)\]\}]+$/)?.[0] ?? "";
    const core = suffix ? url.slice(0, -suffix.length) : url;
    const quotedOpening = readOpeningMarkers(input, offset);
    const openingStart = offset - quotedOpening.length;
    const closingStart = offset + core.length - quotedOpening.length;
    const openingMarker = urlWrapperMarkers.find((marker) => marker !== "`" && input.startsWith(marker, openingStart));
    const closingMarker = urlWrapperMarkers.find((marker) => marker !== "`" && input.startsWith(marker, closingStart));
    if (
      url.startsWith("'") &&
      quotedOpening &&
      core.endsWith(`'${quotedOpening}`) &&
      openingMarker &&
      closingMarker &&
      isValidEmphasisOpening(input, openingStart, openingMarker) &&
      isValidEmphasisClosing(input, closingStart, closingMarker)
    ) {
      return `${placeholders.create(core.slice(1, -quotedOpening.length - 1))}${quotedOpening}${suffix}`;
    }
    const expectedClosing = readOpeningMarkers(input, offset);
    if (expectedClosing) {
      if (core.endsWith(expectedClosing)) {
        return `${placeholders.create(core.slice(0, -expectedClosing.length))}${expectedClosing}${suffix}`;
      }
    }
    return placeholders.create(url);
  });
}

function readOpeningMarkers(value: string, offset: number): string {
  let cursor = offset;
  let expectedClosing = "";
  while (cursor > 0) {
    const marker = urlWrapperMarkers.find((candidate) => value.slice(cursor - candidate.length, cursor) === candidate);
    if (!marker) break;
    expectedClosing += marker;
    cursor -= marker.length;
  }
  return expectedClosing;
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
    if (!isValidEmphasisOpening(value, index, marker)) {
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
    if (value.startsWith(marker, index) && isValidEmphasisClosing(value, index, marker)) {
      return index;
    }
  }
  return -1;
}

function isBoundaryBefore(value: string, index: number): boolean {
  return index === 0 || !wordCharacter.test(value[index - 1]);
}

function isBoundaryAfter(value: string, index: number): boolean {
  return index === value.length || !wordCharacter.test(value[index]);
}

function isValidEmphasisOpening(value: string, index: number, marker: string): boolean {
  return isBoundaryBefore(value, index) && !isEscaped(value, index) && !isWhitespace(value[index + marker.length]);
}

function isValidEmphasisClosing(value: string, index: number, marker: string): boolean {
  return !isEscaped(value, index) && !isWhitespace(value[index - 1]) && isBoundaryAfter(value, index + marker.length);
}

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value);
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
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

function unwrapQuotes(value: string): string {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [opening, closing] of quotePairs) {
      if (result.startsWith(opening) && result.endsWith(closing) && result.length >= opening.length + closing.length) {
        const inner = result.slice(opening.length, -closing.length).trim();
        result = inner;
        changed = true;
        break;
      }
    }
  }
  return result;
}

class PlaceholderStore {
  private readonly tokens = new Map<string, string>();
  private readonly namespace: string;

  constructor(raw: string) {
    for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
      const candidate = String.fromCharCode(codePoint);
      if (!raw.includes(candidate)) {
        this.namespace = candidate;
        return;
      }
    }
    throw TitleValidationError.tooLong();
  }

  create(value: string): string {
    const token = `${this.namespace}${this.tokens.size.toString(36)}${this.namespace}`;
    this.tokens.set(token, value);
    return token;
  }

  restore(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== this.namespace) {
        result += value[index];
        continue;
      }
      const end = value.indexOf(this.namespace, index + 1);
      if (end === -1) {
        result += value[index];
        continue;
      }
      const token = value.slice(index, end + 1);
      const original = this.tokens.get(token);
      if (original === undefined) {
        result += value[index];
        continue;
      }
      result += original;
      index = end;
    }
    return result;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
