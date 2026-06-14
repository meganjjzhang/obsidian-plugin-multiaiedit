import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { Annotation, ViewMode } from "../annotation/AnnotationModel";
import { AnnotationStore } from "../annotation/AnnotationStore";
import { locate, fuzzyLocate, computeLineHint, computeOccurrenceIndex } from "../annotation/AnnotationLocator";
import type MultiAIEditPlugin from "../main";
import { isMobile } from "../utils/platform";
import { EditorView } from "@codemirror/view";

export const SIDEBAR_VIEW_TYPE = "multiaiedit-sidebar";

export class SidebarView extends ItemView {
  private mode: ViewMode = "reading";
  private currentFilePath: string | null = null;
  private currentHash: string | null = null;
  private baselineMismatch = false;
  private container!: HTMLElement;
  private headerEl!: HTMLElement;
  private contentEl2!: HTMLElement;
  private actionBarEl!: HTMLElement;
  private refreshSeq = 0;
  private modifyDebounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: MultiAIEditPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SIDEBAR_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "MultiAIEdit";
  }
  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.container = this.contentEl.createDiv({ cls: "multiaiedit-sidebar" });
    this.mode = this.plugin.settings.defaultMode;

    // Three-section layout: Header → Scrollable content → Bottom action bar
    this.headerEl = this.container.createDiv({ cls: "mae-sidebar-header" });
    this.contentEl2 = this.container.createDiv({ cls: "mae-sidebar-content" });
    this.actionBarEl = this.container.createDiv({ cls: "mae-sidebar-action-bar" });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()),
    );
    // file-open is the most reliable "user opened a markdown file" signal:
    // active-leaf-change fires for sidebar/settings clicks too, while
    // file-open only fires when a real file is opened in a leaf.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpen(file)),
    );
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (file.path === this.currentFilePath) {
          // Debounce: don't refresh on every keystroke, wait 300ms of silence.
          if (this.modifyDebounceTimer !== null) window.clearTimeout(this.modifyDebounceTimer);
          this.modifyDebounceTimer = window.setTimeout(async () => {
            this.modifyDebounceTimer = null;
            this.currentHash = await this.plugin.store.fileHash(file.path);
            await this.refresh();
          }, 300);
        }
      }),
    );
    this.registerEvent(
      this.plugin.store.on("change", (path: string) => {
        if (path === this.currentFilePath) this.refresh();
      }),
    );
    await this.onActiveLeafChange();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.plugin.onModeChange(mode);
    this.refresh();
  }

  /** Update mode from external source (e.g. popover capsule) without
   *  triggering onModeChange again (avoids circular call). */
  setModeExternal(mode: ViewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.refresh();
  }

  getMode(): ViewMode {
    return this.mode;
  }

  /** Public getter so external code (e.g. main.ts currentMode()) can
   *  read the current mode without bracket-accessing private fields. */
  getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  private async onActiveLeafChange(): Promise<void> {
    // active-leaf-change fires for ANY leaf, including the sidebar itself,
    // settings, etc. We must NOT switch currentFilePath based on this signal
    // unless we have a real markdown view in front of us — otherwise clicking
    // the sidebar would accidentally swap which file's annotations we show.
    //
    // CRUCIALLY: do NOT refresh() unless path actually changed. Calling
    // refresh() here on every leaf switch would empty the container and
    // recreate every button — if the user is in the middle of clicking a
    // sidebar button (mousedown → leaf switches → DOM rebuilt → mouseup
    // lands on nothing), their first click would silently fail and they'd
    // need to click twice.
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      if (active.file.path !== this.currentFilePath) {
        this.currentFilePath = active.file.path;
        this.currentHash = await this.plugin.store.fileHash(active.file.path);
        await this.refresh();
      }
      return;
    }
    // Active leaf is not a markdown view (sidebar, settings, etc.). Keep
    // showing whatever file we were already showing — do nothing.
    if (this.currentFilePath !== null) return;
    // First open: do a one-shot fallback to any open markdown leaf.
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const v = leaf.view as MarkdownView;
      if (v?.file) {
        this.currentFilePath = v.file.path;
        this.currentHash = await this.plugin.store.fileHash(v.file.path);
        break;
      }
    }
    await this.refresh();
  }

  /** Authoritative signal: the user just opened a file. Always switch. */
  private async onFileOpen(file: TFile | null): Promise<void> {
    if (!file) return;
    if (file.extension !== "md") return;
    if (file.path === this.currentFilePath) return;
    this.currentFilePath = file.path;
    this.currentHash = await this.plugin.store.fileHash(file.path);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const myToken = ++this.refreshSeq;
    // Don't empty the container yet — we may yield on `await` below and a
    // newer refresh may take over. Only the winner empties + paints.
    if (!this.currentFilePath) {
      if (myToken !== this.refreshSeq) return;
      this.headerEl.empty();
      this.contentEl2.empty();
      this.actionBarEl.empty();
      this.renderHeader(this.headerEl);
      this.contentEl2.createDiv({ cls: "mae-empty", text: "请打开一个 Markdown 文件" });
      return;
    }
    const data = await this.plugin.store.getFile(this.currentFilePath);
    if (myToken !== this.refreshSeq) return;

    // Auto-heal baseline:
    // 1. hash unchanged → nothing to do.
    // 2. hash changed but every annotation still resolves to `strict` → silently
    //    advance baseline. The user did edit the doc but no annotation is at risk.
    // 3. hash changed AND ≥1 annotation is fuzzy/drifted → show the banner with a
    //    one-click "全部确认" that advances baseline.
    let affected: { fuzzy: number; drifted: number; autoHealed: number } = { fuzzy: 0, drifted: 0, autoHealed: 0 };
    const hashChanged =
      !!data.baselineHash && !!this.currentHash && data.baselineHash !== this.currentHash;
    if (hashChanged) {
      const docText = lastDocText(this);
      if (docText !== null) {
        // Try to auto-heal drifted annotations using fuzzyLocate (方案 A)
        const driftedAnns: Annotation[] = [];
        for (const ann of data.annotations) {
          const r = locate(docText, ann);
          if (r.status === "fuzzy") affected.fuzzy++;
          else if (r.status === "drifted") driftedAnns.push(ann);
        }

        // Attempt fuzzy healing for drifted annotations
        if (driftedAnns.length > 0) {
          for (const ann of driftedAnns) {
            const fuzzyResult = fuzzyLocate(docText, ann);
            if (fuzzyResult.status === "auto-healed" && fuzzyResult.from !== undefined && fuzzyResult.to !== undefined) {
              // Extract new anchor data and silently update the annotation
              const span = this.plugin.settings.contextSpan;
              const ctxStart = Math.max(0, fuzzyResult.from - span);
              const ctxEnd = Math.min(docText.length, fuzzyResult.to + span);
              const newSelectedText = docText.slice(fuzzyResult.from, fuzzyResult.to);
              const newContextBefore = docText.slice(ctxStart, fuzzyResult.from);
              const newContextAfter = docText.slice(fuzzyResult.to, ctxEnd);
              const newLineHint = computeLineHint(docText, fuzzyResult.from);
              const newOccIndex = computeOccurrenceIndex(docText, newSelectedText, fuzzyResult.from);

              await this.plugin.store.updateAnnotation(this.currentFilePath, ann.id, {
                selectedText: newSelectedText,
                contextBefore: newContextBefore,
                contextAfter: newContextAfter,
                lineHint: newLineHint,
                occurrenceIndex: newOccIndex,
              });
              affected.autoHealed++;
            } else {
              affected.drifted++;
            }
          }
        }

        // After auto-healing, check if all annotations are now strict
        const remainingIssues = affected.fuzzy + affected.drifted;
        if (remainingIssues === 0 && this.currentHash) {
          // Self-heal silently — pass `silent` so the store doesn't fire a
          // `change` event that would re-trigger refresh and double-paint.
          await this.plugin.store.confirmBaseline(this.currentFilePath, this.currentHash, true);
          if (myToken !== this.refreshSeq) return;
          this.baselineMismatch = false;
          if (affected.autoHealed > 0) {
            new Notice(`已自动修复 ${affected.autoHealed} 条批注位置`);
          }
        } else {
          this.baselineMismatch = true;
          if (affected.autoHealed > 0) {
            new Notice(`已自动修复 ${affected.autoHealed} 条批注位置，${remainingIssues} 条仍需检查`);
          }
        }
      } else {
        // No doc text yet (probably switching files) — skip check this round
        this.baselineMismatch = false;
      }
    } else {
      this.baselineMismatch = false;
    }

    // We are the winner — paint.
    if (myToken !== this.refreshSeq) return;
    this.paint(data.annotations, affected);
  }

  /** Unified paint: rebuild header, scrollable content, and bottom action bar. */
  private paint(annotations: Annotation[], affected: { fuzzy: number; drifted: number; autoHealed: number }): void {
    // --- Header (fixed top) ---
    this.headerEl.empty();
    this.renderHeader(this.headerEl);

    // --- Scrollable content ---
    this.contentEl2.empty();
    if (this.baselineMismatch) this.renderBannerIn(this.contentEl2, affected);
    this.renderListIn(this.contentEl2, annotations);

    // --- Bottom action bar (fixed bottom, only in reviewing/all mode) ---
    this.actionBarEl.empty();
    const reviewCount = annotations.filter((a) => a.type === "review").length;
    if (this.mode !== "reading") {
      this.renderActionBar(this.actionBarEl, reviewCount);
    }
  }

  /** Render sidebar header: icon + title + settings */
  private renderHeader(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "mae-header-row" });
    const left = row.createDiv({ cls: "mae-header-left" });
    const iconWrap = left.createDiv({ cls: "mae-header-icon" });
    iconWrap.setText("✦");
    left.createSpan({ cls: "mae-header-title", text: "MultiAIEdit" });

    const settingsBtn = row.createEl("button", { cls: "mae-header-settings" });
    settingsBtn.setText("⚙");
    settingsBtn.onclick = () => {
      // Open plugin settings
      (this.app as any).setting?.open();
      (this.app as any).setting?.openTabById?.("multiaiedit");
    };

    // Mode capsule (inside header, below title row)
    const capsule = parent.createDiv({ cls: "mae-mode-capsule" });
    const modes: Array<[ViewMode, string]> = [
      ["reading", "阅读"],
      ["reviewing", "批阅"],
      ["all", "全部"],
    ];
    for (const [m, label] of modes) {
      const btn = capsule.createEl("button", { text: label });
      if (this.mode === m) btn.addClass("active");
      btn.onclick = () => this.setMode(m);
    }
  }

  /** Render bottom action bar: Export + Copy Prompt + Execute with Agent + status */
  private renderActionBar(parent: HTMLElement, reviewCount: number): void {
    // Primary action row
    const row1 = parent.createDiv({ cls: "mae-action-row" });
    const exportBtn = row1.createEl("button", { cls: "mae-action-btn", text: "导出" });
    // Icon prefix via CSS ::before
    exportBtn.onclick = () => {
      if (this.currentFilePath) this.plugin.runExport(this.currentFilePath);
      else this.plugin.runExport();
    };
    const copyBtn = row1.createEl("button", { cls: "mae-action-btn secondary", text: "复制 Prompt" });
    copyBtn.onclick = () => {
      if (this.currentFilePath) this.plugin.runCopyPrompt(this.currentFilePath);
      else this.plugin.runCopyPrompt();
    };

    // Execute with Agent button
    const execBtn = parent.createEl("button", { cls: "mae-action-execute", text: "Agent 执行" });
    execBtn.onclick = () => {
      if (reviewCount === 0) {
        new Notice("当前文件没有批阅意见");
        return;
      }
      // Try first installed agent, fallback to copy command
      const agents = this.plugin.getAgentInfo();
      const installed = agents.filter((a) => a.installed);
      if (installed.length > 0) {
        this.plugin.runAgent(installed[0].rule.id);
      } else {
        this.plugin.runCopyAgentCommand();
      }
    };

    // Status hint
    const status = parent.createDiv({ cls: "mae-action-status" });
    status.createSpan({ cls: "mae-status-dot" });
    status.createSpan({ text: `${reviewCount} 条批阅待执行` });
  }

  /** Render banner inside a given parent element */
  private renderBannerIn(parent: HTMLElement, affected: { fuzzy: number; drifted: number }): void {
    const banner = parent.createDiv({ cls: "mae-banner" });
    const parts: string[] = [];
    if (affected.drifted > 0) parts.push(`${affected.drifted} 条已漂移`);
    if (affected.fuzzy > 0) parts.push(`${affected.fuzzy} 条位置存在歧义`);
    const msg = parts.length > 0
      ? `原文变更后有 ${parts.join("、")}，请检查后确认`
      : "原文已变更，请检查批注";
    banner.createSpan({ text: msg });
    const btn = banner.createEl("button", { text: "全部确认" });
    btn.onclick = async () => {
      if (!this.currentFilePath || !this.currentHash) return;
      await this.plugin.store.confirmBaseline(this.currentFilePath, this.currentHash);
      this.refresh();
      new Notice("baseline 已更新");
    };
  }

  /** Render annotation list inside a given parent element */
  private renderListIn(parent: HTMLElement, all: Annotation[]): void {
    const filtered = all.filter((a) => {
      if (this.mode === "reading") return a.type === "highlight" || a.type === "note";
      if (this.mode === "reviewing") return a.type === "review";
      return true;
    });
    if (filtered.length === 0) {
      parent.createDiv({ cls: "mae-empty", text: emptyText(this.mode) });
      return;
    }
    // Sort by line position when possible, fallback to createdAt
    const docText = lastDocText(this);
    const sorted = [...filtered].sort((a, b) => {
      if (docText) {
        const ra = locate(docText, a);
        const rb = locate(docText, b);
        const fa = ra.from ?? Number.MAX_SAFE_INTEGER;
        const fb = rb.from ?? Number.MAX_SAFE_INTEGER;
        if (fa !== fb) return fa - fb;
      }
      return a.createdAt - b.createdAt;
    });
    for (const ann of sorted) this.renderCard(parent, ann, docText);
  }

  private renderCard(parent: HTMLElement, ann: Annotation, docText: string | null): void {
    const r = docText ? locate(docText, ann) : null;
    const card = parent.createDiv({ cls: "mae-card" });

    // 卡片左侧色条 class
    const colorClass = colorClassFor(ann);
    if (colorClass) card.addClass(colorClass);

    if (r) {
      if (r.status === "fuzzy") card.addClass("fuzzy");
      if (r.status === "auto-healed") card.addClass("auto-healed");
      if (r.status === "drifted") card.addClass("drifted");
    }

    // ── meta 行：类型 chip + 漂移标记 + 删除按钮（所有类型统一） ──
    const meta = card.createDiv({ cls: "mae-card-meta" });
    const tagClass = tagColorClassFor(ann);
    meta.createSpan({ cls: `mae-tag ${tagClass}`, text: tagLabelFor(ann) });
    // 漂移状态
    if (r?.status === "fuzzy")       meta.createSpan({ cls: "mae-card-status-inline", text: "⚠ 位置歧义" });
    if (r?.status === "auto-healed") meta.createSpan({ cls: "mae-card-status-inline", text: "🔧 已自动修复" });
    if (r?.status === "drifted")     meta.createSpan({ cls: "mae-card-status-inline", text: "⚠ 已漂移" });
    // 删除按钮（右推）
    const spacer = meta.createDiv({ cls: "mae-card-meta-spacer" });
    void spacer;
    const delBtn = meta.createEl("button", { cls: "mae-card-del-btn", text: "删除" });
    delBtn.onclick = (e) => {
      e.stopPropagation();
      this.plugin.deleteAnnotation(ann);
    };

    // ── 卡片内容 ──
    if (ann.type === "review") {
      const layout = card.createDiv({ cls: "mae-card-layout" });

      // Left: icon badge
      const badge = layout.createDiv({ cls: "mae-card-badge" });
      if (ann.strike) {
        badge.addClass("strike");
        badge.setText("S");
      } else {
        badge.addClass("review");
        badge.setText("✎");
      }

      // Right: quote + review text + source
      const body = layout.createDiv({ cls: "mae-card-body" });
      const quote = body.createDiv({
        cls: "mae-card-quote mae-quote-orange" + (ann.strike ? " strike" : ""),
      });
      quote.setText(ann.selectedText);

      if (ann.reviewText) {
        const review = body.createDiv({ cls: "mae-card-text mae-text-purple" });
        review.setText(ann.reviewText);
      }

      const fileName = (this.currentFilePath ?? "").split("/").pop() ?? "";
      const source = body.createDiv({ cls: "mae-card-source" });
      source.createSpan({ text: fileName });
      source.createSpan({ text: ` · L.${ann.lineHint}` });
    } else {
      // highlight / note
      const quote = card.createDiv({
        cls: "mae-card-quote" + (ann.strike ? " strike" : ""),
      });
      quote.setText(ann.selectedText);

      if (ann.type === "note" && ann.noteText) {
        card.createDiv({ cls: "mae-card-text", text: ann.noteText });
      }

      const fileName = (this.currentFilePath ?? "").split("/").pop() ?? "";
      const source = card.createDiv({ cls: "mae-card-source" });
      source.createSpan({ text: fileName });
      source.createSpan({ text: ` · L.${ann.lineHint}` });
    }

    card.onclick = () => this.jumpTo(ann);
  }

  private async jumpTo(ann: Annotation): Promise<void> {
    if (!this.currentFilePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentFilePath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const doc = view.editor.getValue();
    const r = locate(doc, ann);
    if (r.status === "drifted" || r.from === undefined || r.to === undefined) {
      new Notice("无法定位该批注，可能已漂移");
      return;
    }
    const fromPos = view.editor.offsetToPos(r.from);
    const toPos = view.editor.offsetToPos(r.to);
    view.editor.setSelection(fromPos, toPos);
    view.editor.scrollIntoView({ from: fromPos, to: toPos }, true);

    // Show popover for the annotation with note expanded if applicable
    const cm: EditorView | undefined = (view.editor as unknown as { cm?: EditorView }).cm;
    if (cm && this.plugin.popover) {
      // Small delay to let scroll settle before positioning
      requestAnimationFrame(() => {
        this.plugin.popover!.showForAnnotation(cm, r.from!, r.to!, ann);
      });
    }
  }
}

function emptyText(mode: ViewMode): string {
  if (mode === "reading") return "还没有阅读标注。\n选中文字后选择高亮颜色或添加笔记。";
  if (mode === "reviewing") return "还没有批阅意见。\n切到批阅模式后选中文字写一句意见。";
  return "这个文档还没有任何标注。";
}

/** 卡片左侧色条的 class（与 .mae-card.color-* 配套）。 */
function colorClassFor(ann: Annotation): string | null {
  if (ann.type === "highlight") {
    return `color-${ann.highlightColor ?? "yellow"}`;
  }
  if (ann.type === "note") {
    // Use the stored highlight color if available, otherwise yellow
    return `color-${ann.highlightColor ?? "yellow"}`;
  }
  if (ann.type === "review") {
    return "color-orange";
  }
  return null;
}

/** 卡片元信息 chip 的颜色 class。 */
function tagColorClassFor(ann: Annotation): string {
  if (ann.type === "highlight") return ann.highlightColor ?? "yellow";
  if (ann.type === "note") return ann.highlightColor ?? "yellow";
  return "orange";
}

/** 卡片元信息 chip 的中文文案。 */
function tagLabelFor(ann: Annotation): string {
  if (ann.type === "highlight") return "高亮";
  if (ann.type === "note") return "笔记";
  if (ann.type === "review") return ann.strike ? "删除" : "批阅";
  return "";
}

/** Get the editor text of the markdown leaf that owns the sidebar's
 * `currentFilePath`, regardless of whether it is the active view. Returns
 * null when no such leaf is open. */
function lastDocText(view: SidebarView): string | null {
  const path = view.getCurrentFilePath();
  if (!path) return null;
  const leaves = view.app.workspace.getLeavesOfType("markdown");
  for (const leaf of leaves) {
    const md = leaf.view as MarkdownView;
    if (md?.file?.path === path) return md.editor.getValue();
  }
  return null;
}
