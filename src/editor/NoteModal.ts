import { App, MarkdownView, Modal, Setting } from "obsidian";
import { t } from "../i18n/i18n";

/** Lightweight modal for note input — used by the desktop popover and the
 * mobile bottom toolbar alike. */
export class NoteModal extends Modal {
  private value: string;
  private onSubmit: (text: string) => void;
  constructor(app: App, initial = "", onSubmit: (text: string) => void) {
    super(app);
    this.value = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("notemodal.note.title") });
    new Setting(contentEl).setName(t("notemodal.note.content")).addTextArea((t) => {
      t.setValue(this.value).onChange((v) => {
        this.value = v;
      });
      t.inputEl.addClass("prm-input-full-width");
      t.inputEl.addClass("prm-input-min-height");
      // Enter to submit when not holding shift
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t("common.save")).setCta().onClick(() => this.submit()));
  }

  private submit(): void {
    const v = this.value.trim();
    if (!v) {
      this.close();
      return;
    }
    this.onSubmit(v);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Lightweight modal for review input. Same shape as NoteModal but separate
 * to leave room for v0.2 strike toggle in the modal. */
export class ReviewModal extends Modal {
  private value: string;
  private strike: boolean;
  private isEdit: boolean;
  private onSubmit: (text: string, strike: boolean) => void;

  constructor(
    app: App,
    initial: { text?: string; strike?: boolean; isEdit?: boolean } = {},
    onSubmit: (text: string, strike: boolean) => void,
  ) {
    super(app);
    this.value = initial.text ?? "";
    this.strike = initial.strike ?? false;
    this.isEdit = initial.isEdit ?? false;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("notemodal.review.title") });
    new Setting(contentEl).setName(t("notemodal.review.content")).addTextArea((t) => {
      t.setValue(this.value).onChange((v) => {
        this.value = v;
      });
      t.inputEl.addClass("prm-input-full-width");
      t.inputEl.addClass("prm-input-min-height");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl)
      .setName(t("notemodal.review.strikethrough"))
      .setDesc(t("notemodal.review.strikethroughDesc"))
      .addToggle((t) => t.setValue(this.strike).onChange((v) => (this.strike = v)));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t("common.save")).setCta().onClick(() => this.submit()));
  }

  private submit(): void {
    // In edit mode, always allow submit (user may be clearing strike/text).
    // In create mode, skip if there's nothing meaningful to save.
    if (!this.isEdit && !this.value.trim() && !this.strike) {
      this.close();
      return;
    }
    this.onSubmit(this.value.trim(), this.strike);
    this.close();
  }
}

/** Helper: get the active editor view (markdown only). */
export function activeMarkdownView(app: App): MarkdownView | null {
  return app.workspace.getActiveViewOfType(MarkdownView);
}
