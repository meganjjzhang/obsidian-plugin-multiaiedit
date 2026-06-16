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
        attributes: { "data-prm-id": ann.id },
      }),
    });
  }

  const merged = mergeRanges(ranges);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of merged) {
    builder.add(r.from, r.to, r.deco);
  }
  return builder.finish();
}

/** Merge overlapping / touching ranges into non-overlapping spans. */
function mergeRanges(
  ranges: Array<{ from: number; to: number; deco: Decoration }>,
): Array<{ from: number; to: number; deco: Decoration }> {
  if (ranges.length === 0) return ranges;

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  const result: Array<{ from: number; to: number; deco: Decoration }> = [];
  const points = new Set<number>();
  for (const r of ranges) {
    points.add(r.from);
    points.add(r.to);
  }
  const sorted = Array.from(points).sort((a, b) => a - b);

  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (from === to) continue;

    const covering = ranges.filter((r) => r.from <= from && r.to >= to);
    if (covering.length === 0) continue;

    const classes = new Set<string>();
    const dataIds: string[] = [];
    for (const c of covering) {
      const spec = c.deco.spec;
      if (spec.class) spec.class.split(/\s+/).forEach((cls: string) => classes.add(cls));
      if (spec.attributes?.["data-prm-id"]) dataIds.push(spec.attributes["data-prm-id"]);
    }

    const mergedDeco = Decoration.mark({
      class: Array.from(classes).join(" "),
      attributes: dataIds.length > 0 ? { "data-prm-id": dataIds.join(",") } : undefined,
    });
    result.push({ from, to, deco: mergedDeco });
  }

  return result;
}

function decoClassFor(ann: Annotation, status: "strict" | "fuzzy" | "auto-healed"): string | null {
  const fuzzy = status === "fuzzy" ? " cm-promptuary-fuzzy" : "";
  const healed = status === "auto-healed" ? " cm-promptuary-auto-healed" : "";
  if (ann.type === "highlight") {
    const color = ann.highlightColor ?? "yellow";
    return `cm-promptuary-highlight cm-promptuary-highlight-${color}${fuzzy}${healed}`;
  }
  if (ann.type === "note") {
    const color = ann.highlightColor ?? "yellow";
    return `cm-promptuary-highlight cm-promptuary-highlight-${color}${fuzzy}${healed}`;
  }
  if (ann.type === "review") {
    let cls = "cm-promptuary-review";
    if (ann.strike) cls += " cm-promptuary-strike";
    return cls + fuzzy + healed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TableAnnotationPlugin
//
// In Obsidian Live Preview, table rows that are NOT being edited are rendered
// as replace-decoration widgets.  CM6 silently drops mark decorations that
// overlap with replace decorations, so our highlight spans never appear in the
// DOM for those rows.
//
// This ViewPlugin runs after each relevant update and manually injects
// highlight spans into the rendered table DOM, replicating what CM6 would have
// done if the text were in source-editing mode.
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel class added to every DOM-injected highlight span. */
const TABLE_HL_CLASS = "prm-table-hl";

class TableAnnotationPlugin {
  private rafId: number | null = null;
  private observer: MutationObserver | null = null;
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.startObserving();
  }

  // ── MutationObserver ─────────────────────────────────────────────────────
  // In LP mode, clicking a table cell injects a nested CM6 editor (<div
  // class="cm-editor">) into the <td>.  Clicking away removes it and the cell
  // reverts to rendered HTML.  Our `update()` callback does NOT fire on these
  // purely visual DOM changes (no doc/viewport/annotation change), so we need
  // a MutationObserver to detect when a table widget's DOM mutates — especially
  // when a nested editor is removed — so we can re-inject highlights.
  // ─────────────────────────────────────────────────────────────────────────
  private startObserving(): void {
    this.observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        const target = m.target as HTMLElement;
        // Change inside a table widget
        if (typeof target.closest === "function" && target.closest(".cm-table-widget")) return true;
        // A nested editor was added/removed
        for (const node of Array.from(m.addedNodes).concat(Array.from(m.removedNodes))) {
          const el = node as HTMLElement;
          if (typeof el.closest !== "function") continue;
          if (el.classList?.contains("cm-editor") || el.querySelector?.(".cm-editor")) return true;
        }
        return false;
      });
      if (!relevant) return;
      this.scheduleApply();
    });
    this.observer.observe(this.view.dom, { childList: true, subtree: true });
  }

  private scheduleApply(): void {
    if (this.rafId !== null) window.cancelAnimationFrame(this.rafId);
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      this.applyTableHighlights(this.view);
    });
  }

  update(update: ViewUpdate): void {
    const hasAnnotationChange = update.transactions.some(
      (t) => t.effects.some((e) => e.is(setAnnotationsEffect)),
    );
    if (!update.docChanged && !update.viewportChanged && !hasAnnotationChange) return;
    this.scheduleApply();
  }

  destroy(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.observer?.disconnect();
    this.observer = null;
  }

  private applyTableHighlights(view: EditorView): void {
    // 1. Remove all previously injected table highlights.
    Array.from(view.dom.querySelectorAll<HTMLElement>(`.${TABLE_HL_CLASS}`)).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      // Unwrap: move children back, then remove the wrapper span.
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });

    const annotations = view.state.field(annotationsField);
    if (annotations.length === 0) return;

    const doc = view.state.doc.toString();

    // 2. Build a list of located annotations with their CSS classes.
    const located: Array<{ selectedText: string; cls: string }> = [];
    for (const ann of annotations) {
      if (!ann.selectedText) continue;
      const r = locate(doc, ann);
      if (r.status === "drifted" || r.from === undefined) continue;
      const cls = decoClassFor(ann, r.status);
      if (cls) located.push({ selectedText: ann.selectedText, cls });
    }
    if (located.length === 0) return;

    // 3. Walk each visible .cm-line.
    for (const lineEl of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-line"))) {
      // Skip lines where CM6 already inserted our decoration spans (edit mode).
      if (lineEl.querySelector("[class*='cm-promptuary']")) continue;

      // Determine the document line text for this DOM element.
      let lineText: string;
      try {
        const pos = view.posAtDOM(lineEl, 0);
        lineText = view.state.doc.lineAt(pos).text;
      } catch {
        continue;
      }

      // Only process table rows (lines starting/ending with `|`).
      const trimmed = lineText.trim();
      if (!trimmed.startsWith("|") && !trimmed.endsWith("|")) continue;

      // 4. Inject highlight spans for any annotation whose selectedText
      //    appears in this table row's source text.
      for (const { selectedText, cls } of located) {
        if (!lineText.includes(selectedText)) continue;
        injectHighlightInElement(lineEl, selectedText, cls);
      }
    }

    // 5. Process rendered table widgets (LP mode: rows NOT being edited are
    //    rendered as an HTML <table> inside .cm-table-widget). CM6 mark
    //    decorations are silently dropped for these replace-decoration regions,
    //    so we inject highlights directly into the rendered DOM.
    const tableWidgets = view.dom.querySelectorAll<HTMLElement>(".cm-table-widget");
    for (const widget of Array.from(tableWidgets)) {
      const cells = widget.querySelectorAll<HTMLElement>("td, th");
      for (const cell of Array.from(cells)) {
        // Skip cells that host a nested CM6 editor (the row being edited).
        if (cell.querySelector(".cm-editor")) continue;
        // Skip cells already containing our injected highlights.
        if (cell.querySelector(`.${TABLE_HL_CLASS}`)) continue;

        const cellText = cell.textContent ?? "";
        for (const { selectedText, cls } of located) {
          if (!cellText.includes(selectedText)) continue;
          injectHighlightInElement(cell, selectedText, cls);
        }
      }
    }
  }
}

/**
 * Walk text nodes inside `root`, find the first occurrence of `needle`,
 * and wrap it in a <span> with the given CSS classes.
 */
function injectHighlightInElement(root: HTMLElement, needle: string, cls: string): void {
  const walker = activeDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text already inside one of our injected spans.
      if ((node.parentElement as HTMLElement | null)?.closest(`.${TABLE_HL_CLASS}`)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const content = textNode.textContent ?? "";
    const idx = content.indexOf(needle);
    if (idx === -1) continue;

    const before = content.slice(0, idx);
    const after = content.slice(idx + needle.length);
    const parent = textNode.parentNode!;

    const span = activeDocument.createElement("span");
    span.className = `${cls} ${TABLE_HL_CLASS}`;
    span.textContent = needle;

    if (before) parent.insertBefore(activeDocument.createTextNode(before), textNode);
    parent.insertBefore(span, textNode);
    if (after) parent.insertBefore(activeDocument.createTextNode(after), textNode);
    parent.removeChild(textNode);

    // One match per annotation per line is enough.
    return;
  }
}

/**
 * Build the editor extension.
 */
export function annotationDecoratorExtension() {
  return [
    annotationsField,
    decorationField,
    ViewPlugin.fromClass(TableAnnotationPlugin),
  ];
}
