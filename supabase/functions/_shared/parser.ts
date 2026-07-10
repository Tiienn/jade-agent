// PURE query parser — no Deno / env / network imports so it stays unit-testable.
//
// Turns a loose human query like "look for RT -1D pdf plan" into a structured
// { building, keyword tokens, category, picsMode }. Order-independent and
// forgiving of dashes, slashes and filler words.

export type Category = "pdf" | "dwg" | "images" | "plan" | "all";

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
 * Try to match a building starting at index `i`. Returns the best (longest)
 * match across all buildings, with earlier buildings winning ties.
 */
function matchBuildingAt(
  tokens: string[],
  i: number,
  buildings: BuildingRef[],
): BuildingMatch | null {
  let best: BuildingMatch | null = null;

  for (const b of buildings) {
    let len = 0;

    // Exact code match (single token) — includes single-letter M / W.
    if (tokens[i] === b.code.toLowerCase()) {
      len = Math.max(len, 1);
    }

    // Name-word match: one or two consecutive tokens.
    const nameWords = b.name.toLowerCase().split(/\s+/).filter(Boolean);
    // Two consecutive name words.
    if (i + 1 < tokens.length) {
      for (let w = 0; w + 1 < nameWords.length; w++) {
        if (nameWords[w] === tokens[i] && nameWords[w + 1] === tokens[i + 1]) {
          len = Math.max(len, 2);
        }
      }
    }
    // Single name word.
    if (len < 2 && nameWords.includes(tokens[i])) {
      len = Math.max(len, 1);
    }

    if (len > (best?.length ?? 0)) {
      best = { code: b.code, name: b.name, length: len };
    }
  }

  return best;
}
