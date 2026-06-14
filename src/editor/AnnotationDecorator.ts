// CM6 Decoration set built from the current file's annotations.
// Plain "rebuild on file open" strategy — see technical-design.md §4.6.

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Annotation } from "../annotation/AnnotationModel";
import { locate } from "../annotation/AnnotationLocator";

/** Apply a fresh annotations array for the document. */
export const setAnnotationsEffect = StateEffect.define<Annotation[]>();

const annotationsField = StateField.define<Annotation[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setAnnotationsEffect)) return e.value;
    }
    return value;
  },
});

const decorationField = StateField.define<DecorationSet>({
  create(state): DecorationSet {
    return buildDecorations(state.doc.toString(), state.field(annotationsField));
  },
  update(deco, tr) {
    let anns: Annotation[] | null = null;
    for (const e of tr.effects) {
      if (e.is(setAnnotationsEffect)) anns = e.value;
    }
    if (anns) return buildDecorations(tr.state.doc.toString(), anns);
    if (tr.docChanged) {
      // Cheap rebuild on doc change. v0.1 keeps it simple per design doc.
      return buildDecorations(tr.state.doc.toString(), tr.state.field(annotationsField));
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(doc: string, anns: Annotation[]): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];

  for (const ann of anns) {
    const r = locate(doc, ann);
    if (r.status === "drifted" || r.from === undefined || r.to === undefined) continue;

    const cls = decoClassFor(ann, r.status);
    if (!cls) continue;
    ranges.push({
      from: r.from,
      to: r.to,
      deco: Decoration.mark({
        class: cls,
        attributes: { "data-mae-id": ann.id },
      }),
    });
  }

  // Merge overlapping / touching ranges before feeding them to RangeSetBuilder,
  // which requires strictly non-overlapping, ordered input.
  const merged = mergeRanges(ranges);

  const builder = new RangeSetBuilder<Decoration>();
  for (const r of merged) {
    builder.add(r.from, r.to, r.deco);
  }
  return builder.finish();
}

/** Merge overlapping / touching ranges into non-overlapping spans.
 *  When two ranges overlap, we split into sub-ranges and combine CSS classes
 *  so that every position gets all applicable decorations. */
function mergeRanges(
  ranges: Array<{ from: number; to: number; deco: Decoration }>,
): Array<{ from: number; to: number; deco: Decoration }> {
  if (ranges.length === 0) return ranges;

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  const result: Array<{ from: number; to: number; deco: Decoration }> = [];

  // Collect all unique boundary points
  const points = new Set<number>();
  for (const r of ranges) {
    points.add(r.from);
    points.add(r.to);
  }
  const sorted = Array.from(points).sort((a, b) => a - b);

  // For each interval between consecutive boundary points, collect all
  // decorations that cover it and create a single merged decoration.
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (from === to) continue;

    // Find all ranges covering [from, to)
    const covering = ranges.filter((r) => r.from <= from && r.to >= to);
    if (covering.length === 0) continue;

    // Merge CSS classes and data attributes
    const classes = new Set<string>();
    const dataIds: string[] = [];
    for (const c of covering) {
      const spec = c.deco.spec;
      if (spec.class) spec.class.split(/\s+/).forEach((cls: string) => classes.add(cls));
      if (spec.attributes?.["data-mae-id"]) dataIds.push(spec.attributes["data-mae-id"]);
    }

    const mergedDeco = Decoration.mark({
      class: Array.from(classes).join(" "),
      attributes: dataIds.length > 0 ? { "data-mae-id": dataIds.join(",") } : undefined,
    });
    result.push({ from, to, deco: mergedDeco });
  }

  return result;
}

function decoClassFor(ann: Annotation, status: "strict" | "fuzzy" | "auto-healed"): string | null {
  // auto-healed renders like strict (no warning indicator) — the user already
  // got a Notice about the auto-repair. fuzzy still shows a subtle warning.
  const fuzzy = status === "fuzzy" ? " cm-multiaiedit-fuzzy" : "";
  const healed = status === "auto-healed" ? " cm-multiaiedit-auto-healed" : "";
  if (ann.type === "highlight") {
    const color = ann.highlightColor ?? "yellow";
    return `cm-multiaiedit-highlight cm-multiaiedit-highlight-${color}${fuzzy}${healed}`;
  }
  if (ann.type === "note") {
    const color = ann.highlightColor ?? "yellow";
    return `cm-multiaiedit-highlight cm-multiaiedit-highlight-${color}${fuzzy}${healed}`;
  }
  if (ann.type === "review") {
    let cls = "cm-multiaiedit-review";
    if (ann.strike) cls += " cm-multiaiedit-strike";
    return cls + fuzzy + healed;
  }
  return null;
}

/**
 * Build the editor extension. The viewer plugin lets us push fresh
 * annotation arrays from the outside via dispatching `setAnnotationsEffect`.
 */
export function annotationDecoratorExtension() {
  return [annotationsField, decorationField, ViewPlugin.fromClass(class {
    update(_u: ViewUpdate) { /* no-op; field handles updates */ }
  })];
}
