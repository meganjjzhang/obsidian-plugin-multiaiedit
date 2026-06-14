import { EditorView } from "@codemirror/view";
import { App } from "obsidian";
import { HighlightColor, ViewMode } from "../annotation/AnnotationModel";

export interface PopoverCallbacks {
  onHighlight: (color: HighlightColor, annotationId?: string) => void;
  onNote: (text: string, color: HighlightColor, annotationId?: string) => void;
  onReview: (text: string, strike: boolean, annotationId?: string) => void;
  onStrikeCreate: () => Promise<string>; // create review with strike:true, return annotation ID
  onStrikeRemove: (id: string) => void;  // remove the pending strike annotation
  onModeSwitch: (mode: ViewMode) => void;
}

/**
 * Desktop selection popover — a single absolutely-positioned DOM element
 * inserted into the editor's parent. The plugin owns lifecycle and updates
 * its position as the selection changes.
 *
 * Layout (vertical):
 * ┌──────────────────────────────┐
 * │  [阅读] [批阅]    ← 模式胶囊  │
 * ├──────────────────────────────┤
 * │  （按钮行）                   │
 * ├──────────────────────────────┤
 * │  （Note 展开区，默认隐藏）    │
 * └──────────────────────────────┘
 */
export class SelectionPopover {
  private el: HTMLDivElement;
  private mode: ViewMode = "reading";
  private current: { view: EditorView; from: number; to: number } | null = null;
  /** The mode that the current DOM was built for. When `mode === renderedMode`
   * a `show()` call only repositions the popover instead of rebuilding the
   * DOM — critical during a mouse-drag selection where `selectionchange`
   * fires on every pixel and a rebuild would steal focus from the editor. */
  private renderedMode: ViewMode | null = null;
  /** Whether the Note input area is currently expanded */
  private noteExpanded = false;
  /** Currently selected highlight color (for note area indicator) */
  private selectedColor: HighlightColor = "yellow";
  /** Whether Delete (strikethrough) is toggled on in review mode */
  private strikePending = false;
  /** If Delete was toggled ON, holds the annotation ID of the immediately-created review */
  private pendingStrikeId: string | null = null;

  /** When editing an existing annotation (jumped from sidebar click), store its id.
   *  All save callbacks receive this id so main.ts can update instead of create. */
  private editingAnnotationId: string | null = null;

  /** Whether the popover is in annotation-editing mode (jumped from sidebar click).
   *  When true, selectionchange events should not override the popover state. */
  isEditing = false;

  constructor(private app: App, private cb: PopoverCallbacks) {
    this.el = document.createElement("div");
    this.el.className = "multiaiedit-popover";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  destroy(): void {
    this.el.remove();
    this.current = null;
    this.renderedMode = null;
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Mode changed → DOM is stale, force re-render on the next show().
    this.renderedMode = null;
    this.noteExpanded = false;
    this.cleanupPendingStrike();
    if (this.current) this.render();
  }

  /** Show popover for a given selection. Returns false if there is no real
   * selection. */
  show(view: EditorView, from: number, to: number): boolean {
    if (from === to) {
      this.hide();
      return false;
    }
    // If selection range changed, force re-render (collapse Note etc.)
    const rangeChanged = this.current
      ? (this.current.from !== from || this.current.to !== to)
      : true;
    this.current = { view, from, to };
    if (this.renderedMode !== this.mode || rangeChanged) this.render();
    this.position(view, from, to);
    return true;
  }

  /** Show popover positioned at a specific annotation range (from sidebar click).
   *  Sets isEditing=true to prevent selectionchange from overriding.
   *  Stores editingAnnotationId so save actions update instead of creating new. */
  showForAnnotation(view: EditorView, from: number, to: number, ann: import("../annotation/AnnotationModel").Annotation): void {
    this.isEditing = true;
    this.editingAnnotationId = ann.id;
    // Set mode to match annotation type & sync global state
    const targetMode: ViewMode = ann.type === "review" ? "reviewing" : "reading";
    if (this.mode !== targetMode) {
      this.mode = targetMode;
      // Sync sidebar + toolbar mode via global callback
      this.cb.onModeSwitch(targetMode);
    }
    // Always force re-render when showing for a (possibly different) annotation,
    // so note content and color indicator are reset to this annotation's values.
    this.renderedMode = null;
    this.noteExpanded = false;
    this.current = { view, from, to };
    this.render();
    this.position(view, from, to);
    // Pre-expand Note area if annotation has text
    const hasNote = ann.noteText || ann.reviewText;
    if (hasNote) {
      this.expandNoteAreaWithText(
        ann.noteText || ann.reviewText || "",
        ann.highlightColor || "yellow",
      );
    }
  }

  hide(): void {
    this.el.style.display = "none";
    this.current = null;
    this.noteExpanded = false;
    this.strikePending = false;
    // If Delete was toggled ON (annotation created) but no Note was saved,
    // keep the annotation — the user's intent to delete is clear.
    // Just clear the local tracking.
    this.pendingStrikeId = null;
    this.editingAnnotationId = null;
    this.isEditing = false;
    // Force re-render on next show (Issue 4: collapse Note area)
    this.renderedMode = null;
  }

  private cleanupPendingStrike(): void {
    this.strikePending = false;
    this.pendingStrikeId = null;
  }

  private position(view: EditorView, from: number, to: number): void {
    // Use the end of selection for positioning — show popover below the
    // selection end so it never overlaps the highlighted text.
    const coordsEnd = view.coordsAtPos(to);
    const coordsStart = view.coordsAtPos(from);
    if (!coordsEnd && !coordsStart) return;
    // Prefer end coords; fall back to start if end is off-screen
    const coords = coordsEnd ?? coordsStart!;
    // Position below the selection line, with a small gap
    const top = coords.bottom + 6;
    // Align left edge with start of selection, but keep within viewport
    const startLeft = coordsStart ? coordsStart.left : coords.left;
    const popoverWidth = this.el.offsetWidth || 200;
    const maxLeft = window.innerWidth - popoverWidth - 8;
    const left = Math.max(8, Math.min(startLeft, maxLeft));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
    this.el.style.display = "flex";
  }

  private render(): void {
    this.el.empty();
    this.noteExpanded = false;
    this.strikePending = false;
    this.pendingStrikeId = null;

    // Single action row (colors/actions + Note button + mode capsule inline)
    if (this.mode === "reviewing") {
      this.renderReviewingActions();
    } else {
      this.renderReadingActions();
    }

    this.renderedMode = this.mode;
  }

  /** Build the inline mode-switching capsule (appended to the action row) */
  private buildModeCapsule(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "mae-popover-capsule" });
    const modes: Array<[ViewMode, string]> = [
      ["reading", "阅读"],
      ["reviewing", "批阅"],
    ];
    for (const [m, label] of modes) {
      const btn = wrap.createEl("button", { text: label });
      if (this.mode === m) btn.addClass("active");
      btn.onmousedown = (e) => {
        e.preventDefault();
        if (m !== this.mode) {
          this.cb.onModeSwitch(m);
        }
      };
    }
  }

  /** Render reading mode action buttons: 4 color dots + divider + Note button + mode capsule */
  private renderReadingActions(): void {
    const row = this.el.createDiv({ cls: "mae-popover-actions" });
    const colors: HighlightColor[] = ["yellow", "blue", "green", "purple"];
    for (const color of colors) {
      const dot = row.createDiv({ cls: `mae-color ${color}` });
      if (color === this.selectedColor) dot.addClass("active");
      dot.title = `${color} 高亮`;
      dot.onmousedown = (e) => {
        e.preventDefault();
        // Update active state on all dots
        row.querySelectorAll(".mae-color").forEach(d => d.removeClass("active"));
        dot.addClass("active");
        this.selectedColor = color;
        if (this.noteExpanded) {
          // Just update the color indicator in the note area (no save yet)
          this.updateNoteColorIndicator();
        } else {
          // Direct highlight — save and hide
          this.cb.onHighlight(color, this.editingAnnotationId ?? undefined);
          this.hide();
        }
      };
    }
    // Vertical divider
    row.createDiv({ cls: "mae-divider" });
    const noteBtn = row.createEl("button", { cls: "mae-note-btn", text: "Note" });
    noteBtn.title = "添加笔记";
    noteBtn.onmousedown = (e) => {
      e.preventDefault();
      this.toggleNoteArea();
    };
    // Mode capsule inline after Note button
    row.createDiv({ cls: "mae-divider" });
    this.buildModeCapsule(row);
  }

  /** Render reviewing mode action buttons: Delete (toggle) + Note + confirm ✓ + mode capsule */
  private renderReviewingActions(): void {
    const row = this.el.createDiv({ cls: "mae-popover-actions" });

    // Delete button (toggle — marks selection as strikethrough)
    const deleteBtn = row.createEl("button", { cls: "mae-delete-btn", text: "Delete" });
    deleteBtn.title = "标记为删除";
    deleteBtn.onmousedown = (e) => {
      e.preventDefault();
      this.strikePending = !this.strikePending;
      deleteBtn.toggleClass("active", this.strikePending);

      if (this.editingAnnotationId) {
        this.cb.onReview("", this.strikePending, this.editingAnnotationId);
      } else if (this.strikePending) {
        if (!this.pendingStrikeId) {
          this.cb.onStrikeCreate().then(id => { this.pendingStrikeId = id; });
        }
      } else {
        if (this.pendingStrikeId) {
          this.cb.onStrikeRemove(this.pendingStrikeId);
          this.pendingStrikeId = null;
        }
      }

      this.updateStrikeIndicator();
      this.updateReviewConfirmState();
    };

    // Note button
    const noteBtn = row.createEl("button", { cls: "mae-note-btn", text: "Note" });
    noteBtn.title = "添加批阅意见";
    noteBtn.onmousedown = (e) => {
      e.preventDefault();
      this.toggleNoteArea();
    };

    // Confirm button — visible only when Delete is on and Note is NOT expanded
    const confirmBtn = row.createEl("button", { cls: "mae-review-confirm-btn", text: "✓" });
    confirmBtn.title = "确认删除";
    confirmBtn.style.display = "none";
    confirmBtn.onmousedown = (e) => {
      e.preventDefault();
      if (this.editingAnnotationId) {
        this.hide();
      } else {
        this.pendingStrikeId = null;
        this.hide();
      }
    };

    // Mode capsule inline
    row.createDiv({ cls: "mae-divider" });
    this.buildModeCapsule(row);
  }

  /** Update confirm button visibility based on strike state and note expansion */
  private updateReviewConfirmState(): void {
    const confirmBtn = this.el.querySelector(".mae-review-confirm-btn") as HTMLElement;
    if (confirmBtn) {
      confirmBtn.style.display = (this.strikePending && !this.noteExpanded) ? "" : "none";
    }
  }

  /** Update "删除" indicator — no-op now (header removed from note area) */
  private updateStrikeIndicator(): void {
    // Header row removed; strike state is tracked via strikePending only
  }

  /** Update the note area color indicator — no-op now (color shown via dot active state) */
  private updateNoteColorIndicator(): void {
    // Color indicator is now shown via active ring on the color dots in the action row
  }

  /** Expand the Note area with pre-filled text (used when editing an existing annotation) */
  private expandNoteAreaWithText(text: string, color: HighlightColor): void {
    // noteExpanded must be false here (caller ensures it before calling)
    this.selectedColor = color;
    this.toggleNoteArea();
    // Pre-fill the input with existing text
    const input = this.el.querySelector(".mae-popover-note-input") as HTMLInputElement;
    if (input) {
      input.value = text;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
  }

  /** Toggle the Note input area below the action row */
  private toggleNoteArea(): void {
    if (this.noteExpanded) {
      // Collapse: remove note area
      const area = this.el.querySelector(".mae-popover-note-area");
      if (area) area.remove();
      this.noteExpanded = false;
      // Show confirm button again if strike is pending
      this.updateReviewConfirmState();
      // Reposition since height changed
      if (this.current) this.position(this.current.view, this.current.from, this.current.to);
      return;
    }

    // Expand: add note area
    this.noteExpanded = true;
    // Hide confirm button (note area has its own Save)
    this.updateReviewConfirmState();

    const area = this.el.createDiv({ cls: "mae-popover-note-area" });

    // Input wrapper (no header — color is shown via active state on dots above)
    const inputWrap = area.createDiv({ cls: "mae-popover-note-input-wrap" });
    const input = inputWrap.createEl("input", {
      type: "text",
      cls: "mae-popover-note-input",
    });
    input.placeholder = this.mode === "reviewing"
      ? "输入批阅意见，AI 会推断要怎么改…"
      : "为这段高亮添加笔记…";

    // Footer row: Save button
    const footer = area.createDiv({ cls: "mae-popover-note-footer" });
    const saveBtn = footer.createEl("button", { cls: "mae-popover-note-save", text: "Save" });

    // Wire events
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        if (text) {
          this.saveNote(text);
        }
      } else if (e.key === "Escape") {
        this.hide();
      }
    };

    saveBtn.onmousedown = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text) {
        this.saveNote(text);
      }
    };

    // Reposition since height changed
    if (this.current) this.position(this.current.view, this.current.from, this.current.to);

    // Auto-focus the input after a tick (mousedown → mouseup → focus)
    requestAnimationFrame(() => input.focus());
  }

  /** Save a note from the expanded input area */
  private saveNote(text: string): void {
    const editId = this.editingAnnotationId ?? undefined;
    if (this.mode === "reviewing") {
      // If there's a pending strike annotation, update it with the note text
      if (this.pendingStrikeId) {
        this.cb.onReview(text, true, this.pendingStrikeId);
        this.pendingStrikeId = null; // annotation is no longer "pending"
      } else {
        this.cb.onReview(text, this.strikePending, editId);
      }
    } else {
      this.cb.onNote(text, this.selectedColor, editId);
    }
    this.hide();
  }
}
