import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";
import { registerIcons } from "./utils/icons";
import { t, initI18n } from "./i18n/i18n";

// Inline SVG assets at build time via esbuild text loader
import logoSvg from "../img/logo.svg";
import emptyStateSvg from "../img/empty-state.svg";

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
  PromptuarySettings,
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
import { revealInFileManager } from "./utils/FolderOpener";
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
} from "./agent/TerminalLauncher";
import { CommandConfirmModal } from "./agent/CommandConfirmModal";
import { AgentSelectModal } from "./agent/AgentSelectModal";
import { DiffModal } from "./diff/DiffModal";

// v0.4 API Key direct call
import {
  callAPI,
  API_SYSTEM_PROMPT,
  buildAPIUserMessage,
  APIProviderConfig,
} from "./api/APIProvider";
import { APIConfirmModal, APIProgressModal } from "./api/APIExecuteModal";
import { buildReviewMarkdown, estimateTokens } from "./export/Exporters";

/** UTF-8 safe base64 encoding (replaces deprecated unescape + btoa) */
function utf8ToBase64(str: string): string {
	return btoa(Array.from(new TextEncoder().encode(str), (b) => String.fromCodePoint(b)).join(""));
}

export default class PromptuaryPlugin extends Plugin {
  settings: PromptuarySettings = DEFAULT_SETTINGS;
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

  /** Logo SVG data URI (inlined at build time) */
  logoUrl = `data:image/svg+xml;base64,${utf8ToBase64(logoSvg)}`;

  /** Empty state SVG data URI (inlined at build time) */
  emptyStateUrl = `data:image/svg+xml;base64,${utf8ToBase64(emptyStateSvg)}`;

  /** Execution state visible to sidebar for status display */
  executionState: null | { type: "agent" | "api" } = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    initI18n(this.settings.language);

    // Register custom icons
    registerIcons();

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
    this.addRibbonIcon("highlighter", t("main.ribbonTooltip"), () => { void this.openSidebar(); });
    this.addCommand({
      id: "open-sidebar",
      name: t("main.cmd.openSidebar"),
      callback: () => { void this.openSidebar(); },
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
    this.registerDomEvent(activeDocument, "selectionchange", () => this.onSelectionChange());
    this.registerDomEvent(activeDocument, "mousedown", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".promptuary-popover")) return;
      if (target.closest(".cm-editor")) {
        this.isDraggingSelection = true;
        this.popover?.hide();
      }
    });
    this.registerDomEvent(activeDocument, "mouseup", () => {
      if (this.isDraggingSelection) {
        this.isDraggingSelection = false;
        window.setTimeout(() => this.onSelectionChange(), 0);
      }
    });

    // Re-decorate when active leaf changes or annotations change
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => { void this.refreshDecorations(); }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => { void this.refreshDecorations(); }),
    );
    this.store.on("change", (path: string) => {
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (md?.file?.path === path) { void this.refreshDecorations(); }
    });

    // v0.1 commands
    this.addCommand({
      id: "highlight-yellow",
      name: t("main.cmd.highlightYellow"),
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        void this.createHighlightFromSelection("yellow");
        return true;
      },
    });
    this.addCommand({
      id: "create-note",
      name: t("main.cmd.addNote"),
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        void this.openNoteModalForSelection();
        return true;
      },
    });
    this.addCommand({
      id: "create-review",
      name: t("main.cmd.addReview"),
      editorCheckCallback: (checking, _ed, view) => {
        if (!view.file) return false;
        if (checking) return true;
        void this.openReviewModalForSelection();
        return true;
      },
    });
    this.addCommand({
      id: "export-review",
      name: t("main.cmd.exportReview"),
      callback: () => { void this.runExport(); },
    });
    this.addCommand({
      id: "copy-prompt",
      name: t("main.cmd.copyPrompt"),
      callback: () => { void this.runCopyPrompt(); },
    });

    // v0.2: Agent commands
    this.registerAgentCommands();

    // v0.4: API command
    this.addCommand({
      id: "api-execute",
      name: t("main.cmd.apiExecute"),
      callback: () => { void this.runAPIExecute(); },
    });

    // Open sidebar on first install
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE).length === 0) {
        void this.openSidebar();
      } else {
        void this.refreshDecorations();
      }
    });
  }

  onunload(): void {
    void this.store.flushAll();
    this.store.destroy();
    this.popover?.destroy();
    this.toolbar?.destroy();
    this.fileChangeMonitor?.cancel();
    // Note: intentionally NOT calling detachLeavesOfType — Obsidian handles leaf cleanup on plugin unload
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migration: auto-migrate from visible export dirs to hidden .promptuary/exports
    const legacyExportDirs = ["Promptuary/exports", "MultiAIEdit/exports", ".multiaiedit/exports"];
    if (legacyExportDirs.includes(this.settings.exportDir)) {
      this.settings.exportDir = DEFAULT_SETTINGS.exportDir;
      await this.saveSettings();
    }
    // Migration: sidecarDir .multiaiedit → .promptuary
    if (this.settings.sidecarDir === ".multiaiedit/annotations") {
      this.settings.sidecarDir = DEFAULT_SETTINGS.sidecarDir;
      await this.saveSettings();
    }
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
        name: t("main.cmd.runAgent", { label: rule.label }),
        callback: () => { void this.runAgent(rule.id); },
      });
    }
    // Register "copy command" as a universal fallback
    this.addCommand({
      id: "copy-agent-command",
      name: t("main.cmd.copyAgentCommand"),
      callback: () => { void this.runCopyAgentCommand(); },
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
      new Notice(t("main.notice.openMdFile"));
      return;
    }

    const apiSettings = this.settings.apiSettings;
    if (!apiSettings.apiKey) {
      new Notice(t("main.notice.configureAPIKey"));
      return;
    }

    await this.store.flushAll();
    const data = await this.store.getFile(targetPath);
    const reviews = data.annotations.filter((a) => a.type === "review");
    if (reviews.length === 0) {
      new Notice(t("main.notice.noReviewAnnotations"));
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      new Notice(t("export.notice.fileNotFound"));
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
      progressModal.setState({ phase: "error", message: apiResult.error ?? t("common.error") });
      await resultPromise;
      return;
    }

    progressModal.setState({ phase: "done", text: apiResult.text });
    const modifiedText = await resultPromise;

    if (!modifiedText) return; // user closed / error

    // Diff flow (same as CLI)
    if (originalText === modifiedText) {
      new Notice(t("main.notice.noChangesNeeded"));
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
        new Notice(t("main.notice.allAccepted"));
        break;
      }
      case "accept-partial": {
        if (diffResult.mergedText !== undefined) {
          await this.app.vault.modify(file, diffResult.mergedText);
          await this.reanchorAndConfirm(targetPath, originalText, diffResult.mergedText);
          new Notice(t("main.notice.selectedApplied"));
        }
        break;
      }
      case "reject": {
        new Notice(t("main.notice.cancelledNoChange"));
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
      new Notice(t("main.notice.mobileNoAgent"));
      return;
    }

    const rule = this.commandRuleStore.getById(ruleId);
    if (!rule) {
      new Notice(t("main.notice.ruleNotFound", { id: ruleId }));
      return;
    }

    const targetPath = this.resolveTargetMarkdownPath();
    if (!targetPath) {
      new Notice(t("main.notice.openMdFile"));
      return;
    }

    // Check for review annotations
    await this.store.flushAll();
    const data = await this.store.getFile(targetPath);
    if (data.annotations.filter((a) => a.type === "review").length === 0) {
      new Notice(t("main.notice.noReviewAnnotations"));
      return;
    }

    // Generate instruction file
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      new Notice(t("export.notice.fileNotFound"));
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
      rule,
      instructionFilePath,
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
      new Notice(t("main.notice.mobileNoAgent"));
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
      new Notice(t("main.notice.openMdFile"));
      return;
    }

    // Show agent selection — for now, use the first installed agent
    // or show all with a Notice
    const agents = this.getAgentInfo();
    const installed = agents.filter((a) => a.installed);

    if (installed.length === 0) {
      new Notice(t("main.notice.noAgentCLI"));
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
    new Notice(t("main.notice.commandCopied", { label: rule.label }));
  }

  /** Start monitoring a file for changes after CLI execution.
   *  After each detected change + Diff confirmation, restarts monitoring
   *  so subsequent batched writes from the Agent are also caught. */
  private startFileMonitoring(filePath: string): void {
    this.fileChangeMonitor?.cancel();
    this.fileChangeMonitor = new FileChangeMonitor();

    new Notice(t("main.notice.monitoringChanges"));

    const loop = async (): Promise<void> => {
      const monitor = new FileChangeMonitor();
      this.fileChangeMonitor = monitor;

      const detected = await monitor.startMonitor(this.app, filePath);
      if (!detected) {
        new Notice(t("main.notice.monitorTimeout"));
        this.fileChangeMonitor = null;
        return;
      }

      new Notice(t("main.notice.changeDetected"));
      await this.showDiffForFile(filePath);

      // If user accepted/rejected and the agent might still be writing,
      // restart monitoring automatically unless originalText was cleared
      // (which signals the user chose "reject" / flow is done).
      if (this.originalTextBeforeAgent !== null) {
        // Still have a snapshot — continue monitoring for next batch
        void loop();
      } else {
        this.fileChangeMonitor = null;
      }
    };

    void loop();
  }

  /**
   * Show Diff modal for a file, comparing the saved original text
   * with the current file content.
   *
   * After accept: updates originalTextBeforeAgent to the accepted text,
   * so subsequent agent batches diff against the latest confirmed state.
   * After reject: clears originalTextBeforeAgent to stop the monitor loop.
   */
  async showDiffForFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const original = this.originalTextBeforeAgent;
    if (!original) {
      new Notice(t("main.notice.noOriginalSnapshot"));
      return;
    }

    const modified = await this.app.vault.read(file);
    // Don't clear originalTextBeforeAgent yet — keep it as base for next diff

    // Quick check: any changes?
    if (original === modified) {
      new Notice(t("main.notice.noChangesDetected"));
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
        const finalText = modified;
        await this.reanchorAndConfirm(filePath, original, finalText);
        // Update snapshot to the accepted text for next batch diff
        this.originalTextBeforeAgent = finalText;
        new Notice(t("main.notice.allAccepted"));
        break;
      }
      case "accept-partial": {
        if (result.mergedText !== undefined) {
          await this.app.vault.modify(file, result.mergedText);
          const finalText = result.mergedText;
          await this.reanchorAndConfirm(filePath, original, finalText);
          this.originalTextBeforeAgent = finalText;
          new Notice(t("main.notice.selectedApplied"));
        }
        break;
      }
      case "reject": {
        // Restore original, clear snapshot to stop the monitor loop
        await this.app.vault.modify(file, original);
        this.originalTextBeforeAgent = null;
        void this.refreshDecorations();
        new Notice(t("main.notice.allRolledBack"));
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
    let reviewRemoved = 0;
    let readingRemoved = 0;

    for (const update of updates) {
      const ann = data.annotations.find((a) => a.id === update.id);
      if (!ann) continue;

      if (update.status === "healed" && Object.keys(update.patch).length > 0) {
        // Keep review annotations when the diff mapper can still identify their
        // target range. This intentionally preserves partially changed review
        // anchors, including similarity 0.3~0.7; only fully drifted reviews are
        // considered consumed and removed below.
        await this.store.updateAnnotation(filePath, update.id, update.patch);
        healed++;
      } else if (update.status === "drifted") {
        if (ann.type === "review") {
          // Review annotations are actionable instructions. If their target
          // text cannot be mapped after a confirmed Diff, treat them as consumed
          // by the edit and remove the stale review record.
          await this.store.removeAnnotation(filePath, update.id);
          reviewRemoved++;
          continue;
        }

        // Step 2: Try fuzzyLocate fallback (方案 A) for reading annotations only.
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
          // If a reading annotation cannot be fuzzy-located, its referenced
          // text was most likely deleted/replaced. Remove it instead of asking
          // the user to handle a meaningless drift state.
          await this.store.removeAnnotation(filePath, update.id);
          readingRemoved++;
        }
      }
    }

    // Step 3: Update baseline
    const newHash = await sha256(finalText);
    await this.store.confirmBaseline(filePath, newHash);

    // Step 4: Refresh editor decorations
    void this.refreshDecorations();

    // Notify user
    const parts: string[] = [];
    if (healed > 0) parts.push(t("main.notice.autoHealed", { n: healed }));
    if (reviewRemoved > 0) parts.push(t("main.notice.reviewExecuted", { n: reviewRemoved }));
    if (readingRemoved > 0) parts.push(t("main.notice.invalidReadingRemoved", { n: readingRemoved }));
    if (parts.length > 0) new Notice(parts.join("，"));
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
          if (filePath) { void this.store.updateAnnotation(filePath, annotationId, {
            type: "highlight" as AnnotationType,
            highlightColor: color,
            reviewText: undefined,
            strike: undefined,
            // noteText intentionally omitted — preserve existing note
          }); }
          void this.refreshDecorations();
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
          if (filePath) { void this.store.updateAnnotation(filePath, annotationId, {
            type: "note" as AnnotationType,
            noteText: text,
            highlightColor: color,
            reviewText: undefined,
            strike: undefined,
          }); }
          void this.refreshDecorations();
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
            void this.store.updateAnnotation(filePath, annotationId, patch);
          }
          void this.refreshDecorations();
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
        void this.refreshDecorations();
        return ann.id;
      },
      onStrikeRemove: (annotationId: string) => {
        this.lastSelection = null;
        const filePath = this.findAnnotationFilePath(annotationId);
        if (filePath) {
          void this.store.removeAnnotation(filePath, annotationId);
          void this.refreshDecorations();
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
    void this.refreshDecorations();
  }

  async openNoteModalForSelection(): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice(t("main.notice.selectTextFirst"));
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
      void this.refreshDecorations();
    }).open();
  }

  /** Create a note annotation directly with the given text (from popover inline input) */
  async createNoteFromSelection(text: string, color: HighlightColor): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice(t("main.notice.selectTextFirst"));
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
    void this.refreshDecorations();
  }

  async openReviewModalForSelection(): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice(t("main.notice.selectReviewTextFirst"));
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
      void this.refreshDecorations();
    }).open();
  }

  async createReviewFromSelection(text: string, strike: boolean): Promise<void> {
    const ctx = this.getActiveSelectionContext();
    if (!ctx) {
      new Notice(t("main.notice.selectReviewTextFirst"));
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
    void this.refreshDecorations();
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
    void this.refreshDecorations();
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
      new Notice(t("main.notice.openMdFile"));
      return;
    }
    await this.store.flushAll();
    const data = await this.store.getFile(path);
    const reviewCount = data.annotations.filter((a) => a.type === "review").length;
    if (reviewCount === 0) {
      new Notice(t("main.notice.noReviewAnnotations"));
      return;
    }
    const target = await this.reviewExporter.exportToVault(path, data, {
      includeReadingNotes: this.settings.includeReadingNotesInExport,
    });
    if (target) {
      new Notice(t("main.notice.exportSuccess", { target }));
      // Reveal the exported file in Finder / Explorer
      const result = await revealInFileManager(this.app, target);
      if (!result.success) {
        new Notice(t("folder.notice.openFailed", { error: result.error ?? "" }));
      }
    } else {
      new Notice(t("main.notice.exportFailed"));
    }
  }

  async runCopyPrompt(filePath?: string): Promise<void> {
    const path = filePath ?? this.resolveTargetMarkdownPath();
    if (!path) {
      new Notice(t("main.notice.openMdFile"));
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
    if (leaf) {
      if (typeof this.app.workspace.revealLeaf === "function") {
        this.app.workspace.revealLeaf(leaf);
      } else {
        // Fallback for older Obsidian versions
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
    }
  }
}
