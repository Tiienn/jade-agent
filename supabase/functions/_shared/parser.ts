// PURE query parser — no Deno / env / network imports so it stays unit-testable.
//
// Turns a loose human query like "look for RT -1D pdf plan" into a structured
// { building, keyword tokens, category, picsMode }. Order-independent and
// forgiving of dashes, slashes and filler words.

export type Category =
  | "pdf"
  | "dwg"
  | "images"
  | "plan"
  | "word"
  | "excel"
  | "psd"
  | "all";

export interface BuildingRef {
  code: string;
  name: string;
}

export interface ParsedQuery {
  buildingCode: string | null;
  buildingName: string | null;
  keyword: string;
  keywordTokens: string[];
  category: Category;
  picsMode: boolean;
}

// Filler words that carry no search meaning. NOTE: "all" is intentionally NOT
// here — it is a category ("everything").
const FILLER = new Set([
  "look",
  "for",
  "find",
  "get",
  "me",
  "please",
  "show",
  "search",
  "searching",
  "the",
  "a",
  "an",
  "in",
  "at",
  "on",
  "of",
  "to",
  "files",
  "file",
  "folder",
  "any",
]);

// Category word -> category. First matching token in the query wins.
const CATEGORY_WORDS: Record<string, Category> = {
  pdf: "pdf",
  pdfs: "pdf",
  dwg: "dwg",
  cad: "dwg",
  autocad: "dwg",
  jpg: "images",
  jpeg: "images",
  png: "images",
  gif: "images",
  pic: "images",
  pics: "images",
  picture: "images",
  pictures: "images",
  photo: "images",
  photos: "images",
  image: "images",
  images: "images",
  plan: "plan",
  plans: "plan",
  drawing: "plan",
  drawings: "plan",
  word: "word",
  doc: "word",
  docx: "word",
  docs: "word",
  excel: "excel",
  xls: "excel",
  xlsx: "excel",
  sheet: "excel",
  spreadsheet: "excel",
  psd: "psd",
  photoshop: "psd",
  all: "all",
  everything: "all",
  anything: "all",
};

// Words that indicate the user wants the Pics folder navigation experience.
const PICS_WORDS = new Set([
  "pic",
  "pics",
  "picture",
  "pictures",
  "photo",
  "photos",
  "image",
  "images",
]);

// Dash-like / separator characters replaced with spaces (even when glued to a
// token, e.g. "-1D" -> " 1D"). Includes the non-breaking hyphen U+2011.
const SEPARATORS = /[-‐‑‒–—―_/,]+/g;

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(SEPARATORS, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function parseQuery(
  raw: string,
  buildings: BuildingRef[],
  categoryOverride?: Category,
): ParsedQuery {
  const tokens = tokenize(raw ?? "");

  // 1. Drop filler words.
  const meaningful = tokens.filter((t) => !FILLER.has(t));

  // 2. Category detection — first category word wins and is consumed; later
  //    category words fall through to become keyword tokens.
  let category: Category = "all";
  let picsWordTyped = false;
  let categoryConsumed = false;
  const afterCategory: string[] = [];
  for (const tok of meaningful) {
    if (!categoryConsumed && tok in CATEGORY_WORDS) {
      category = CATEGORY_WORDS[tok];
      picsWordTyped = PICS_WORDS.has(tok);
      categoryConsumed = true;
      continue; // consume this token
    }
    afterCategory.push(tok);
  }

  // 3. Building match — scan left to right; first building found wins. Prefer a
  //    longer (two-token name) match at a given position. Matched tokens are
  //    consumed; everything else becomes keyword tokens.
  let buildingCode: string | null = null;
  let buildingName: string | null = null;
  const keywordTokens: string[] = [];

  let i = 0;
  let matched = false;
  while (i < afterCategory.length) {
    if (!matched) {
      const found = matchBuildingAt(afterCategory, i, buildings);
      if (found) {
        buildingCode = found.code;
        buildingName = found.name;
        matched = true;
        i += found.length; // consume matched tokens
        continue;
      }
    }
    keywordTokens.push(afterCategory[i]);
    i += 1;
  }

  // 4. categoryOverride replaces the final category when provided.
  const finalCategory: Category = categoryOverride ?? category;
  const picsMode = finalCategory === "images" && picsWordTyped;

  return {
    buildingCode,
    buildingName,
    keyword: keywordTokens.join(" "),
    keywordTokens,
    category: finalCategory,
    picsMode,
  };
}

interface BuildingMatch {
  code: string;
  name: string;
  length: number;
}

/**
 * Try to match a building starting at index `i`. Prefers the longest match and,
 * for NAME-based matches, requires it to identify exactly one building — an
 * ambiguous single word like "jade" (Jade Court AND Jade House) is left in the
 * keyword tokens rather than silently scoping to one of them. Code matches are
 * exact and unique by definition, so they are never ambiguous.
 */
function matchBuildingAt(
  tokens: string[],
  i: number,
  buildings: BuildingRef[],
): BuildingMatch | null {
  // 1. Two-word name match (longest). Counts only if it identifies exactly one
  //    building; "jade court" -> Jade Court beats the single token "jade".
  if (i + 1 < tokens.length) {
    const hits: BuildingRef[] = [];
    for (const b of buildings) {
      const nameWords = b.name.toLowerCase().split(/\s+/).filter(Boolean);
      for (let w = 0; w + 1 < nameWords.length; w++) {
        if (nameWords[w] === tokens[i] && nameWords[w + 1] === tokens[i + 1]) {
          hits.push(b);
          break;
        }
      }
    }
    if (hits.length === 1) {
      return { code: hits[0].code, name: hits[0].name, length: 2 };
    }
  }

  // 2. Exact code match (single token) — includes single-letter M / W; unique.
  for (const b of buildings) {
    if (tokens[i] === b.code.toLowerCase()) {
      return { code: b.code, name: b.name, length: 1 };
    }
  }

  // 3. Single name word. Counts only if exactly one building has that word in
  //    its name; two-or-more (e.g. "jade") is ambiguous and does not match.
  const nameHits: BuildingRef[] = [];
  for (const b of buildings) {
    const nameWords = b.name.toLowerCase().split(/\s+/).filter(Boolean);
    if (nameWords.includes(tokens[i])) {
      nameHits.push(b);
    }
  }
  if (nameHits.length === 1) {
    return { code: nameHits[0].code, name: nameHits[0].name, length: 1 };
  }

  return null;
}
