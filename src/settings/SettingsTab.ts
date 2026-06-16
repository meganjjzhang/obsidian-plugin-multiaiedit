import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type PromptuaryPlugin from "../main";
import { ViewMode } from "../annotation/AnnotationModel";
import { CommandRule, CommandRuleStore, PRESET_RULES } from "../agent/CommandRuleStore";
import { detectAgents, AgentInfo } from "../agent/AgentDetector";
import { TerminalApp } from "../agent/TerminalLauncher";
import { APIProviderType, PROVIDER_DEFAULTS } from "../api/APIProvider";
import { isMobile } from "../utils/platform";
import { t, LanguageSetting, Locale, initI18n, setLocale } from "../i18n/i18n";

export interface APISettings {
  provider: APIProviderType;
  apiKey: string;
  model: string;
  customEndpoint: string;
  maxTokens: number;
}

export interface PromptuarySettings {
  language: LanguageSetting;
  defaultMode: ViewMode;
  contextSpan: number;
  sidecarDir: string;
  exportDir: string;
  includeReadingNotesInExport: boolean;
  // v0.2 Agent settings
  terminalApp: TerminalApp;
  customCommandRules: CommandRule[];
  // v0.4 API Key direct call
  apiSettings: APISettings;
}

export const DEFAULT_API_SETTINGS: APISettings = {
  provider: "anthropic",
  apiKey: "",
  model: "",
  customEndpoint: "",
  maxTokens: 4096,
};

export const DEFAULT_SETTINGS: PromptuarySettings = {
  language: "auto",
  defaultMode: "reading",
  contextSpan: 50,
  sidecarDir: ".promptuary/annotations",
  exportDir: ".promptuary/exports",
  includeReadingNotesInExport: false,
  terminalApp: "Terminal",
  customCommandRules: [],
  apiSettings: { ...DEFAULT_API_SETTINGS },
};

// ---------- Add Rule Modal ----------

class AddRuleModal extends Modal {
  private resolve?: (rule: Omit<CommandRule, "isPreset"> | null) => void;

  constructor(app: App, private existingIds: string[]) {
    super(app);
  }

  openForResult(): Promise<Omit<CommandRule, "isPreset"> | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass("prm-add-rule-modal");
    modalEl.addClass("prm-add-rule-modal");

    // Header
    const header = contentEl.createDiv({ cls: "prm-arm-header" });
    const headerLeft = header.createDiv({ cls: "prm-arm-header-left" });
    const icon = headerLeft.createDiv({ cls: "prm-arm-icon" });
    setIcon(icon, "zap");
    const titleWrap = headerLeft.createDiv({});
    titleWrap.createDiv({ cls: "prm-arm-title", text: t("addrule.title") });
    titleWrap.createDiv({ cls: "prm-arm-subtitle", text: t("addrule.subtitle") });

    // Form
    const form = contentEl.createDiv({ cls: "prm-arm-form" });

    let newId = "";
    let newLabel = "";
    let newDetectCmd = "";
    let newTemplate = "";
    let newInstallHint = "";

    new Setting(form)
      .setName(t("addrule.id.name"))
      .setDesc(t("addrule.id.desc"))
      .addText((txt) =>
        txt.setPlaceholder(t("addrule.id.placeholder")).onChange((v) => (newId = v.trim())),
      );
    new Setting(form)
      .setName(t("addrule.label.name"))
      .setDesc(t("addrule.label.desc"))
      .addText((txt) =>
        txt.setPlaceholder(t("addrule.label.placeholder")).onChange((v) => (newLabel = v.trim())),
      );
    new Setting(form)
      .setName(t("addrule.detectCmd.name"))
      .setDesc(t("addrule.detectCmd.desc"))
      .addText((txt) =>
        txt.setPlaceholder(t("addrule.detectCmd.placeholder")).onChange((v) => (newDetectCmd = v.trim())),
      );
    new Setting(form)
      .setName(t("addrule.command.name"))
      .setDesc(t("addrule.command.desc"))
      .addTextArea((txt) =>
        txt
          .setPlaceholder(t("addrule.command.placeholder"))
          .onChange((v) => (newTemplate = v.trim())),
      );
    new Setting(form)
      .setName(t("addrule.installHint.name"))
      .setDesc(t("addrule.installHint.desc"))
      .addText((txt) =>
        txt.setPlaceholder(t("addrule.installHint.placeholder")).onChange((v) => (newInstallHint = v.trim())),
      );

    // Template variables reference
    const varRef = form.createDiv({ cls: "prm-arm-var-ref" });
    varRef.createDiv({ cls: "prm-arm-var-title", text: t("addrule.varTitle") });
    const varGrid = varRef.createDiv({ cls: "prm-arm-var-grid" });
    const vars = [
      ["{{vaultPath}}", t("addrule.var.vaultPath")],
      ["{{instructionFile}}", t("addrule.var.instructionFile")],
      ["{{filePath}}", t("addrule.var.filePath")],
      ["{{fileName}}", t("addrule.var.fileName")],
      ["{{prompt}}", t("addrule.var.prompt")],
    ];
    for (const [v, desc] of vars) {
      const item = varGrid.createDiv({ cls: "prm-arm-var-item" });
      item.createDiv({ cls: "prm-arm-var-code", text: v });
      item.createDiv({ cls: "prm-arm-var-desc", text: desc });
    }

    // Footer
    const footer = contentEl.createDiv({ cls: "prm-arm-footer" });
    const cancelBtn = footer.createEl("button", {
      cls: "prm-arm-btn-cancel",
      text: t("addrule.btn.cancel"),
    });
    cancelBtn.onclick = () => this.close();

    const saveBtn = footer.createEl("button", {
      cls: "prm-arm-btn-save",
      text: t("addrule.btn.add"),
    });
    saveBtn.onclick = () => {
      if (!newId || !newLabel || !newTemplate || !newDetectCmd) {
        new Notice(t("addrule.notice.requiredFields"));
        return;
      }
      if (this.existingIds.includes(newId)) {
        new Notice(t("addrule.notice.idExists", { id: newId }));
        return;
      }
      try {
        const store = new CommandRuleStore();
        store.loadFromJSON([]);
        // validate template
        store.add({
          id: newId,
          label: newLabel,
          detectCmd: newDetectCmd,
          template: newTemplate,
          installHint: newInstallHint || t("addrule.defaultInstallHint"),
        });
      } catch (err) {
        new Notice(t("addrule.notice.validationFailed", { error: (err as Error).message }));
        return;
      }
      this.resolve?.({
        id: newId,
        label: newLabel,
        detectCmd: newDetectCmd,
        template: newTemplate,
        installHint: newInstallHint || t("addrule.defaultInstallHint"),
      });
      this.close();
    };
  }

  onClose(): void {
    this.resolve?.(null);
    this.contentEl.empty();
  }
}

// ---------- Settings Tab ----------

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PromptuaryPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Page header
    const pageHeader = containerEl.createDiv({ cls: "prm-settings-header" });
    const pageHeaderLeft = pageHeader.createDiv({ cls: "prm-settings-header-left" });
    const pageIcon = pageHeaderLeft.createDiv({ cls: "prm-settings-page-icon" });
    if (this.plugin.logoUrl) {
      const img = pageIcon.createEl("img", { cls: "prm-logo-img" });
      img.src = this.plugin.logoUrl;
      img.alt = "Promptuary";
    } else {
      setIcon(pageIcon, "prm-highlighter");
    }
    pageHeaderLeft.createDiv({ cls: "prm-settings-page-title", text: "Promptuary" });

    // --- Section 1: Basic ---
    this.renderSection(containerEl, {
      icon: "file-text",
      title: t("settings.section.basic"),
      desc: t("settings.section.basicDesc"),
      open: true,
      render: (el) => this.renderBasicSettings(el),
    });

    // --- Section 2: Agent (desktop only) ---
    if (!isMobile()) {
      this.renderSection(containerEl, {
        icon: "bot",
        title: t("settings.section.agent"),
        desc: t("settings.section.agentDesc"),
        open: true,
        render: (el) => this.renderAgentSettings(el),
      });

      this.renderSection(containerEl, {
        icon: "key-round",
        title: t("settings.section.api"),
        desc: t("settings.section.apiDesc"),
        open: !this.plugin.settings.apiSettings.apiKey, // open if no key yet
        render: (el) => this.renderAPISettings(el),
      });
    }
  }

  // ---------- Section wrapper ----------

  private renderSection(
    containerEl: HTMLElement,
    opts: {
      icon: string;
      title: string;
      desc: string;
      open: boolean;
      render: (el: HTMLElement) => void;
    },
  ): void {
    const section = containerEl.createDiv({ cls: "prm-settings-section" });

    // Clickable header
    const header = section.createDiv({ cls: "prm-settings-section-header" });
    const headerLeft = header.createDiv({ cls: "prm-settings-section-left" });
    const iconEl = headerLeft.createDiv({ cls: "prm-settings-section-icon" });
    setIcon(iconEl, opts.icon);
    const textWrap = headerLeft.createDiv({ cls: "prm-settings-section-text" });
    textWrap.createDiv({ cls: "prm-settings-section-title", text: opts.title });
    textWrap.createDiv({ cls: "prm-settings-section-desc", text: opts.desc });
    const chevron = header.createDiv({ cls: "prm-settings-section-chevron" });
    setIcon(chevron, "chevron-down");

    // Collapsible body
    const body = section.createDiv({ cls: "prm-settings-section-body" });
    if (opts.open) {
      body.addClass("is-open");
      chevron.addClass("is-open");
    }

    header.onclick = () => {
      const isOpen = body.hasClass("is-open");
      body.toggleClass("is-open", !isOpen);
      chevron.toggleClass("is-open", !isOpen);
    };

    opts.render(body);
  }

  // ---------- Basic settings ----------

  private renderBasicSettings(containerEl: HTMLElement): void {
    // Language selector
    new Setting(containerEl)
      .setName(t("settings.language.name"))
      .setDesc(t("settings.language.desc"))
      .addDropdown((d) => {
        d.addOption("auto", t("settings.language.auto"))
          .addOption("zh-CN", t("settings.language.zhCN"))
          .addOption("en", t("settings.language.en"))
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as LanguageSetting;
            await this.plugin.saveSettings();
            initI18n(v as LanguageSetting);
            // Reload plugin to apply language change
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = this.app as any;
            if (app.plugins?.disablePlugin && app.plugins?.enablePlugin) {
              await app.plugins.disablePlugin("promptuary");
              await app.plugins.enablePlugin("promptuary");
            }
          });
      });

    new Setting(containerEl)
      .setName(t("settings.defaultMode.name"))
      .setDesc(t("settings.defaultMode.desc"))
      .addDropdown((d) =>
        d
          .addOption("reading", t("settings.defaultMode.reading"))
          .addOption("reviewing", t("settings.defaultMode.review"))
          .addOption("all", t("sidebar.mode.all"))
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (v) => {
            this.plugin.settings.defaultMode = v as ViewMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.contextSpan.name"))
      .setDesc(t("settings.contextSpan.desc"))
      .addText((txt) =>
        txt
          .setValue(String(this.plugin.settings.contextSpan))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.contextSpan = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.sidecarDir.name"))
      .setDesc(t("settings.sidecarDir.desc"))
      .addText((txt) =>
        txt
          .setValue(this.plugin.settings.sidecarDir)
          .onChange(async (v) => {
            this.plugin.settings.sidecarDir = v.trim() || DEFAULT_SETTINGS.sidecarDir;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.exportDir.name"))
      .setDesc(t("settings.exportDir.desc"))
      .addText((txt) =>
        txt
          .setValue(this.plugin.settings.exportDir)
          .onChange(async (v) => {
            this.plugin.settings.exportDir = v.trim() || DEFAULT_SETTINGS.exportDir;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.includeReadingNotes.name"))
      .setDesc(t("settings.includeReadingNotes.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeReadingNotesInExport)
          .onChange(async (v) => {
            this.plugin.settings.includeReadingNotesInExport = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  // ---------- Agent settings section ----------

  private renderAgentSettings(containerEl: HTMLElement): void {
    // Terminal app selection
    new Setting(containerEl)
      .setName(t("settings.terminalApp.name"))
      .setDesc(t("settings.terminalApp.desc"))
      .addDropdown((d) => {
        d.addOption("Terminal", t("settings.terminalApp.terminal") + t("settings.terminalApp.defaultSuffix"))
          .addOption("iTerm2", t("settings.terminalApp.iterm"))
          .setValue(this.plugin.settings.terminalApp)
          .onChange(async (v) => {
            this.plugin.settings.terminalApp = v as TerminalApp;
            await this.plugin.saveSettings();
          });
      });

    // --- Detected agents as cards ---
    const agentResults: AgentInfo[] = detectAgents(PRESET_RULES);
    const detectedWrap = containerEl.createDiv({ cls: "prm-agent-cards" });

    for (const info of agentResults) {
      const card = detectedWrap.createDiv({
        cls: `prm-agent-card ${info.installed ? "installed" : "not-installed"}`,
      });

      // Avatar
      const avatar = card.createDiv({ cls: "prm-agent-card-avatar" });
      avatar.setText(info.rule.label.charAt(0));

      // Info
      const infoEl = card.createDiv({ cls: "prm-agent-card-info" });
      const nameRow = infoEl.createDiv({ cls: "prm-agent-card-name-row" });
      nameRow.createDiv({ cls: "prm-agent-card-name", text: info.rule.label });
      const _badge = nameRow.createDiv({
        cls: `prm-agent-card-badge ${info.installed ? "installed" : "missing"}`,
        text: info.installed ? t("settings.detectedAgents.installed") : t("agent.select.missing"),
      });

      if (info.rule.vendor) {
        infoEl.createDiv({ cls: "prm-agent-card-vendor", text: info.rule.vendor });
      }
      if (!info.installed) {
        infoEl.createDiv({
          cls: "prm-agent-card-hint",
          text: `${t("settings.agentInstall")}${info.rule.installHint}`,
        });
      }
    }

    // Re-detect button
    new Setting(containerEl)
      .setName(t("settings.redetectAgent.name"))
      .setDesc(t("settings.redetectAgent.desc"))
      .addButton((b) =>
        b.setButtonText(t("settings.redetectAgent.btn")).onClick(() => {
          this.plugin.invalidateAgentCache();
          this.display();
          new Notice(t("settings.redetectAgent.done"));
        }),
      );

    // --- Custom command rules ---
    const ruleStore = new CommandRuleStore();
    ruleStore.loadFromJSON(this.plugin.settings.customCommandRules);
    const customRules = ruleStore.getCustomRules();

    // Sub-section header
    const ruleHeader = containerEl.createDiv({ cls: "prm-settings-sub-header" });
    ruleHeader.createDiv({ cls: "prm-settings-sub-title", text: t("settings.customRules.title") });
    const addBtn = ruleHeader.createEl("button", {
      cls: "prm-settings-sub-btn",
      text: `+ ${t("common.add")}`,
    });
    addBtn.onclick = async () => {
      const allIds = ruleStore.allRules().map((r) => r.id);
      const result = await new AddRuleModal(this.app, allIds).openForResult();
      if (result) {
        try {
          const store = new CommandRuleStore();
          store.loadFromJSON(this.plugin.settings.customCommandRules);
          store.add(result);
          this.plugin.settings.customCommandRules = store.toJSON();
          await this.plugin.saveSettings();
          this.plugin.invalidateAgentCache();
          this.display();
          new Notice(t("settings.customRules.added", { label: result.label }));
        } catch (err) {
          new Notice(t("settings.customRules.addFailed", { error: (err as Error).message }));
        }
      }
    };

    if (customRules.length === 0) {
      containerEl.createDiv({
        cls: "prm-settings-empty",
        text: t("settings.customRules.empty"),
      });
    } else {
      const ruleCards = containerEl.createDiv({ cls: "prm-rule-cards" });
      for (const rule of customRules) {
        this.renderCustomRuleCard(ruleCards, rule);
      }
    }

    // Available variables help
    const varDetails = containerEl.createEl("details", { cls: "prm-settings-var-details" });
    varDetails.createEl("summary", { text: t("settings.varRef.title") });
    const varTable = varDetails.createEl("table", { cls: "prm-settings-var-table" });
    const vars = [
      ["{{vaultPath}}", t("settings.varRef.vaultPath")],
      ["{{instructionFile}}", t("settings.varRef.instructionFile")],
      ["{{filePath}}", t("settings.varRef.filePath")],
      ["{{fileName}}", t("settings.varRef.fileName")],
      ["{{prompt}}", t("settings.varRef.prompt")],
    ];
    for (const [v, desc] of vars) {
      const tr = varTable.createEl("tr");
      tr.createEl("td", { text: v });
      tr.createEl("td", { text: desc });
    }
  }

  private renderCustomRuleCard(containerEl: HTMLElement, rule: CommandRule): void {
    const card = containerEl.createDiv({ cls: "prm-rule-card" });

    // Left: info
    const info = card.createDiv({ cls: "prm-rule-card-info" });
    info.createDiv({ cls: "prm-rule-card-label", text: rule.label });
    const meta = info.createDiv({ cls: "prm-rule-card-meta" });
    meta.createSpan({ text: `${t("settings.ruleCard.detect")}: ${rule.detectCmd}` });
    // Template preview (truncate)
    const tpl = rule.template.length > 60 ? rule.template.slice(0, 57) + "…" : rule.template;
    const tplSpan = meta.createSpan({ cls: "prm-rule-card-template" });
    tplSpan.setText(`${t("settings.ruleCard.template")}: ${tpl}`);

    // Right: delete button
    const delBtn = card.createEl("button", {
      cls: "prm-rule-card-del",
      text: t("common.delete"),
    });
    delBtn.onclick = async () => {
      const store = new CommandRuleStore();
      store.loadFromJSON(this.plugin.settings.customCommandRules);
      store.remove(rule.id);
      this.plugin.settings.customCommandRules = store.toJSON();
      await this.plugin.saveSettings();
      this.plugin.invalidateAgentCache();
      this.display();
    };
  }

  // ---------- API Key direct call section ----------

  private renderAPISettings(containerEl: HTMLElement): void {
    const s = this.plugin.settings.apiSettings;

    new Setting(containerEl)
      .setName(t("settings.api.provider.name"))
      .addDropdown((d) =>
        d
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("openai", "OpenAI (GPT)")
          .addOption("deepseek", "DeepSeek")
          .addOption("gemini", "Google Gemini")
          .addOption("custom", t("settings.api.provider.custom"))
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as APIProviderType;
            s.model = PROVIDER_DEFAULTS[s.provider].model;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    // API Key with toggle visibility
    new Setting(containerEl)
      .setName(t("settings.api.key.name"))
      .setDesc(t("settings.api.key.desc"))
      .addText((txt) => {
        txt.setPlaceholder(t("settings.api.key.placeholder"))
          .setValue(s.apiKey)
          .onChange(async (v) => {
            s.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
        txt.inputEl.type = "password";
        txt.inputEl.addClass("prm-api-key-input");

        // Toggle visibility button
        const inputParent = txt.inputEl.parentElement;
        if (inputParent) {
          inputParent.addClass("prm-relative");
        }
        const toggleBtn = inputParent?.createEl("button", {
          cls: "prm-api-key-toggle",
        });
        if (toggleBtn) {
          setIcon(toggleBtn, "eye");
          toggleBtn.onclick = () => {
            const input = txt.inputEl;
            if (input.type === "password") {
              input.type = "text";
              setIcon(toggleBtn, "eye-off");
            } else {
              input.type = "password";
              setIcon(toggleBtn, "eye");
            }
          };
        }
      });

    new Setting(containerEl)
      .setName(t("settings.api.model.name"))
      .setDesc(t("settings.api.model.desc", { model: PROVIDER_DEFAULTS[s.provider].model }))
      .addText((txt) =>
        txt
          .setPlaceholder(PROVIDER_DEFAULTS[s.provider].model)
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    if (s.provider === "custom") {
      new Setting(containerEl)
        .setName(t("settings.api.customEndpoint.name"))
        .setDesc(t("settings.api.customEndpoint.desc"))
        .addText((txt) =>
          txt
            .setPlaceholder(t("settings.api.customEndpoint.placeholder"))
            .setValue(s.customEndpoint)
            .onChange(async (v) => {
              s.customEndpoint = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName(t("settings.api.maxTokens.name"))
      .setDesc(t("settings.api.maxTokens.desc"))
      .addText((txt) =>
        txt
          .setValue(String(s.maxTokens))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              s.maxTokens = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    // Test connection with status indicator
    const testSetting = new Setting(containerEl)
      .setName(t("settings.api.test.name"))
      .setDesc(t("settings.api.test.desc"));

    let _lastTestResult: "success" | "fail" | null = null;

    testSetting.addButton((b) => {
      b.setButtonText(t("settings.api.test.btn")).onClick(async () => {
        if (!s.apiKey) {
          new Notice(t("settings.api.test.noKey"));
          return;
        }
        b.setButtonText(t("settings.api.test.running")).setDisabled(true);
        const { callAPI, API_SYSTEM_PROMPT } = await import("../api/APIProvider");
        const result = await callAPI(
          { ...s, model: s.model || PROVIDER_DEFAULTS[s.provider].model },
          { systemPrompt: API_SYSTEM_PROMPT, userMessage: '请回复"连接成功"，仅此四字。' },
        );
        b.setButtonText(t("settings.api.test.btn")).setDisabled(false);
        if (result.success) {
          _lastTestResult = "success";
          new Notice(t("settings.api.test.success", { text: result.text?.slice(0, 30) ?? "" }));
        } else {
          _lastTestResult = "fail";
          new Notice(t("settings.api.test.failed", { error: result.error ?? "" }));
        }
        this.display();
      });
    });
  }
}
