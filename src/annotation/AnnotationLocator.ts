import { Annotation, LocateResult } from "./AnnotationModel";

interface RawMatch {
  from: number;
  to: number;
  line: number;
}

function findAll(doc: string, needle: string): RawMatch[] {
  if (!needle) return [];
  const out: RawMatch[] = [];
  let i = 0;
  while (i <= doc.length - needle.length) {
    const idx = doc.indexOf(needle, i);
    if (idx < 0) break;
    out.push({ from: idx, to: idx + needle.length, line: lineOf(doc, idx) });
    i = idx + Math.max(1, needle.length);
  }
  return out;
}

function lineOf(doc: string, offset: number): number {
  // 1-based line number, matching Obsidian's lineHint
  let line = 1;
  for (let i = 0; i < offset && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Locate an annotation in `doc` using the layered strategy from
 * docs/technical-design.md §4.3.
 */
export function locate(doc: string, ann: Annotation): LocateResult {
  if (!ann.selectedText) return { status: "drifted" };

  // Step 1: full anchor (contextBefore + selectedText + contextAfter)
  const full = ann.contextBefore + ann.selectedText + ann.contextAfter;
  let matches = findAll(doc, full);
  if (matches.length === 1) {
    const m = matches[0];
    const from = m.from + ann.contextBefore.length;
    const to = from + ann.selectedText.length;
    return { status: "strict", from, to };
  }

  if (matches.length > 1) {
    const sorted = [...matches].sort(
      (a, b) => Math.abs(a.line - ann.lineHint) - Math.abs(b.line - ann.lineHint),
    );
    const best = sorted[0];
    const from = best.from + ann.contextBefore.length;
    const to = from + ann.selectedText.length;
    return { status: "strict", from, to };
  }

  // Step 2: contextBefore + selectedText (right context dropped)
  matches = findAll(doc, ann.contextBefore + ann.selectedText);
  if (matches.length === 1) {
    const m = matches[0];
    const from = m.from + ann.contextBefore.length;
    const to = from + ann.selectedText.length;
    return { status: "strict", from, to };
  }

  // Step 3: selectedText + contextAfter (left context dropped)
  matches = findAll(doc, ann.selectedText + ann.contextAfter);
  if (matches.length === 1) {
    const m = matches[0];
    const from = m.from;
    const to = from + ann.selectedText.length;
    return { status: "strict", from, to };
  }

  // Step 4: bare selectedText, disambiguated by occurrenceIndex / lineHint
  const occ = findAll(doc, ann.selectedText);
  if (occ.length === 0) return { status: "drifted" };
  if (occ.length === 1) {
    return { status: "fuzzy", from: occ[0].from, to: occ[0].to };
  }
  // Prefer occurrenceIndex if in range, otherwise nearest lineHint.
  let pick: RawMatch | undefined;
  if (ann.occurrenceIndex >= 0 && ann.occurrenceIndex < occ.length) {
    pick = occ[ann.occurrenceIndex];
  } else {
    pick = [...occ].sort(
      (a, b) => Math.abs(a.line - ann.lineHint) - Math.abs(b.line - ann.lineHint),
    )[0];
  }
  return {
    status: "fuzzy",
    from: pick.from,
    to: pick.to,
    candidates: occ.filter((m) => m !== pick).map((m) => ({ from: m.from, to: m.to })),
  };
}

// ---------------------------------------------------------------------------
// fuzzyLocate — edit-distance based approximate matching (方案 A)
// ---------------------------------------------------------------------------

/** Minimum confidence threshold for auto-healed matches */
const AUTO_HEAL_THRESHOLD = 0.5;
/** Maximum selectedText length for fuzzy search (performance guard) */
const MAX_FUZZY_LENGTH = 500;
/** Sliding window step size (trade-off: smaller = more precise, larger = faster) */
const WINDOW_STEP = 8;

/**
 * Attempt to locate a drifted annotation using edit-distance fuzzy matching.
 *
 * When `locate()` returns `drifted` (exact text not found), this function
 * slides a window of the expected size across the document and computes
 * a similarity score for each position. The best match above the threshold
 * is returned as an `auto-healed` result.
 *
 * Performance: O(doc.length / step * needle.length) — fast enough for
 * typical Obsidian documents (< 100KB) with step=8.
 */
export function fuzzyLocate(doc: string, ann: Annotation): LocateResult {
  if (!ann.selectedText) return { status: "drifted" };
  if (ann.selectedText.length > MAX_FUZZY_LENGTH) return { status: "drifted" };
  if (doc.length === 0) return { status: "drifted" };

  const needle = ann.selectedText;
  const needleLen = needle.length;

  // Step 1: Narrow search region around lineHint for performance.
  // If lineHint is available, search ±50 lines around it.
  let searchStart = 0;
  let searchEnd = doc.length;

  if (ann.lineHint > 0) {
    // Find approximate character offset of lineHint
    let lineCount = 1;
    let lineStart = 0;
    for (let i = 0; i < doc.length; i++) {
      if (lineCount >= ann.lineHint - 50) {
        lineStart = i;
        break;
      }
      if (doc.charCodeAt(i) === 10) lineCount++;
    }

    let lineEnd = doc.length;
    lineCount = 1;
    for (let i = 0; i < doc.length; i++) {
      if (lineCount >= ann.lineHint + 50) {
        lineEnd = i;
        break;
      }
      if (doc.charCodeAt(i) === 10) lineCount++;
    }

    searchStart = Math.max(0, lineStart - 200);
    searchEnd = Math.min(doc.length, lineEnd + 200);
  }

  // Step 2: Sliding window search
  let bestPos = -1;
  let bestScore = 0;

  for (let pos = searchStart; pos <= searchEnd - needleLen; pos += WINDOW_STEP) {
    const candidate = doc.slice(pos, pos + needleLen);
    const score = trigramSimilarity(needle, candidate);

    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }

  // Step 3: Refine around best position with finer step
  if (bestPos >= 0 && bestScore >= AUTO_HEAL_THRESHOLD * 0.8) {
    const refineStart = Math.max(searchStart, bestPos - WINDOW_STEP * 2);
    const refineEnd = Math.min(searchEnd - needleLen, bestPos + WINDOW_STEP * 2);

    for (let pos = refineStart; pos <= refineEnd; pos++) {
      const candidate = doc.slice(pos, pos + needleLen);
      const score = trigramSimilarity(needle, candidate);

      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
  }

  if (bestPos < 0 || bestScore < AUTO_HEAL_THRESHOLD) {
    return { status: "drifted" };
  }

  // Step 4: Try to extend/contract the match to find natural boundaries
  // (word boundaries, whitespace) — improves alignment quality
  let from = bestPos;
  let to = bestPos + needleLen;

  return {
    status: "auto-healed",
    from,
    to,
    confidence: bestScore,
  };
}

/**
 * Trigram similarity — a fast approximation of edit distance similarity.
 * Computes the Jaccard coefficient of the sets of character trigrams.
 * Returns 0..1 where 1 = identical.
 *
 * Faster than Levenshtein for medium-length strings and sufficient for
 * our "find the closest match" use case.
 */
function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) {
    // For very short strings, fall back to character overlap
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const ch of setA) { if (setB.has(ch)) inter++; }
    return inter / (setA.size + setB.size - inter);
  }

  const triA = trigramSet(a);
  const triB = trigramSet(b);

  let intersection = 0;
  for (const tg of triA.keys()) {
    if (triB.has(tg)) intersection++;
  }

  const union = triA.size + triB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function trigramSet(s: string): Set<number> {
  // Use numeric hash of trigrams for speed
  const set = new Set<number>();
  for (let i = 0; i <= s.length - 3; i++) {
    // Simple rolling hash for 3-char trigrams
    const h = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2);
    set.add(h);
  }
  return set;
}

/**
 * Compute the occurrenceIndex of `selectedText` whose match starts at
 * exactly `at` (used at creation time).
 */
export function computeOccurrenceIndex(doc: string, selectedText: string, at: number): number {
  if (!selectedText) return 0;
  let count = 0;
  let i = 0;
  while (i <= at) {
    const idx = doc.indexOf(selectedText, i);
    if (idx < 0 || idx > at) break;
    if (idx === at) return count;
    count++;
    i = idx + Math.max(1, selectedText.length);
  }
  return count;
}

export function computeLineHint(doc: string, at: number): number {
  return lineOf(doc, at);
}

export function extractContext(doc: string, from: number, to: number, span = 50): {
  contextBefore: string;
  contextAfter: string;
} {
  const start = Math.max(0, from - span);
  const end = Math.min(doc.length, to + span);
  return {
    contextBefore: doc.slice(start, from),
    contextAfter: doc.slice(to, end),
  };
}
