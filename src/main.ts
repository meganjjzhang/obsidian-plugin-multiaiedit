import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import {
  Annotation,
  AnnotationType,
  HighlightColor,
  ViewMode,
} from "./annotation/AnnotationModel";
import { AnnotationStore } from "./annotation/AnnotationStore";
import {
  computeLineHint,
  computeOccurrenceIndex,
  extractContext,
  locate,
  fuzzyLocate,
} from "./annotation/AnnotationLocator";
import { reanchorAnnotations } from "./annotation/AnchorUpdater";
import {
  annotationDecoratorExtension,
  setAnnotationsEffect,
} from "./editor/AnnotationDecorator";
import { SelectionPopover } from "./editor/SelectionPopover";
import { BottomToolbar } from "./editor/BottomToolbar";
import { NoteModal, ReviewModal } from "./editor/NoteModal";
import {
  DEFAULT_SETTINGS,
  MultiAIEditSettings,
  SettingsTab,
} from "./settings/SettingsTab";
import { SIDEBAR_VIEW_TYPE, SidebarView } from "./sidebar/SidebarView";
import {
  PromptExporter,
  ReviewExporter,
  buildPromptText,
  copyToClipboard as exportCopyToClipboard,
} from "./export/Exporters";
import { newAnnotationId, sha256 } from "./utils/hash";
import { isMobile } from "./utils/platform";
import { EditorView } from "@codemirror/view";

// v0.2 Agent bridge imports
import {
  CommandRuleStore,
  PRESET_RULES,
  CommandRule,
} from "./agent/CommandRuleStore";
import { detectAgents, AgentInfo } from "./agent/AgentDetector";
import { buildCommand, TemplateVars } from "./agent/CommandBuilder";
import {
  launchInTerminal,
  FileChangeMonitor,
  TerminalApp,
} from "./agent/TerminalLauncher";
import { CommandConfirmModal } from "./agent/CommandConfirmModal";
import { AgentSelectModal } from "./agent/AgentSelectModal";
import { DiffModal, DiffModalResult } from "./diff/DiffModal";

// v0.4 API Key direct call
import {
  callAPI,
  API_SYSTEM_PROMPT,
  buildAPIUserMessage,
  APIProviderConfig,
} from "./api/APIProvider";
import { APIConfirmModal, APIProgressModal } from "./api/APIExecuteModal";
import { buildReviewMarkdown, estimateTokens } from "./export/Exporters";

export default class MultiAIEditPlugin extends Plugin {
  settings: MultiAIEditSettings = DEFAULT_SETTINGS;
  store!: AnnotationStore;
  popover: SelectionPopover | null = null;
  private toolbar: BottomToolbar | null = null;
  private reviewExporter!: ReviewExporter;
  private promptExporter!: PromptExporter;

  // v0.2 Agent bridge state
  private commandRuleStore!: CommandRuleStore;
  private agentCache: AgentInfo[] | null = null;
  private fileChangeMonitor: FileChangeMonitor | null = null;
  private originalTextBeforeAgent: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.store = new AnnotationStore(this.app, () => this.settings.sidecarDir);
    this.store.registerVaultEvents();

    this.reviewExporter = new ReviewExporter(this.app, () => this.settings.exportDir);
    this.promptExporter = new PromptExporter(this.app);

    // v0.2: Initialize command rule store
    this.commandRuleStore = new CommandRuleStore();
    this.commandRuleStore.loadFromJSON(this.settings.customCommandRules);

    // CM6 decoration extension
    this.registerEditorExtension(annotationDecoratorExtension());

    // Sidebar view
    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new SidebarView(leaf, this));
    this.addRibbonIcon("highlighter", "MultiAIEdit 侧边栏", () => this.openSidebar());
    this.addCommand({
      id: "open-sidebar",
      name: "打开 MultiAIEdit 侧边栏",
      callback: () => this.openSidebar(),
    });

    // Settings
    this.addSettingTab(new SettingsTab(this.app, this));

    // Selection UI
    if (isMobile()) {
      this.toolbar = new BottomToolbar(this.app, this.popoverCallbacks());
    } else {
      this.popover = new SelectionPopover(this.app, this.popoverCallbacks());
    }

    // Editor selection listener
    this.registerDomEvent(document, "selectionchange", () => this.onSelectionChange());
    this.registerDomEvent(document, "mousedown", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".multiaiedit-popover")) return;
      if (target.closest(".cm-editor")) {
        this.isDraggingSelection = true;
        this.popover?.hide();
      }
    });
    this.registerDomEvent(document, "mouseup", () => {
      if (this.isDraggingSelection) {
        this.isDraggingSelection = false;
        window.setTimeout(() => this.onSelectionChange(), 0);
      }
    });

    // Re-decorate when active leaf changes or annotations change
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshDecorations()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshDecorations()),
    );
    this.store.on("change", (path: string) => {
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (md?.file?.path === path) this.refreshDecorations();
    });

    // v0.1 commands
    this.addCommand({
      id: "highlight-yellow",
      name: "高亮（黄）",
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        this.createHighlightFromSelection("yellow");
        return true;
      },
    });
    this.addCommand({
      id: "create-note",
      name: "添加笔记",
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        this.openNoteModalForSelection();
        return true;
      },
    });
    this.addCommand({
      id: "create-review",
      name: "添加批阅意见",
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        this.openReviewModalForSelection();
        return true;
      },
    });
    this.addCommand({
      id: "export-review",
      name: "导出批阅文件",
      callback: () => this.runExport(),
    });
    this.addCommand({
      id: "copy-prompt",
      name: "复制 Prompt",
      callback: () => this.runCopyPrompt(),
    });

    // v0.2: Agent commands
    this.registerAgentCommands();

    // v0.4: API command
    this.addCommand({
      id: "api-execute",
      name: "API Key 直调执行",
      callback: () => this.runAPIExecute(),
    });

    // Open sidebar on first install
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE).length === 0) {
        this.openSidebar();
      } else {
        this.refreshDecorations();
      }
    });
  }

  async onunload(): Promise<void> {
    await this.store.flushAll();
    this.store.destroy();
    this.popover?.destroy();
    this.toolbar?.destroy();
    this.fileChangeMonitor?.cancel();
    this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---------- v0.2: Agent bridge ----------

  private registerAgentCommands(): void {
    // Register a command for each preset agent
    for (const rule of PRESET_RULES) {
      this.addCommand({
        id: `agent-${rule.id}`,
        name: `使用 ${rule.label} 执行`,
        callback: () => this.runAgent(rule.id),
      });
    }
    // Register "copy command" as a universal fallback
    this.addCommand({
      id: "agent-copy-command",
      name: "复制 Agent 命令",
      callback: () => this.runCopyAgentCommand(),
    });
  }

  /** Get cached agent info, or detect fresh */
  getAgentInfo(): AgentInfo[] {
    if (!this.agentCache) {
      this.agentCache = detectAgents(this.commandRuleStore.allRules());
    }
    return this.agentCache;
  }

  /** Invalidate agent cache (e.g. after settings change) */
  invalidateAgentCache(): void {
    this.agentCache = null;
  }

  // ---------- v0.4: API Key direct call ----------

  async runAPIExecute(): Promise<void> {
    const targetPath = this.resolveTargetMarkdownPath();
    if (!targetPath) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }

    const apiSettings = this.settings.apiSettings;
    if (!apiSettings.apiKey) {
      new Notice("请在设置面板中配置 API Key（设置 → API Key 直调）");
      return;
    }

    await this.store.flushAll();
    const data = await this.store.getFile(targetPath);
    const reviews = data.annotations.filter((a) => a.type === "review");
    if (reviews.length === 0) {
      new Notice("当前文件没有批阅意见");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原文件");
      return;
    }

    const originalText = await this.app.vault.read(file);
    const fileName = file.basename;

    // Build message content
    const reviewMd = buildReviewMarkdown(
      fileName,
      targetPath,
      data,
      { includeReadingNotes: this.settings.includeReadingNotesInExport },
    );
    const userMessage = buildAPIUserMessage(originalText, reviewMd);
    const estTokens = estimateTokens(API_SYSTEM_PROMPT + userMessage);

    // Confirm modal
    const config: APIProviderConfig = {
      provider: apiSettings.provider,
      apiKey: apiSettings.apiKey,
      model: apiSettings.model,
      customEndpoint: apiSettings.customEndpoint,
      maxTokens: apiSettings.maxTokens,
    };

    const confirmResult = await new APIConfirmModal(
      this.app,
      config,
      estTokens,
      reviews.length,
    ).openForResult();

    if (confirmResult.action !== "execute") return;

    // Progress modal + API call
    const progressModal = new APIProgressModal(this.app);
    const resultPromise = progressModal.openForResult();
    progressModal.setState({ phase: "calling" });

    const apiResult = await callAPI(config, {
      systemPrompt: API_SYSTEM_PROMPT,
      userMessage,
    });

    if (!apiResult.success || !apiResult.text) {
      progressModal.setState({ phase: "error", message: apiResult.error ?? "未知错误" });
      await resultPromise;
      return;
    }

    progressModal.setState({ phase: "done", text: apiResult.text });
    const modifiedText = await resultPromise;

    if (!modifiedText) return; // user closed / error

    // Diff flow (same as CLI)
    if (originalText === modifiedText) {
      new Notice("API 返回内容与原文相同，无需修改");
      return;
    }

    const diffResult = await new DiffModal(
      this.app,
      originalText,
      modifiedText,
      fileName,
    ).openForResult();

    switch (diffResult.action) {
      case "accept-all": {
        await this.app.vault.modify(file, modifiedText);
        await this.reanchorAndConfirm(targetPath, originalText, modifiedText);
        new Notice("已接受所有修改");
        break;
      }
      case "accept-partial": {
        if (diffResult.mergedText !== undefined) {
          await this.app.vault.modify(file, diffResult.mergedText);
          await this.reanchorAndConfirm(targetPath, originalText, diffResult.mergedText);
          new Notice("已应用选中的修改");
        }
        break;
      }
      case "reject": {
        new Notice("已取消，文件未修改");
        break;
      }
    }
  }

  /**
   * Main entry point for v0.2 Agent execution:
   * 1. Generate instruction file (or inline prompt)
   * 2. Build command from template
   * 3. Show confirmation modal
   * 4. Launch in terminal
   * 5. Monitor file for changes
   * 6. Show diff on change detection
   */
  async runAgent(ruleId: string): Promise<void> {
    if (isMobile()) {
      new Notice("移动端暂不支持 Agent 执行，请使用「复制 Prompt」");
      return;
    }

    const rule = this.commandRuleStore.getById(ruleId);
    if (!rule) {
      new Notice(`未找到规则: ${ruleId}`);
      return;
    }

    const targetPath = this.resolveTargetMarkdownPath();
    if (!targetPath) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }

    // Check for review annotations
    await this.store.flushAll();
    const data = await this.store.getFile(targetPath);
    if (data.annotations.filter((a) => a.type === "review").length === 0) {
      new Notice("当前文件没有批阅意见");
      return;
    }

    // Generate instruction file
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原文件");
      return;
    }
    const originalText = await this.app.vault.read(file);
    const fileName = file.basename;

    // Build instruction file path
    const instructionFilePath = `${this.settings.exportDir}/${fileName}-agent-instruction.md`;
    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath
      ?? this.app.vault.getRoot().path;
    const filePathAbsolute = `${vaultPath}/${targetPath}`;
    const instructionContent = buildPromptText(
      fileName,
      filePathAbsolute,
      data,
      { includeReadingNotes: this.settings.includeReadingNotesInExport },
    );

    // Write instruction file to vault
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.settings.exportDir))) {
      await adapter.mkdir(this.settings.exportDir);
    }
    await adapter.write(instructionFilePath, instructionContent);

    // Build command
    const templateVars: TemplateVars = {
      vaultPath,
      instructionFile: instructionFilePath,
      filePath: targetPath,
      fileName: file.name,
      prompt: instructionContent,
    };
    const command = buildCommand(rule, templateVars);

    // Show confirmation modal
    const confirmed = await new CommandConfirmModal(
      this.app,
      command,
      rule.label,
    ).openForConfirmation();

    if (!confirmed) return;

    // Save original text for diff
    this.originalTextBeforeAgent = originalText;

    // Launch in terminal
    launchInTerminal({
      command,
      vaultPath,
      terminalApp: this.settings.terminalApp,
      onLaunched: () => {
        this.startFileMonitoring(targetPath);
      },
      onCopied: () => {
        this.startFileMonitoring(targetPath);
      },
    });
  }

  /**
   * Show AgentSelectModal and run the chosen agent.
   * Called from sidebar when user clicks the Agent 执行 CTA.
   */
  async runAgentWithSelect(): Promise<void> {
    if (isMobile()) {
      new Notice("移动端暂不支持 Agent 执行，请使用「复制 Prompt」");
      return;
    }
    const agents = this.getAgentInfo();
    const { rule } = await new AgentSelectModal(this.app, agents).openForResult();
    if (!rule) return;
    await this.runAgent(rule.id);
  }

  /** Copy the full command to clipboard without executing */
  async runCopyAgentCommand(): Promise<void> {
    const targetPath = this.resolveTargetMarkdownPath();
    if (!targetPath) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }

    // Show agent selection — for now, use the first installed agent
    // or show all with a Notice
    const agents = this.getAgentInfo();
    const installed = agents.filter((a) => a.installed);

    if (installed.length === 0) {
      new Notice("未检测到已安装的 Agent CLI，请先安装 Claude Code / Codex / Aider / Gemini CLI");
      return;
    }

    // If only one agent, use it directly
    if (installed.length === 1) {
      await this.buildAndCopyCommand(installed[0].rule);
      return;
    }

    // Multiple agents: for now, just use the first one
    // A proper UI with selection would be in the sidebar
    await this.buildAndCopyCommand(installed[0].rule);
  }

  private async buildAndCopyCommand(rule: CommandRule): Promise<void> {
    const targetPath = this.resolveTargetMarkdownPath();
    if (!targetPath) return;

    await this.store.flushAll();
    const data = await this.store.getFile(targetPath);
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) return;

    const fileName = file.basename;

    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath
      ?? this.app.vault.getRoot().path;
    const filePathAbsolute = `${vaultPath}/${targetPath}`;
    const instructionFilePath = `${this.settings.exportDir}/${fileName}-agent-instruction.md`;
    const instructionContent = buildPromptText(
      fileName,
      filePathAbsolute,
      data,
      { includeReadingNotes: this.settings.includeReadingNotesInExport },
    );

    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.settings.exportDir))) {
      await adapter.mkdir(this.settings.exportDir);
    }
    await adapter.write(instructionFilePath, instructionContent);

    const templateVars: TemplateVars = {
      vaultPath,
      instructionFile: instructionFilePath,
      filePath: targetPath,
      fileName: file.name,
      prompt: instructionContent,
    };
    const command = buildCommand(rule, templateVars);
    exportCopyToClipboard(command);
    new Notice(`${rule.label} 命令已复制到剪贴板`);
  }

  /** Start monitoring a file for changes after CLI execution */
  private startFileMonitoring(filePath: string): void {
    this.fileChangeMonitor?.cancel();
    this.fileChangeMonitor = new FileChangeMonitor();

    new Notice("正在监听文件变更（5 分钟超时）…");

    this.fileChangeMonitor.startMonitor(this.app, filePath).then(async (detected) => {
      if (detected) {
        new Notice("检测到文件变更，正在生成 Diff…");
        await this.showDiffForFile(filePath);
      } else {
        new Notice("未检测到文件变更，请手动检查");
      }
      this.fileChangeMonitor = null;
    });
  }

  /**
   * Show Diff modal for a file, comparing the saved original text
   * with the current file content.
   */
  async showDiffForFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const original = this.originalTextBeforeAgent;
    if (!original) {
      new Notice("没有保存的原文快照");
      return;
    }

    const modified = await this.app.vault.read(file);
    this.originalTextBeforeAgent = null;

    // Quick check: any changes?
    if (original === modified) {
      new Notice("文件内容未发生变化");
      return;
    }

    const fileName = file.basename;
    const result = await new DiffModal(
      this.app,
      original,
      modified,
      fileName,
    ).openForResult();

    switch (result.action) {
      case "accept-all": {
        // File already has the new content — re-anchor then update baseline
        const finalText = modified;
        await this.reanchorAndConfirm(filePath, original, finalText);
        new Notice("已接受所有修改");
        break;
      }
      case "accept-partial": {
        if (result.mergedText !== undefined) {
          await this.app.vault.modify(file, result.mergedText);
          const finalText = result.mergedText;
          await this.reanchorAndConfirm(filePath, original, finalText);
          new Notice("已应用选中的修改");
        }
        break;
      }
      case "reject": {
        // Restore original — no re-anchor needed (back to baseline)
        await this.app.vault.modify(file, original);
        this.refreshDecorations();
        new Notice("已回滚所有修改");
        break;
      }
    }
  }

  // ---------- mode propagation ----------

  private lastSelection: { cm: EditorView; from: number; to: number } | null = null;
  private isDraggingSelection = false;

  onModeChange(mode: ViewMode): void {
    // Sync sidebar mode (avoid circular setMode→onModeChange)
    const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (leaves.length > 0) {
      (leaves[0].view as SidebarView).setModeExternal(mode);
    }
    this.popover?.setMode(mode);
    this.toolbar?.setMode(mode);
    if (this.lastSelection) {
      const { cm, from, to } = this.lastSelection;
      // Clicking a sidebar capsule moved focus away from the editor and
      // collapsed the visible selection. Re-apply the CM6 selection and pull
      // focus back so the user keeps seeing the highlighted text, then show
      // the popover under the new mode.
      try {
        cm.dispatch({ selection: { anchor: from, head: to } });
        cm.focus();
      } catch {
        // EditorView may have been disposed (e.g. file closed) — fall back to
        // just hiding the popover.
        this.lastSelection = null;
        this.popover?.hide();
        return;
      }
      if (this.popover) this.popover.show(cm, from, to);
      if (this.toolbar) this.toolbar.show();
    }
  }

  private currentMode(): ViewMode {
    const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (leaves.length === 0) return this.settings.defaultMode;
    const view = leaves[0].view as SidebarView;
    return view.getMode();
  }

  /**
   * Re-anchor annotations after a confirmed text change (Agent execution or
   * user edit), then update baseline.
   *
   * Strategy:
   * 1. Use AnchorUpdater (方案 B) to compute precise old→new position mappings
   *    based on the diff between oldText and finalText.
   * 2. Apply "healed" patches to annotations in the store.
   * 3. For any that couldn't be mapped, try fuzzyLocate (方案 A) as fallback.
   * 4. Update baselineHash.
   */
  private async reanchorAndConfirm(
    filePath: string,
    oldText: string,
    finalText: string,
  ): Promise<void> {
    const data = await this.store.getFile(filePath);

    // Step 1: Diff-based re-anchoring (方案 B)
    const updates = reanchorAnnotations(oldText, finalText, data.annotations, this.settings.contextSpan);

    let healed = 0;
    let stillDrifted = 0;

    for (const update of updates) {
      if (update.status === "healed" && Object.keys(update.patch).length > 0) {
        await this.store.updateAnnotation(filePath, update.id, update.patch);
        healed++;
      } else if (update.status === "drifted") {
        // Step 2: Try fuzzyLocate fallback (方案 A)
        const ann = data.annotations.find((a) => a.id === update.id);
        if (ann) {
          const fuzzyResult = fuzzyLocate(finalText, ann);
          if (fuzzyResult.status === "auto-healed" && fuzzyResult.from !== undefined && fuzzyResult.to !== undefined) {
            // Extract new anchor data from the fuzzy-matched position
            const span = this.settings.contextSpan;
            const ctxStart = Math.max(0, fuzzyResult.from - span);
            const ctxEnd = Math.min(finalText.length, fuzzyResult.to + span);
            const newSelectedText = finalText.slice(fuzzyResult.from, fuzzyResult.to);
            const newContextBefore = finalText.slice(ctxStart, fuzzyResult.from);
            const newContextAfter = finalText.slice(fuzzyResult.to, ctxEnd);
            const newLineHint = computeLineHint(finalText, fuzzyResult.from);
            const newOccIndex = computeOccurrenceIndex(finalText, newSelectedText, fuzzyResult.from);

            await this.store.updateAnnotation(filePath, update.id, {
              selectedText: newSelectedText,
              contextBefore: newContextBefore,
              contextAfter: newContextAfter,
              lineHint: newLineHint,
              occurrenceIndex: newOccIndex,
            });
            healed++;
          } else {
            stillDrifted++;
          }
        }
      }
    }

    // Step 3: Update baseline
    const newHash = await sha256(finalText);
    await this.store.confirmBaseline(filePath, newHash);

    // Step 4: Refresh editor decorations
    this.refreshDecorations();

    // Notify user
    if (healed > 0 && stillDrifted > 0) {
      new Notice(`已自动修复 ${healed} 条批注位置，${stillDrifted} 条仍需手动检查`);
    } else if (healed > 0) {
      new Notice(`已自动修复 ${healed} 条批注位置`);
    } else if (stillDrifted > 0) {
      new Notice(`${stillDrifted} 条批注位置已漂移，请手动检查`);
    }
  }

  // ---------- selection handling ----------

  // ---------- selection handling ----------

  private onSelectionChange(): void {
    if (this.isDraggingSelection) return;
    // If the popover is in annotation-editing mode (jumped from sidebar),
    // don't let selectionchange override its state.
    if (this.popover?.isEditing) return;
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!md) return;
    const editor = md.editor;
    const selText = editor.getSelection();
    if (!selText || selText.length === 0) {
      this.lastSelection = null;
      this.popover?.hide();
      return;
    }
    const cm: EditorView | undefined = (editor as unknown as { cm?: EditorView }).cm;
    if (!cm) return;
    const sel = cm.state.selection.main;
    if (sel.from === sel.to) return;
    this.lastSelection = { cm, from: sel.from, to: sel.to };
    const mode = this.currentMode();
    if (this.popover) {
      this.popover.setMode(mode);
      this.popover.show(cm, sel.from, sel.to);
    }
    if (this.toolbar) {
      this.toolbar.setMode(mode);
      this.toolbar.show();
    }
  }

  private popoverCallbacks() {
    /** Collapse the CM6 selection AFTER annotation is created, so selectionchange
     *  doesn't re-show the popover. Must only be called after creation completes. */
    const collapseSelection = () => {
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!md) return;
      const cm: EditorView | undefined = (md.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      const anchor = cm.state.selection.main.head;
      cm.dispatch({ selection: { anchor } });
    };

    return {
      onHighlight: (color: HighlightColor, annotationId?: string) => {
        if (annotationId) {
          // Editing existing — only update color, preserve noteText
          const filePath = this.findAnnotationFilePath(annotationId);
          if (filePath) this.store.updateAnnotation(filePath, annotationId, {
            type: "highlight" as AnnotationType,
            highlightColor: color,
            reviewText: undefined,
            strike: undefined,
            // noteText intentionally omitted — preserve existing note
          });
          this.refreshDecorations();
          this.lastSelection = null;
          collapseSelection();
        } else {
          // New: use current CM selection FIRST, then collapse
          this.createHighlightFromSelection(color).then(() => {
            this.lastSelection = null;
            collapseSelection();
          });
        }
      },
      onNote: (text: string, color: HighlightColor, annotationId?: string) => {
        if (annotationId) {
          const filePath = this.findAnnotationFilePath(annotationId);
          if (filePath) this.store.updateAnnotation(filePath, annotationId, {
            type: "note" as AnnotationType,
            noteText: text,
            highlightColor: color,
            reviewText: undefined,
            strike: undefined,
          });
          this.refreshDecorations();
          this.lastSelection = null;
          collapseSelection();
        } else {
          // New: create with live selection first, then collapse
          this.createNoteFromSelection(text, color).then(() => {
            this.lastSelection = null;
            collapseSelection();
          });
        }
      },
      onReview: (text: string, strike: boolean, annotationId?: string) => {
        if (annotationId) {
          const filePath = this.findAnnotationFilePath(annotationId);
          if (filePath) {
            const patch: Partial<Annotation> = {
              type: "review" as AnnotationType,
              strike,
              noteText: undefined,
              highlightColor: undefined,
            };
            if (text) patch.reviewText = text;
            this.store.updateAnnotation(filePath, annotationId, patch);
          }
          this.refreshDecorations();
          this.lastSelection = null;
          collapseSelection();
        } else {
          this.createReviewFromSelection(text, strike).then(() => {
            this.lastSelection = null;
            collapseSelection();
          });
        }
      },
      onStrikeCreate: async (): Promise<string> => {
        this.lastSelection = null;
        const ctx = this.getActiveSelectionContext();
        if (!ctx) return "";
        const anchor = await this.buildAnchor(
          ctx.file, ctx.doc, ctx.from, ctx.to, ctx.selectedText,
        );
        const ann: Annotation = {
          ...anchor,
          type: "review",
          reviewText: undefined,
          strike: true,
        };
        await this.store.addAnnotation(ctx.file.path, ann);
        this.refreshDecorations();
        return ann.id;
      },
      onStrikeRemove: (annotationId: string) => {
        this.lastSelection = null;
        const filePath = this.findAnnotationFilePath(annotationId);
        if (filePath) {
          this.store.removeAnnotation(filePath, annotationId);
          this.refreshDecorations();
        }
      },
      onModeSwitch: (mode: ViewMode) => {
        this.onModeChange(mode);
      },
    };
  }

  /** Find which file an annotation belongs to by searching open files' sidecars */
  private findAnnotationFilePath(annotationId: string): string | null {
    // First check the active file
    const active = this.resolveTargetMarkdownPath();
    if (active) return active;
    // Fallback: not ideal but annotation filePath is stored in sidecar,
    // not directly accessible from id alone. For now, return null.
    return null;
  }

  // ---------- annotation creation ----------

  private getActiveSelectionContext(): {
    view: MarkdownView;
    file: TFile;
    editor: Editor;
    cm: EditorView;
    from: number;
    to: number;
    selectedText: string;
    doc: string;
  } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;
    const cm: EditorView | undefined = (view.editor as unknown as { cm?: EditorView }).cm;
    if (!cm) return null;
    const sel = cm.state.selection.main;
    if (sel.from === sel.to) return null;
    const doc = cm.state.doc.toString();
    const selectedText = doc.slice(sel.from, sel.to);
    return {
      view,
      file: view.file,
      editor: view.editor,
      cm,
      from: sel.from,
      to: sel.to,
      selectedText,
      doc,
    };
  }

  private async buildAnchor(
    file: TFile,
    doc: string,
    from: number,
    to: number,
    selectedText: string,
  ): Promise<Pick<
    Annotation,
    "id"
    | "filePath"
    | "selectedText"
    | "contextBefore"
    | "contextAfter"
    | "lineHint"
    | "occurrenceIndex"
    | "baselineHash"
    | "createdAt"
    | "updatedAt"
  >> {
    const span = this.settings.contextSpan;
    const { contextBefore, contextAfter } = extractContext(doc, from, to, span);
    const lineHint = computeLineHint(doc, from);
    const occurrenceIndex = computeOccurrenceIndex(doc, selectedText, from);
    const baselineHash = await sha256(doc);
    const now = Date.now();
    return {
      id: newAnnotationId(),
      filePath: file.path,
      selectedText,
      contextBefore,
      contextAfter,
      lineHint,
      occurrenceIndex,
      baselineHash,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createHighlightFromSelection(color: HighlightColor): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) return;
    const anchor = await this.buildAnchor(
      ctx.file,
      ctx.doc,
      ctx.from,
      ctx.to,
      ctx.selectedText,
    );
    const ann: Annotation = {
      ...anchor,
      type: "highlight",
      highlightColor: color,
    };
    await this.store.addAnnotation(ctx.file.path, ann);
    this.refreshDecorations();
  }

  async openNoteModalForSelection(): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice("请先选中要批注的文字");
      return;
    }
    const anchor = await this.buildAnchor(
      ctx.file,
      ctx.doc,
      ctx.from,
      ctx.to,
      ctx.selectedText,
    );
    new NoteModal(this.app, "", async (text) => {
      const ann: Annotation = { ...anchor, type: "note", noteText: text };
      await this.store.addAnnotation(ctx.file.path, ann);
      this.refreshDecorations();
    }).open();
  }

  /** Create a note annotation directly with the given text (from popover inline input) */
  async createNoteFromSelection(text: string, color: HighlightColor): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice("请先选中要批注的文字");
      return;
    }
    const anchor = await this.buildAnchor(
      ctx.file,
      ctx.doc,
      ctx.from,
      ctx.to,
      ctx.selectedText,
    );
    const ann: Annotation = { ...anchor, type: "note", noteText: text, highlightColor: color };
    await this.store.addAnnotation(ctx.file.path, ann);
    this.refreshDecorations();
  }

  async openReviewModalForSelection(): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice("请先选中要批阅的文字");
      return;
    }
    const anchor = await this.buildAnchor(
      ctx.file,
      ctx.doc,
      ctx.from,
      ctx.to,
      ctx.selectedText,
    );
    new ReviewModal(this.app, {}, async (text, strike) => {
      const ann: Annotation = {
        ...anchor,
        type: "review",
        reviewText: text || undefined,
        strike,
      };
      await this.store.addAnnotation(ctx.file.path, ann);
      this.refreshDecorations();
    }).open();
  }

  async createReviewFromSelection(text: string, strike: boolean): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice("请先选中要批阅的文字");
      return;
    }
    const anchor = await this.buildAnchor(
      ctx.file,
      ctx.doc,
      ctx.from,
      ctx.to,
      ctx.selectedText,
    );
    const ann: Annotation = {
      ...anchor,
      type: "review",
      reviewText: text || undefined,
      strike,
    };
    await this.store.addAnnotation(ctx.file.path, ann);
    this.refreshDecorations();
  }

  // ---------- annotation editing ----------

  async editAnnotation(ann: Annotation): Promise<void> {
    if (ann.type === "note") {
      new NoteModal(this.app, ann.noteText ?? "", async (text) => {
        await this.store.updateAnnotation(ann.filePath, ann.id, { noteText: text });
      }).open();
    } else if (ann.type === "review") {
      new ReviewModal(
        this.app,
        { text: ann.reviewText ?? "", strike: ann.strike, isEdit: true },
        async (text, strike) => {
          await this.store.updateAnnotation(ann.filePath, ann.id, {
            reviewText: text || undefined,
            strike,
          });
        },
      ).open();
    } else if (ann.type === "highlight") {
      const order: HighlightColor[] = ["yellow", "blue", "green", "purple"];
      const next = order[(order.indexOf(ann.highlightColor ?? "yellow") + 1) % order.length];
      await this.store.updateAnnotation(ann.filePath, ann.id, { highlightColor: next });
    }
  }

  async deleteAnnotation(ann: Annotation): Promise<void> {
    await this.store.removeAnnotation(ann.filePath, ann.id);
    this.refreshDecorations();
  }

  // ---------- decorations refresh ----------

  async refreshDecorations(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const md = leaf.view as MarkdownView;
      if (!md?.file) continue;
      const cm: EditorView | undefined = (md.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) continue;
      const data = await this.store.getFile(md.file.path);
      cm.dispatch({ effects: setAnnotationsEffect.of(data.annotations) });
    }
  }

  // ---------- export commands ----------

  async runExport(filePath?: string): Promise<void> {
    const path = filePath ?? this.resolveTargetMarkdownPath();
    if (!path) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }
    await this.store.flushAll();
    const data = await this.store.getFile(path);
    if (data.annotations.filter((a) => a.type === "review").length === 0) {
      new Notice("当前文件没有批阅意见");
      return;
    }
    const target = await this.reviewExporter.exportToVault(path, data, {
      includeReadingNotes: this.settings.includeReadingNotesInExport,
    });
    if (target) {
      const f = this.app.vault.getAbstractFileByPath(target);
      if (f instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(f);
      }
    }
  }

  async runCopyPrompt(filePath?: string): Promise<void> {
    const path = filePath ?? this.resolveTargetMarkdownPath();
    if (!path) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }
    await this.store.flushAll();
    const data = await this.store.getFile(path);
    await this.promptExporter.copyToClipboard(path, data, {
      includeReadingNotes: this.settings.includeReadingNotesInExport,
    });
  }

  private resolveTargetMarkdownPath(): string | null {
    // Priority: 1) active markdown view  2) the file the sidebar is currently
    // showing  3) any open markdown leaf. The sidebar's own currentFilePath is
    // the source of truth when the user clicks a sidebar button (sidebar is
    // active leaf, no active markdown view) — otherwise we'd risk swapping
    // files mid-flow.
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active.file.path;
    const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (leaves.length > 0) {
      const sidebar = leaves[0].view as SidebarView;
      const path = sidebar.getCurrentFilePath();
      if (path) return path;
    }
    const mdLeaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of mdLeaves) {
      const v = leaf.view as MarkdownView;
      if (v?.file) return v.file.path;
    }
    return null;
  }

  // ---------- sidebar plumbing ----------

  async openSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (right) {
        await right.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
        leaf = right;
      }
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }
}
