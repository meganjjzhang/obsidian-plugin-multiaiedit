// Annotation data model — see docs/technical-design.md §2.

export type AnnotationType = "highlight" | "note" | "review";
export type ViewMode = "reading" | "reviewing" | "all";
export type HighlightColor = "yellow" | "blue" | "green" | "purple";
export type MatchStrategy = "strict" | "fuzzy" | "auto-healed" | "drifted";

export interface Annotation {
  // identity
  id: string;
  type: AnnotationType;
  filePath: string;
  createdAt: number;
  updatedAt: number;

  // text anchor (persisted)
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  lineHint: number;
  occurrenceIndex: number;

  // baseline
  baselineHash: string;

  // type-specific
  highlightColor?: HighlightColor;
  noteText?: string;
  reviewText?: string;
  strike?: boolean;
}

export interface AnnotationFile {
  version: number;
  filePath: string;
  baselineHash: string;
  annotations: Annotation[];
}

export const FILE_VERSION = 1;

export function emptyAnnotationFile(filePath: string): AnnotationFile {
  return {
    version: FILE_VERSION,
    filePath,
    baselineHash: "",
    annotations: [],
  };
}

export interface LocateResult {
  status: MatchStrategy;
  // CodeMirror character offsets; undefined when status === "drifted"
  from?: number;
  to?: number;
  // For multi-match fuzzy hits, the alternative ranges
  candidates?: Array<{ from: number; to: number }>;
  // For auto-healed matches, the confidence score (0..1)
  confidence?: number;
}
