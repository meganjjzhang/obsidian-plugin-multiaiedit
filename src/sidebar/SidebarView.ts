import { ItemView, Menu, MarkdownView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Annotation, ViewMode } from "../annotation/AnnotationModel";
import { AnnotationStore } from "../annotation/AnnotationStore";
import { locate, fuzzyLocate, computeLineHint, computeOccurrenceIndex } from "../annotation/AnnotationLocator";
import type PromptuaryPlugin from "../main";
import { isMobile } from "../utils/platform";
import { EditorView } from "@codemirror/view";
import { t } from "../i18n/i18n";

export const SIDEBAR_VIEW_TYPE = "promptuary-sidebar";

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
  private lastReviewCount = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: PromptuaryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SIDEBAR_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Promptuary";
  }
  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.container = this.contentEl.createDiv({ cls: "promptuary-sidebar" });
    this.mode = this.plugin.settings.defaultMode;

    // Three-section layout: Header → Scrollable content → Bottom action bar
    this.headerEl = this.container.createDiv({ cls: "prm-sidebar-header" });
    this.contentEl2 = this.container.createDiv({ cls: "prm-sidebar-content" });
    this.actionBarEl = this.container.createDiv({ cls: "prm-sidebar-action-bar" });

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
        if (path === this.currentFilePath) void this.refresh();
      }),
    );
    await this.onActiveLeafChange();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.plugin.onModeChange(mode);
    void this.refresh();
  }

  /** Update mode from external source (e.g. popover capsule) without
   *  triggering onModeChange again (avoids circular call). */
  setModeExternal(mode: ViewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    void this.refresh();
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
      this.renderEmptyState(this.contentEl2, t("sidebar.empty.openFile"));
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
    let affected: { fuzzy: number; drifted: number; autoHealed: number; reviewRemoved: number; readingRemoved: number } = { fuzzy: 0, drifted: 0, autoHealed: 0, reviewRemoved: 0, readingRemoved: 0 };
    const hashChanged =
      !!data.baselineHash && !!this.currentHash && data.baselineHash !== this.currentHash;
    if (hashChanged) {
      const docText = lastDocText(this);
      if (docText !== null) {
        // Try to auto-heal unambiguous fuzzy anchors and collect fully drifted annotations.
        const driftedAnns: Annotation[] = [];
        for (const ann of data.annotations) {
          const r = locate(docText, ann);
          if (r.status === "fuzzy") {
            // A single exact selectedText match with stale context is safe to
            // refresh silently. Only multi-candidate fuzzy matches need user review.
            if ((r.candidates?.length ?? 0) === 0 && r.from !== undefined && r.to !== undefined) {
              const span = this.plugin.settings.contextSpan;
              const ctxStart = Math.max(0, r.from - span);
              const ctxEnd = Math.min(docText.length, r.to + span);
              const newSelectedText = docText.slice(r.from, r.to);
              await this.plugin.store.updateAnnotation(this.currentFilePath, ann.id, {
                selectedText: newSelectedText,
                contextBefore: docText.slice(ctxStart, r.from),
                contextAfter: docText.slice(r.to, ctxEnd),
                lineHint: computeLineHint(docText, r.from),
                occurrenceIndex: computeOccurrenceIndex(docText, newSelectedText, r.from),
              });
              affected.autoHealed++;
            } else {
              affected.fuzzy++;
            }
          } else if (r.status === "drifted") driftedAnns.push(ann);
        }

        // Attempt fuzzy healing for drifted annotations
        if (driftedAnns.length > 0) {
          for (const ann of driftedAnns) {
            if (ann.type === "review") {
              // Review annotations are actionable instructions. If the referenced
              // text was manually deleted or can no longer be located, the review
              // is stale/consumed and should not stay as sidebar noise.
              await this.plugin.store.removeAnnotation(this.currentFilePath, ann.id);
              affected.reviewRemoved++;
              continue;
            }

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
              // The referenced text is no longer locatable. Remove stale reading
              // annotations instead of surfacing a drift state to the user.
              await this.plugin.store.removeAnnotation(this.currentFilePath, ann.id);
              affected.readingRemoved++;
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
          const parts: string[] = [];
          if (affected.autoHealed > 0) parts.push(t("sidebar.notice.autoHealed", { n: affected.autoHealed }));
          if (affected.reviewRemoved > 0) parts.push(t("sidebar.notice.reviewAutoRemoved", { n: affected.reviewRemoved }));
          if (affected.readingRemoved > 0) parts.push(t("sidebar.notice.invalidReadingRemoved", { n: affected.readingRemoved }));
          if (parts.length > 0) new Notice(parts.join("，"));
        } else {
          this.baselineMismatch = true;
          const parts: string[] = [];
          if (affected.autoHealed > 0) parts.push(t("sidebar.notice.autoHealed", { n: affected.autoHealed }));
          if (affected.reviewRemoved > 0) parts.push(t("sidebar.notice.reviewAutoRemoved", { n: affected.reviewRemoved }));
          if (affected.readingRemoved > 0) parts.push(t("sidebar.notice.invalidReadingRemoved", { n: affected.readingRemoved }));
          if (remainingIssues > 0) parts.push(t("sidebar.notice.ambiguousCheck", { n: remainingIssues }));
          if (parts.length > 0) new Notice(parts.join("，"));
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
    this.lastReviewCount = reviewCount;
    if (this.mode !== "reading") {
      this.renderActionBar(this.actionBarEl, reviewCount);
    }
  }

  /** Render empty state: illustration + hint text */
  private renderEmptyState(parent: HTMLElement, text: string): void {
    const wrap = parent.createDiv({ cls: "prm-empty-state" });
    if (this.plugin.emptyStateUrl) {
      const img = wrap.createEl("img", { cls: "prm-empty-state-img" });
      img.src = this.plugin.emptyStateUrl;
      img.alt = "";
    }
    wrap.createDiv({ cls: "prm-empty-state-text", text });
  }

  /** Render sidebar header: icon + title + settings */
  private renderHeader(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "prm-header-row" });
    const left = row.createDiv({ cls: "prm-header-left" });
    const iconWrap = left.createDiv({ cls: "prm-header-icon" });
    if (this.plugin.logoUrl) {
      const img = iconWrap.createEl("img", { cls: "prm-logo-img" });
      img.src = this.plugin.logoUrl;
      img.alt = "Promptuary";
    } else {
      setIcon(iconWrap, "prm-highlighter");
    }
    left.createSpan({ cls: "prm-header-title", text: "Promptuary" });

    const settingsBtn = row.createEl("button", { cls: "prm-header-settings" });
    setIcon(settingsBtn, "settings");
    settingsBtn.onclick = () => {
      const appInternal = this.app as unknown as { setting?: { open(): void; openTabById?(id: string): void } };
      appInternal.setting?.open();
      appInternal.setting?.openTabById?.("promptuary");
    };

    // Mode capsule (inside header, below title row)
    const capsule = parent.createDiv({ cls: "prm-mode-capsule" });
    const modes: Array<[ViewMode, string]> = [
      ["reading", t("sidebar.mode.reading")],
      ["reviewing", t("sidebar.mode.review")],
      ["all", t("sidebar.mode.all")],
    ];
    for (const [m, label] of modes) {
      const btn = capsule.createEl("button", { text: label });
      if (this.mode === m) btn.addClass("active");
      btn.onclick = () => this.setMode(m);
    }
  }

  /** Render bottom action bar: Row1 Agent CTA + Row2 API批阅/复制Prompt/查看批注文件 */
  private renderActionBar(parent: HTMLElement, reviewCount: number): void {
    const hasReviews = reviewCount > 0;
    const executing = this.plugin.executionState;
    const isExecuting = executing !== null;

    // Row 1: Agent 批阅（紫色 CTA 主按钮，桌面端）
    if (!isMobile()) {
      const execBtn = parent.createEl("button", { cls: "prm-action-execute" });
      setIcon(execBtn, "sparkles");
      execBtn.title = t("sidebar.action.agentTitle");
      const isAgentExecuting = isExecuting && executing.type === "agent";
      if (isAgentExecuting) {
        execBtn.createSpan({ text: t("sidebar.status.agentRunning") });
      } else {
        execBtn.createSpan({ text: t("sidebar.action.agentReview") });
      }
      execBtn.disabled = !hasReviews || isExecuting;
      if (isAgentExecuting) execBtn.addClass("prm-executing");
      execBtn.onclick = async () => {
        if (!hasReviews || isExecuting) return;
        if (!hasReviews) { new Notice(t("main.notice.noReviewAnnotations")); return; }
        this.plugin.executionState = { type: "agent" };
        this.reRenderActionBar();
        try {
          await this.plugin.runAgentWithSelect();
        } finally {
          this.plugin.executionState = null;
          void this.refresh();
        }
      };
    }

    // Row 2: API批阅 + 复制Prompt + 查看批注文件
    const row2 = parent.createDiv({ cls: "prm-action-row" });

    // API 批阅
    const hasApiKey = !!this.plugin.settings.apiSettings?.apiKey;
    const isApiExecuting = isExecuting && executing.type === "api";
    const apiBtn = row2.createEl("button", { cls: "prm-action-btn" });
    setIcon(apiBtn, "zap");
    if (isApiExecuting) {
      apiBtn.createSpan({ cls: "prm-action-short", text: "API" });
      apiBtn.createSpan({ cls: "prm-action-long", text: ` ${t("sidebar.mode.review")}…` });
    } else {
      apiBtn.createSpan({ cls: "prm-action-short", text: "API" });
      apiBtn.createSpan({ cls: "prm-action-long", text: ` ${t("sidebar.mode.review")}` });
    }
    apiBtn.title = hasApiKey ? t("sidebar.action.apiTitle") : t("sidebar.action.noApiKey");
    apiBtn.disabled = !hasApiKey || isExecuting;
    if (isApiExecuting) apiBtn.addClass("prm-executing");
    apiBtn.onclick = async () => {
      if (!hasApiKey || isExecuting) return;
      this.plugin.executionState = { type: "api" };
      this.reRenderActionBar();
      try {
        await this.plugin.runAPIExecute();
      } finally {
        this.plugin.executionState = null;
        void this.refresh();
      }
    };

    // 复制 Prompt
    const copyBtn = row2.createEl("button", { cls: "prm-action-btn" });
    setIcon(copyBtn, "clipboard-copy");
    copyBtn.createSpan({ cls: "prm-action-short", text: "Prompt" });
    copyBtn.createSpan({ cls: "prm-action-long", text: ` ${t("sidebar.action.copy")}` });
    copyBtn.title = t("sidebar.action.copyTitle");
    copyBtn.disabled = !hasReviews || isExecuting;
    copyBtn.onclick = () => {
      if (this.currentFilePath) void this.plugin.runCopyPrompt(this.currentFilePath);
      else void this.plugin.runCopyPrompt();
    };

    // … 按钮（下拉菜单：导出批注文件）
    const moreBtn = row2.createEl("button", { cls: "prm-action-btn prm-more-btn" });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.title = t("sidebar.action.exportTitle");
    moreBtn.disabled = !hasReviews || isExecuting;
    moreBtn.onclick = () => {
      if (!hasReviews || isExecuting) return;
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle(t("sidebar.action.exportFile"))
          .setIcon("file-text")
          .onClick(async () => {
            if (this.currentFilePath) await this.plugin.runExport(this.currentFilePath);
            else await this.plugin.runExport();
          });
      });
      const rect = moreBtn.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.top - 4 });
    };

    // Status hint
    const status = parent.createDiv({ cls: "prm-action-status" });
    if (isExecuting) {
      status.createSpan({ cls: "prm-status-dot prm-status-dot-executing" });
      status.createSpan({ text: executing.type === "agent" ? t("sidebar.status.agentRunning") : t("sidebar.status.apiRunning") });
    } else {
      status.createSpan({ cls: "prm-status-dot" });
      status.createSpan({ text: t("sidebar.status.pendingReview", { n: reviewCount }) });
    }
  }

  /** Re-render just the bottom action bar (no store re-read) */
  private reRenderActionBar(): void {
    this.actionBarEl.empty();
    if (this.mode !== "reading") {
      this.renderActionBar(this.actionBarEl, this.lastReviewCount);
    }
  }

  /** Render banner inside a given parent element */
  private renderBannerIn(parent: HTMLElement, affected: { fuzzy: number; drifted: number }): void {
    const banner = parent.createDiv({ cls: "prm-banner" });
    const parts: string[] = [];
    if (affected.drifted > 0) parts.push(t("sidebar.banner.drifted", { n: affected.drifted }));
    if (affected.fuzzy > 0) parts.push(t("sidebar.banner.ambiguous", { n: affected.fuzzy }));
    const msg = parts.length > 0
      ? `${t("sidebar.banner.changed")} ${parts.join("、")}，${t("sidebar.banner.changedFull")}`
      : t("sidebar.banner.changedFull");
    banner.createSpan({ text: msg });
    const btn = banner.createEl("button", { text: t("sidebar.banner.confirmAll") });
    btn.onclick = async () => {
      if (!this.currentFilePath || !this.currentHash) return;
      await this.plugin.store.confirmBaseline(this.currentFilePath, this.currentHash);
      void this.refresh();
      new Notice(t("sidebar.banner.baselineUpdated"));
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
      this.renderEmptyState(parent, emptyText(this.mode));
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
    const card = parent.createDiv({ cls: "prm-card" });

    // 卡片左侧色条 class
    const colorClass = colorClassFor(ann);
    if (colorClass) card.addClass(colorClass);

    if (r) {
      if (r.status === "fuzzy") card.addClass("fuzzy");
      if (r.status === "auto-healed") card.addClass("auto-healed");
      if (r.status === "drifted") card.addClass("drifted");
    }

    // ── meta 行：类型 chip + 漂移标记 + 删除按钮（所有类型统一） ──
    const meta = card.createDiv({ cls: "prm-card-meta" });
    const tagClass = tagColorClassFor(ann);
    meta.createSpan({ cls: `prm-tag ${tagClass}`, text: tagLabelFor(ann) });
    // 漂移状态
    if (r?.status === "fuzzy")       { const s = meta.createSpan({ cls: "prm-card-status-inline" }); setIcon(s, "alert-triangle"); s.createSpan({ text: ` ${t("sidebar.card.ambiguous")}` }); }
    if (r?.status === "auto-healed") { const s = meta.createSpan({ cls: "prm-card-status-inline" }); setIcon(s, "wrench"); s.createSpan({ text: ` ${t("sidebar.card.autoHealed")}` }); }
    if (r?.status === "drifted")     { const s = meta.createSpan({ cls: "prm-card-status-inline" }); setIcon(s, "alert-triangle"); s.createSpan({ text: ` ${t("sidebar.card.drifted")}` }); }
    // 删除按钮（右推）
    const spacer = meta.createDiv({ cls: "prm-card-meta-spacer" });
    void spacer;
    const delBtn = meta.createEl("button", { cls: "prm-card-del-btn", text: t("sidebar.card.delete") });
    delBtn.onclick = (e) => {
      e.stopPropagation();
      void this.plugin.deleteAnnotation(ann);
    };

    // ── 卡片内容 ──
    if (ann.type === "review") {
      // Quote + review text + source（no icon badge）
      const quote = card.createDiv({
        cls: "prm-card-quote prm-quote-orange" + (ann.strike ? " strike" : ""),
      });
      quote.setText(ann.selectedText);

      if (ann.reviewText) {
        const review = card.createDiv({ cls: "prm-card-text prm-text-purple" });
        review.setText(ann.reviewText);
      }

      const fileName = (this.currentFilePath ?? "").split("/").pop() ?? "";
      const source = card.createDiv({ cls: "prm-card-source" });
      source.createSpan({ text: fileName });
      source.createSpan({ text: ` · L.${ann.lineHint}` });
    } else {
      // highlight / note
      const quote = card.createDiv({
        cls: "prm-card-quote" + (ann.strike ? " strike" : ""),
      });
      quote.setText(ann.selectedText);

      if (ann.type === "note" && ann.noteText) {
        card.createDiv({ cls: "prm-card-text", text: ann.noteText });
      }

      const fileName = (this.currentFilePath ?? "").split("/").pop() ?? "";
      const source = card.createDiv({ cls: "prm-card-source" });
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
      new Notice(t("sidebar.notice.cannotLocate"));
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
      window.requestAnimationFrame(() => {
        this.plugin.popover!.showForAnnotation(cm, r.from!, r.to!, ann);
      });
    }
  }
}

function emptyText(mode: ViewMode): string {
  if (mode === "reading") return t("sidebar.empty.reading");
  if (mode === "reviewing") return t("sidebar.empty.review");
  return t("sidebar.empty.all");
}

/** 卡片左侧色条的 class（与 .prm-card.color-* 配套）。 */
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
  if (ann.type === "highlight") return t("sidebar.tag.highlight");
  if (ann.type === "note") return t("sidebar.tag.note");
  if (ann.type === "review") return ann.strike ? t("sidebar.tag.delete") : t("sidebar.tag.review");
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
