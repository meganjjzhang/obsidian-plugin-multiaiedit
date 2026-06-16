/**
 * AnchorUpdater — given a pair of (oldText, newText) and a list of annotations
 * anchored in oldText, compute updated anchor fields for newText.
 *
 * This is the core of "方案 B: Agent 回锚" — after an Agent modifies the file,
 * we use the precise diff between old and new text to map each annotation's
 * selectedText position from the old document to the new one.
 *
 * Algorithm:
 * 1. Compute diff chunks (using DiffCalculator's output format).
 * 2. Build a position mapping table: old offset → new offset.
 * 3. For each annotation, find its old range in the mapping, compute new range.
 * 4. Extract new selectedText / contextBefore / contextAfter / lineHint /
 *    occurrenceIndex from newText.
 * 5. Return updated annotation fields (or mark as drifted if unmappable).
 */

import { Annotation } from "./AnnotationModel";

export interface AnchorUpdate {
  id: string;
  /** "healed" = successfully re-anchored, "drifted" = cannot map */
  status: "healed" | "drifted";
  /** Similarity between the old selected text and the mapped new selected text. */
  similarity?: number;
  /** Updated fields to patch into the annotation */
  patch: Partial<Pick<Annotation,
    "selectedText" | "contextBefore" | "contextAfter" | "lineHint" | "occurrenceIndex"
  >>;
}

interface DiffChunk {
  /** Old doc start offset */
  oldStart: number;
  /** Old doc end offset */
  oldEnd: number;
  /** New doc start offset */
  newStart: number;
  /** New doc end offset */
  newEnd: number;
  /** true if text was modified (not pure insert or delete) */
  modified: boolean;
}

/**
 * Compute diff chunks that map old text positions to new text positions.
 * Uses a simple line-based diff, then computes character offsets.
 */
function computeChunks(oldText: string, newText: string): DiffChunk[] {
  const chunks: DiffChunk[] = [];

  // Simple LCS-based diff at character level
  // For performance, we use a line-level approach then refine
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Build character offset tables for old and new text
  const oldLineOffsets: number[] = [];
  const newLineOffsets: number[] = [];

  let off = 0;
  for (const line of oldLines) {
    oldLineOffsets.push(off);
    off += line.length + 1; // +1 for \n
  }

  off = 0;
  for (const line of newLines) {
    newLineOffsets.push(off);
    off += line.length + 1;
  }

  // Use a simple diff algorithm — patience-style LCS on lines
  const lcs = computeLCS(oldLines, newLines);

  // Convert LCS to diff chunks
  let oi = 0; // old line index
  let ni = 0; // new line index
  let li = 0; // lcs index

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length
        && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      // Matched line — unchanged region
      oi++;
      ni++;
      li++;
    } else {
      // Start of a change block
      const changeOldStart = oi < oldLines.length ? oldLineOffsets[oi] : oldText.length;
      const changeNewStart = ni < newLines.length ? newLineOffsets[ni] : newText.length;
      let changeOldEnd = changeOldStart;
      let changeNewEnd = changeNewStart;

      // Consume unmatched old lines
      while (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        changeOldEnd = oldLineOffsets[oi] + oldLines[oi].length;
        if (oi < oldLines.length - 1) changeOldEnd += 1; // \n
        oi++;
      }

      // Consume unmatched new lines
      while (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        changeNewEnd = newLineOffsets[ni] + newLines[ni].length;
        if (ni < newLines.length - 1) changeNewEnd += 1; // \n
        ni++;
      }

      chunks.push({
        oldStart: changeOldStart,
        oldEnd: changeOldEnd,
        newStart: changeNewStart,
        newEnd: changeNewEnd,
        modified: true,
      });
    }
  }

  return chunks;
}

/**
 * Simple LCS computation using patience diff approach for better performance
 * on typical document edits. Falls back to standard DP for small inputs.
 */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // For small inputs, use standard DP
  if (m * n <= 10_000_000) {
    return computeLCSDP(a, b);
  }

  // For larger inputs, use a simplified approach: find unique matching lines
  // and chain them (patience diff core idea)
  const aIndices = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    const key = a[i];
    if (!aIndices.has(key)) aIndices.set(key, []);
    aIndices.get(key)!.push(i);
  }

  // Find unique lines (appear exactly once in both)
  const bUnique = new Map<string, number>();
  for (let j = 0; j < b.length; j++) {
    const aIdx = aIndices.get(b[j]);
    if (aIdx && aIdx.length === 1) {
      if (!bUnique.has(b[j])) bUnique.set(b[j], j);
    }
  }

  // Sort matching unique lines by their position in a
  const matches: Array<{ aIdx: number; bIdx: number; line: string }> = [];
  for (const [line, bj] of bUnique) {
    const ai = aIndices.get(line)![0];
    matches.push({ aIdx: ai, bIdx: bj, line });
  }
  matches.sort((x, y) => x.aIdx - y.aIdx);

  // Find longest increasing subsequence of bIdx values
  const lis = longestIncreasingSubsequence(matches.map((m) => m.bIdx));

  // Build LCS from matched unique lines
  const lcs: string[] = [];
  for (const idx of lis) {
    lcs.push(matches[idx].line);
  }

  return lcs;
}

function computeLCSDP(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // Use rolling array to save memory
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  // Backtrack to find the actual LCS
  const lcs: string[] = [];
  let i = m, j = n;
  // Re-compute for backtracking (small enough since we already validated)
  const dp: number[][] = [];
  for (let x = 0; x <= m; x++) {
    dp[x] = new Array(n + 1).fill(0);
  }
  for (let x = 1; x <= m; x++) {
    for (let y = 1; y <= n; y++) {
      if (a[x - 1] === b[y - 1]) {
        dp[x][y] = dp[x - 1][y - 1] + 1;
      } else {
        dp[x][y] = Math.max(dp[x - 1][y], dp[x][y - 1]);
      }
    }
  }
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

function longestIncreasingSubsequence(arr: number[]): number[] {
  if (arr.length === 0) return [];
  const tails: number[] = [];
  const prev: number[] = new Array(arr.length).fill(-1);
  const indices: number[] = [];

  for (let i = 0; i < arr.length; i++) {
    const val = arr[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[tails[mid]] < val) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) {
      tails.push(i);
    } else {
      tails[lo] = i;
    }
  }

  // Reconstruct
  const result: number[] = [];
  let k = tails[tails.length - 1];
  while (k >= 0) {
    result.unshift(k);
    k = prev[k];
  }
  return result;
}

/**
 * Build a mapping from old document offsets to new document offsets.
 * Returns a sorted array of mapping points for binary search.
 */
interface MapPoint {
  oldPos: number;
  newPos: number;
}

function buildPositionMap(chunks: DiffChunk[], oldLen: number, newLen: number): MapPoint[] {
  const points: MapPoint[] = [{ oldPos: 0, newPos: 0 }];

  for (const chunk of chunks) {
    // Before the change, positions map 1:1 from the end of last mapping
    const lastPoint = points[points.length - 1];

    // If there's unchanged text between last point and this chunk
    if (chunk.oldStart > lastPoint.oldPos) {
      const unchangedOldLen = chunk.oldStart - lastPoint.oldPos;
      points.push({
        oldPos: chunk.oldStart,
        newPos: lastPoint.newPos + unchangedOldLen,
      });
    }

    // The change itself maps the old range to the new range
    points.push({
      oldPos: chunk.oldEnd,
      newPos: chunk.newEnd,
    });
  }

  // Final point
  const last = points[points.length - 1];
  if (last.oldPos < oldLen || last.newPos < newLen) {
    // Remaining unchanged text after last change
    const remainingOld = oldLen - last.oldPos;
    points.push({
      oldPos: oldLen,
      newPos: last.newPos + remainingOld,
    });
  }

  return points;
}

/**
 * Map an old document offset to a new document offset using the position map.
 * Uses binary search for efficiency.
 */
function mapOffset(points: MapPoint[], oldOffset: number): number {
  if (points.length === 0) return oldOffset;

  // Binary search for the last point with oldPos <= oldOffset
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].oldPos <= oldOffset) lo = mid;
    else hi = mid - 1;
  }

  const point = points[lo];
  // If exact match, return the mapped position
  if (point.oldPos === oldOffset) return point.newPos;

  // If the next point exists and oldOffset falls within a change region,
  // we can't map precisely — return the nearest boundary
  const nextIdx = lo + 1;
  if (nextIdx < points.length) {
    const next = points[nextIdx];
    // If oldOffset falls in an unchanged region between point and next
    if (oldOffset < next.oldPos) {
      const delta = oldOffset - point.oldPos;
      return point.newPos + delta;
    }
    // oldOffset falls inside a change region — snap to the end of the change
    return next.newPos;
  }

  // Beyond all mapped points — linear offset from last known point
  const delta = oldOffset - point.oldPos;
  return point.newPos + delta;
}

/** Count newlines in a substring of text */
function countLines(text: string, upTo: number): number {
  let lines = 1;
  const end = Math.min(upTo, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

/** Compute occurrence index of a substring starting at a given offset */
function computeOccIndex(text: string, needle: string, at: number): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while (i <= at) {
    const idx = text.indexOf(needle, i);
    if (idx < 0 || idx > at) break;
    if (idx === at) return count;
    count++;
    i = idx + Math.max(1, needle.length);
  }
  return count;
}

/**
 * Update annotation anchors based on a text transformation (oldText → newText).
 *
 * @param oldText - The document content before the change
 * @param newText - The document content after the change
 * @param annotations - Annotations that were anchored in oldText
 * @param contextSpan - Number of characters of context to extract (default 50)
 * @returns Array of updates, one per annotation that could be re-anchored
 */
export function reanchorAnnotations(
  oldText: string,
  newText: string,
  annotations: Annotation[],
  contextSpan = 50,
): AnchorUpdate[] {
  if (annotations.length === 0) return [];
  if (oldText === newText) return annotations.map((a) => ({ id: a.id, status: "healed" as const, patch: {} }));

  // Step 1: Compute diff chunks
  const chunks = computeChunks(oldText, newText);

  // Step 2: Build position map
  const map = buildPositionMap(chunks, oldText.length, newText.length);

  // Step 3: For each annotation, map old position → new position
  const results: AnchorUpdate[] = [];

  for (const ann of annotations) {
    if (!ann.selectedText) {
      results.push({ id: ann.id, status: "drifted", patch: {} });
      continue;
    }

    // Find the annotation's position in oldText using locate
    // We need to find where selectedText was in oldText.
    // Since the annotation was created in oldText, we can search for it.
    const _oldFrom = oldText.indexOf(ann.selectedText,
      ann.lineHint > 0 ? Math.max(0, oldText.indexOf("\n", 0)) : 0);

    // More robust: use the context to find the position
    let foundFrom = -1;
    let foundTo = -1;

    // Try with full context first
    if (ann.contextBefore && ann.contextAfter) {
      const full = ann.contextBefore + ann.selectedText + ann.contextAfter;
      const idx = oldText.indexOf(full);
      if (idx >= 0) {
        foundFrom = idx + ann.contextBefore.length;
        foundTo = foundFrom + ann.selectedText.length;
      }
    }

    // Fallback: just search for selectedText
    if (foundFrom < 0) {
      const idx = oldText.indexOf(ann.selectedText);
      if (idx >= 0) {
        foundFrom = idx;
        foundTo = idx + ann.selectedText.length;
      }
    }

    if (foundFrom < 0) {
      // Can't even find the annotation in oldText — drifted
      results.push({ id: ann.id, status: "drifted", patch: {} });
      continue;
    }

    // Step 4: Map old range to new range
    const newFrom = mapOffset(map, foundFrom);
    const newTo = mapOffset(map, foundTo);

    // Validate: the mapped range must be reasonable
    if (newTo <= newFrom || newTo > newText.length) {
      results.push({ id: ann.id, status: "drifted", patch: {} });
      continue;
    }

    // Step 5: Extract new selectedText from newText
    const newSelectedText = newText.slice(newFrom, newTo);

    // Verify the new selectedText is similar to the old one
    // If Agent only modified surrounding text, selectedText should be identical
    // If Agent modified the selected region, it should be reasonably similar
    const similarity = computeSimilarity(ann.selectedText, newSelectedText);

    if (similarity < 0.3) {
      // Too different — the mapped region doesn't correspond to the original annotation.
      // For review annotations, the caller treats this as "the reviewed text was
      // removed/replaced" and can delete the consumed review record.
      results.push({ id: ann.id, status: "drifted", similarity, patch: {} });
      continue;
    }

    // Step 6: Extract new context
    const ctxStart = Math.max(0, newFrom - contextSpan);
    const ctxEnd = Math.min(newText.length, newTo + contextSpan);
    const newContextBefore = newText.slice(ctxStart, newFrom);
    const newContextAfter = newText.slice(newTo, ctxEnd);

    // Step 7: Compute new lineHint and occurrenceIndex
    const newLineHint = countLines(newText, newFrom);
    const newOccIndex = computeOccIndex(newText, newSelectedText, newFrom);

    results.push({
      id: ann.id,
      status: "healed",
      similarity,
      patch: {
        selectedText: newSelectedText,
        contextBefore: newContextBefore,
        contextAfter: newContextAfter,
        lineHint: newLineHint,
        occurrenceIndex: newOccIndex,
      },
    });
  }

  return results;
}

/**
 * Simple similarity metric between two strings.
 * Uses the ratio of common characters to total length.
 * Returns 0..1 where 1 = identical.
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  // Quick check: if one is a substring of the other
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }

  // Simple character-frequency similarity (Jaccard-like)
  const freqA = charFrequency(a);
  const freqB = charFrequency(b);
  let intersection = 0;
  let union = 0;

  const allChars = new Set([...freqA.keys(), ...freqB.keys()]);
  for (const ch of allChars) {
    const ca = freqA.get(ch) ?? 0;
    const cb = freqB.get(ch) ?? 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }

  return union > 0 ? intersection / union : 0;
}

function charFrequency(s: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  return freq;
}
