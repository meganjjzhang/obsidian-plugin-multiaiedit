import { App } from "obsidian";
import { HighlightColor, ViewMode } from "../annotation/AnnotationModel";
import { PopoverCallbacks } from "./SelectionPopover";

/**
 * Mobile bottom toolbar — a thin alternative to SelectionPopover that
 * lives at the bottom of the screen so it doesn't fight the OS selection
 * menu. See technical-design.md §6.2.
 *
 * Layout (vertical within the fixed bar):
 * ┌──────────────────────────────────┐
 * │  [阅读] [批阅]      ← 模式胶囊   │
 * ├──────────────────────────────────┤
 * │  （按钮行）                      │
 * ├──────────────────────────────────┤
 * │  （Note 展开区，默认隐藏）        │
 * └──────────────────────────────────┘
 */
export class BottomToolbar {
  private el: HTMLDivElement;
  private mode: ViewMode = "reading";
  private active = false;
  private noteExpanded = false;
  private selectedColor: HighlightColor = "yellow";
  private strikePending = false;
  private pendingStrikeId: string | null = null;

  constructor(private app: App, private cb: PopoverCallbacks) {
    this.el = document.createElement("div");
    this.el.className = "promptuary-bottom-toolbar";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  destroy(): void {
    this.el.remove();
    this.active = false;
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.noteExpanded = false;
    this.strikePending = false;
    this.pendingStrikeId = null;
    if (this.active) this.render();
  }

  show(): void {
    this.active = true;
    this.render();
    this.el.style.display = "flex";
  }

  hide(): void {
    this.active = false;
    this.noteExpanded = false;
    this.strikePending = false;
    this.pendingStrikeId = null;
    this.el.style.display = "none";
  }

  private render(): void {
    this.el.empty();
    this.noteExpanded = false;
    this.strikePending = false;
    this.pendingStrikeId = null;

    // 1. Mode capsule
    this.renderModeCapsule();

    // 2. Action row
    if (this.mode === "reviewing") {
      this.renderReviewingActions();
    } else {
      this.renderReadingActions();
    }
  }

  private renderModeCapsule(): void {
    const wrap = this.el.createDiv({ cls: "prm-popover-capsule" });
    const modes: Array<[ViewMode, string]> = [
      ["reading", "阅读"],
      ["reviewing", "批阅"],
    ];
    for (const [m, label] of modes) {
      const btn = wrap.createEl("button", { text: label });
      if (this.mode === m) btn.addClass("active");
      btn.onclick = () => {
        if (m !== this.mode) {
          this.cb.onModeSwitch(m);
        }
      };
    }
  }

  private renderReadingActions(): void {
    const row = this.el.createDiv({ cls: "prm-popover-actions" });
    const colors: HighlightColor[] = ["yellow", "blue", "green", "purple"];
    for (const color of colors) {
      const dot = row.createDiv({ cls: `prm-color ${color}` });
      dot.title = `${color} 高亮`;
      dot.onclick = () => {
        this.selectedColor = color;
        if (this.noteExpanded) {
          this.updateNoteColorIndicator();
        } else {
          this.cb.onHighlight(color);
          this.hide();
        }
      };
    }
    const noteBtn = row.createEl("button", { text: "Add Note" });
    noteBtn.onclick = () => {
      this.toggleNoteArea();
    };
    const close = row.createEl("button", { text: "×" });
    close.onclick = () => this.hide();
  }

  private renderReviewingActions(): void {
    const row = this.el.createDiv({ cls: "prm-popover-actions" });

    // Delete button (toggle)
    const deleteBtn = row.createEl("button", { cls: "prm-delete-btn", text: "Delete" });
    deleteBtn.title = "标记为删除";
    deleteBtn.onclick = () => {
      this.strikePending = !this.strikePending;
      deleteBtn.toggleClass("active", this.strikePending);

      if (this.strikePending) {
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
    const noteBtn = row.createEl("button", { cls: "prm-note-btn", text: "Add Note" });
    noteBtn.title = "添加批阅意见";
    noteBtn.onclick = () => {
      this.toggleNoteArea();
    };

    // Confirm button
    const confirmBtn = row.createEl("button", { cls: "prm-review-confirm-btn", text: "✓" });
    confirmBtn.title = "确认删除";
    confirmBtn.style.display = "none";
    confirmBtn.onclick = () => {
      // Annotation already created by onStrikeCreate, just hide
      this.pendingStrikeId = null;
      this.hide();
    };

    const close = row.createEl("button", { text: "×" });
    close.onclick = () => this.hide();
  }

  private updateReviewConfirmState(): void {
    const confirmBtn = this.el.querySelector(".prm-review-confirm-btn") as HTMLElement;
    if (confirmBtn) {
      confirmBtn.style.display = (this.strikePending && !this.noteExpanded) ? "" : "none";
    }
  }

  /** Update "删除" indicator in Note area header when Delete is toggled */
  private updateStrikeIndicator(): void {
    const header = this.el.querySelector(".prm-popover-note-header");
    if (!header) return;

    let indicator = header.querySelector(".prm-strike-indicator") as HTMLElement;
    if (this.strikePending) {
      if (!indicator) {
        indicator = header.createSpan({ cls: "prm-strike-indicator", text: "删除" });
      }
    } else {
      if (indicator) indicator.remove();
    }
  }

  private updateNoteColorIndicator(): void {
    const dot = this.el.querySelector(".prm-popover-note-header .prm-note-dot") as HTMLElement;
    const label = this.el.querySelector(".prm-popover-note-header .prm-note-label") as HTMLElement;
    if (!dot || !label) return;
    const colorClasses = ["yellow", "blue", "green", "purple", "orange"];
    for (const c of colorClasses) {
      dot.removeClass(c);
      label.removeClass(c);
    }
    dot.addClass(this.selectedColor);
    label.addClass(this.selectedColor);
  }

  private toggleNoteArea(): void {
    if (this.noteExpanded) {
      const area = this.el.querySelector(".prm-popover-note-area");
      if (area) area.remove();
      this.noteExpanded = false;
      this.updateReviewConfirmState();
      return;
    }

    this.noteExpanded = true;
    this.updateReviewConfirmState();

    const area = this.el.createDiv({ cls: "prm-popover-note-area" });

    // Header row
    const header = area.createDiv({ cls: "prm-popover-note-header" });
    if (this.mode === "reviewing") {
      header.createDiv({ cls: "prm-note-dot orange" });
      header.createDiv({ cls: "prm-divider" });
      header.createSpan({ cls: "prm-note-label orange", text: "批阅" });
      if (this.strikePending) {
        header.createSpan({ cls: "prm-strike-indicator", text: "删除" });
      }
    } else {
      header.createDiv({ cls: `prm-note-dot ${this.selectedColor}` });
      header.createDiv({ cls: "prm-divider" });
      header.createSpan({ cls: `prm-note-label ${this.selectedColor}`, text: "笔记" });
    }

    // Input wrapper
    const inputWrap = area.createDiv({ cls: "prm-popover-note-input-wrap" });
    const input = inputWrap.createEl("input", {
      type: "text",
      cls: "prm-popover-note-input",
    });
    input.placeholder = this.mode === "reviewing"
      ? "输入批阅意见…"
      : "为这段高亮添加笔记…";

    // Footer row
    const footer = area.createDiv({ cls: "prm-popover-note-footer" });
    const saveBtn = footer.createEl("button", { cls: "prm-popover-note-save", text: "Save" });

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        const text = input.value.trim();
        if (text) this.saveNote(text);
      } else if (e.key === "Escape") {
        this.hide();
      }
    };

    saveBtn.onclick = () => {
      const text = input.value.trim();
      if (text) this.saveNote(text);
    };

    requestAnimationFrame(() => input.focus());
  }

  private saveNote(text: string): void {
    if (this.mode === "reviewing") {
      if (this.pendingStrikeId) {
        this.cb.onReview(text, true, this.pendingStrikeId);
        this.pendingStrikeId = null;
      } else {
        this.cb.onReview(text, this.strikePending);
      }
    } else {
      this.cb.onNote(text, this.selectedColor);
    }
    this.hide();
  }
}
