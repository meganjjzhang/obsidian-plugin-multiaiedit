import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type MultiAIEditPlugin from "../main";
import { ViewMode } from "../annotation/AnnotationModel";
import { CommandRule, CommandRuleStore, PRESET_RULES } from "../agent/CommandRuleStore";
import { detectAgents, AgentInfo } from "../agent/AgentDetector";
import { TerminalApp } from "../agent/TerminalLauncher";
import { APIProviderType, PROVIDER_DEFAULTS } from "../api/APIProvider";
import { isMobile } from "../utils/platform";

export interface APISettings {
  provider: APIProviderType;
  apiKey: string;
  model: string;
  customEndpoint: string;
  maxTokens: number;
}

export interface MultiAIEditSettings {
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

export const DEFAULT_SETTINGS: MultiAIEditSettings = {
  defaultMode: "reading",
  contextSpan: 50,
  sidecarDir: ".multiaiedit/annotations",
  exportDir: ".multiaiedit/exports",
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mae-add-rule-modal");

    // Header
    const header = contentEl.createDiv({ cls: "mae-arm-header" });
    const headerLeft = header.createDiv({ cls: "mae-arm-header-left" });
    const icon = headerLeft.createDiv({ cls: "mae-arm-icon" });
    setIcon(icon, "zap");
    const titleWrap = headerLeft.createDiv({});
    titleWrap.createDiv({ cls: "mae-arm-title", text: "添加命令规则" });
    titleWrap.createDiv({ cls: "mae-arm-subtitle", text: "自定义 Agent CLI 命令模板" });
    const closeBtn = header.createDiv({ cls: "mae-arm-close" });
    closeBtn.setText("");
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.close();

    // Form
    const form = contentEl.createDiv({ cls: "mae-arm-form" });

    let newId = "";
    let newLabel = "";
    let newDetectCmd = "";
    let newTemplate = "";
    let newInstallHint = "";

    new Setting(form)
      .setName("规则 ID")
      .setDesc("唯一标识符，仅允许英文、数字、短横线")
      .addText((t) =>
        t.setPlaceholder("my-agent").onChange((v) => (newId = v.trim())),
      );
    new Setting(form)
      .setName("显示名")
      .setDesc("在侧边栏和命令面板中显示的名称")
      .addText((t) =>
        t.setPlaceholder("My Agent").onChange((v) => (newLabel = v.trim())),
      );
    new Setting(form)
      .setName("检测命令")
      .setDesc("用于判断该 Agent 是否已安装的 shell 命令")
      .addText((t) =>
        t.setPlaceholder("which my-agent").onChange((v) => (newDetectCmd = v.trim())),
      );
    new Setting(form)
      .setName("命令模板")
      .setDesc("实际执行时的命令，支持模板变量")
      .addTextArea((t) =>
        t
          .setPlaceholder('cd {{vaultPath}} && my-agent "读取 {{instructionFile}}"')
          .onChange((v) => (newTemplate = v.trim())),
      );
    new Setting(form)
      .setName("安装提示")
      .setDesc("未安装时显示的安装命令（可选）")
      .addText((t) =>
        t.setPlaceholder("npm i -g my-agent").onChange((v) => (newInstallHint = v.trim())),
      );

    // Template variables reference
    const varRef = form.createDiv({ cls: "mae-arm-var-ref" });
    varRef.createDiv({ cls: "mae-arm-var-title", text: "可用模板变量" });
    const varGrid = varRef.createDiv({ cls: "mae-arm-var-grid" });
    const vars = [
      ["{{vaultPath}}", "Vault 根目录"],
      ["{{instructionFile}}", "指令文件路径"],
      ["{{filePath}}", "文件相对路径"],
      ["{{fileName}}", "文件名"],
      ["{{prompt}}", "内联 Prompt"],
    ];
    for (const [v, desc] of vars) {
      const item = varGrid.createDiv({ cls: "mae-arm-var-item" });
      item.createDiv({ cls: "mae-arm-var-code", text: v });
      item.createDiv({ cls: "mae-arm-var-desc", text: desc });
    }

    // Footer
    const footer = contentEl.createDiv({ cls: "mae-arm-footer" });
    const cancelBtn = footer.createEl("button", {
      cls: "mae-arm-btn-cancel",
      text: "取消",
    });
    cancelBtn.onclick = () => this.close();

    const saveBtn = footer.createEl("button", {
      cls: "mae-arm-btn-save",
      text: "添加规则",
    });
    saveBtn.onclick = () => {
      if (!newId || !newLabel || !newTemplate || !newDetectCmd) {
        new Notice("请填写所有必填字段");
        return;
      }
      if (this.existingIds.includes(newId)) {
        new Notice(`规则 ID "${newId}" 已存在`);
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
          installHint: newInstallHint || "自定义安装方式",
        });
      } catch (err) {
        new Notice(`验证失败: ${(err as Error).message}`);
        return;
      }
      this.resolve?.({
        id: newId,
        label: newLabel,
        detectCmd: newDetectCmd,
        template: newTemplate,
        installHint: newInstallHint || "自定义安装方式",
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
  constructor(app: App, private plugin: MultiAIEditPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Page header
    const pageHeader = containerEl.createDiv({ cls: "mae-settings-header" });
    const pageHeaderLeft = pageHeader.createDiv({ cls: "mae-settings-header-left" });
    const pageIcon = pageHeaderLeft.createDiv({ cls: "mae-settings-page-icon" });
    setIcon(pageIcon, "mae-diya");
    pageHeaderLeft.createDiv({ cls: "mae-settings-page-title", text: "MultiAIEdit" });

    // --- Section 1: Basic ---
    this.renderSection(containerEl, {
      icon: "file-text",
      title: "基础设置",
      desc: "批注存储、导出路径与默认模式",
      open: true,
      render: (el) => this.renderBasicSettings(el),
    });

    // --- Section 2: Agent (desktop only) ---
    if (!isMobile()) {
      this.renderSection(containerEl, {
        icon: "bot",
        title: "Agent 与终端",
        desc: "CLI Agent 检测、命令规则与终端配置",
        open: true,
        render: (el) => this.renderAgentSettings(el),
      });

      this.renderSection(containerEl, {
        icon: "key-round",
        title: "API 直调",
        desc: "配置 API Key 后无需安装 CLI，直接在插件内调用模型",
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
    const section = containerEl.createDiv({ cls: "mae-settings-section" });

    // Clickable header
    const header = section.createDiv({ cls: "mae-settings-section-header" });
    const headerLeft = header.createDiv({ cls: "mae-settings-section-left" });
    const iconEl = headerLeft.createDiv({ cls: "mae-settings-section-icon" });
    setIcon(iconEl, opts.icon);
    const textWrap = headerLeft.createDiv({ cls: "mae-settings-section-text" });
    textWrap.createDiv({ cls: "mae-settings-section-title", text: opts.title });
    textWrap.createDiv({ cls: "mae-settings-section-desc", text: opts.desc });
    const chevron = header.createDiv({ cls: "mae-settings-section-chevron" });
    setIcon(chevron, "chevron-down");

    // Collapsible body
    const body = section.createDiv({ cls: "mae-settings-section-body" });
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
    new Setting(containerEl)
      .setName("默认模式")
      .setDesc("打开侧边栏时使用的初始模式")
      .addDropdown((d) =>
        d
          .addOption("reading", "阅读")
          .addOption("reviewing", "批阅")
          .addOption("all", "全部")
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (v) => {
            this.plugin.settings.defaultMode = v as ViewMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("上下文长度")
      .setDesc("每条批注前后保存的字符数（用于锚点定位与导出快照）")
      .addText((t) =>
        t
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
      .setName("Sidecar 目录")
      .setDesc("批注 JSON 存储位置（vault 相对路径）")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.sidecarDir)
          .onChange(async (v) => {
            this.plugin.settings.sidecarDir = v.trim() || DEFAULT_SETTINGS.sidecarDir;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("导出目录")
      .setDesc("导出批阅文件的保存位置（vault 相对路径）")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.exportDir)
          .onChange(async (v) => {
            this.plugin.settings.exportDir = v.trim() || DEFAULT_SETTINGS.exportDir;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("导出时附带阅读笔记")
      .setDesc("默认只导出批阅意见，开启后将笔记作为参考上下文一并导出")
      .addToggle((t) =>
        t
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
      .setName("终端应用")
      .setDesc("macOS 上用于执行 CLI 命令的终端应用")
      .addDropdown((d) => {
        d.addOption("Terminal", "Terminal（默认）")
          .addOption("iTerm2", "iTerm2")
          .setValue(this.plugin.settings.terminalApp)
          .onChange(async (v) => {
            this.plugin.settings.terminalApp = v as TerminalApp;
            await this.plugin.saveSettings();
          });
      });

    // --- Detected agents as cards ---
    const agentResults: AgentInfo[] = detectAgents(PRESET_RULES);
    const detectedWrap = containerEl.createDiv({ cls: "mae-agent-cards" });

    for (const info of agentResults) {
      const card = detectedWrap.createDiv({
        cls: `mae-agent-card ${info.installed ? "installed" : "not-installed"}`,
      });

      // Avatar
      const avatar = card.createDiv({ cls: "mae-agent-card-avatar" });
      avatar.setText(info.rule.label.charAt(0));

      // Info
      const infoEl = card.createDiv({ cls: "mae-agent-card-info" });
      const nameRow = infoEl.createDiv({ cls: "mae-agent-card-name-row" });
      nameRow.createDiv({ cls: "mae-agent-card-name", text: info.rule.label });
      const badge = nameRow.createDiv({
        cls: `mae-agent-card-badge ${info.installed ? "installed" : "missing"}`,
        text: info.installed ? "已安装" : "未安装",
      });

      if (info.rule.vendor) {
        infoEl.createDiv({ cls: "mae-agent-card-vendor", text: info.rule.vendor });
      }
      if (!info.installed) {
        infoEl.createDiv({
          cls: "mae-agent-card-hint",
          text: `安装：${info.rule.installHint}`,
        });
      }
    }

    // Re-detect button
    new Setting(containerEl)
      .setName("重新检测 Agent")
      .setDesc("重新扫描已安装的 Agent CLI")
      .addButton((b) =>
        b.setButtonText("检测").onClick(() => {
          this.plugin.invalidateAgentCache();
          this.display();
          new Notice("检测完成");
        }),
      );

    // --- Custom command rules ---
    const ruleStore = new CommandRuleStore();
    ruleStore.loadFromJSON(this.plugin.settings.customCommandRules);
    const customRules = ruleStore.getCustomRules();

    // Sub-section header
    const ruleHeader = containerEl.createDiv({ cls: "mae-settings-sub-header" });
    ruleHeader.createDiv({ cls: "mae-settings-sub-title", text: "自定义命令规则" });
    const addBtn = ruleHeader.createEl("button", {
      cls: "mae-settings-sub-btn",
      text: "+ 添加",
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
          new Notice(`规则 "${result.label}" 已添加`);
        } catch (err) {
          new Notice(`添加失败: ${(err as Error).message}`);
        }
      }
    };

    if (customRules.length === 0) {
      containerEl.createDiv({
        cls: "mae-settings-empty",
        text: "暂无自定义规则，点击上方「+ 添加」按钮创建。",
      });
    } else {
      const ruleCards = containerEl.createDiv({ cls: "mae-rule-cards" });
      for (const rule of customRules) {
        this.renderCustomRuleCard(ruleCards, rule);
      }
    }

    // Available variables help
    const varDetails = containerEl.createEl("details", { cls: "mae-settings-var-details" });
    varDetails.createEl("summary", { text: "可用模板变量参考" });
    const varTable = varDetails.createEl("table", { cls: "mae-settings-var-table" });
    const vars = [
      ["{{vaultPath}}", "Vault 根目录绝对路径"],
      ["{{instructionFile}}", "生成的批注指令文件路径"],
      ["{{filePath}}", "当前文件相对路径"],
      ["{{fileName}}", "当前文件名"],
      ["{{prompt}}", "内联 prompt 文本"],
    ];
    for (const [v, desc] of vars) {
      const tr = varTable.createEl("tr");
      tr.createEl("td", { text: v });
      tr.createEl("td", { text: desc });
    }
  }

  private renderCustomRuleCard(containerEl: HTMLElement, rule: CommandRule): void {
    const card = containerEl.createDiv({ cls: "mae-rule-card" });

    // Left: info
    const info = card.createDiv({ cls: "mae-rule-card-info" });
    info.createDiv({ cls: "mae-rule-card-label", text: rule.label });
    const meta = info.createDiv({ cls: "mae-rule-card-meta" });
    meta.createSpan({ text: `检测: ${rule.detectCmd}` });
    // Template preview (truncate)
    const tpl = rule.template.length > 60 ? rule.template.slice(0, 57) + "…" : rule.template;
    const tplSpan = meta.createSpan({ cls: "mae-rule-card-template" });
    tplSpan.setText(`模板: ${tpl}`);

    // Right: delete button
    const delBtn = card.createEl("button", {
      cls: "mae-rule-card-del",
      text: "删除",
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
      .setName("Provider")
      .addDropdown((d) =>
        d
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("openai", "OpenAI (GPT)")
          .addOption("deepseek", "DeepSeek")
          .addOption("gemini", "Google Gemini")
          .addOption("custom", "自定义端点（OpenAI 兼容）")
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
      .setName("API Key")
      .setDesc("密钥仅保存在本地，不上传至任何服务器")
      .addText((t) => {
        t.setPlaceholder("sk-…")
          .setValue(s.apiKey)
          .onChange(async (v) => {
            s.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
        t.inputEl.addClass("mae-api-key-input");

        // Toggle visibility button
        const toggleBtn = t.inputEl.parentElement?.createEl("button", {
          cls: "mae-api-key-toggle",
        });
        if (toggleBtn) {
          setIcon(toggleBtn, "eye");
          toggleBtn.onclick = () => {
            const input = t.inputEl;
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
      .setName("模型")
      .setDesc(`留空则使用默认：${PROVIDER_DEFAULTS[s.provider].model}`)
      .addText((t) =>
        t
          .setPlaceholder(PROVIDER_DEFAULTS[s.provider].model)
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    if (s.provider === "custom") {
      new Setting(containerEl)
        .setName("自定义端点 URL")
        .setDesc("OpenAI 兼容格式，如 https://your-proxy.com/v1/chat/completions")
        .addText((t) =>
          t
            .setPlaceholder("https://…/v1/chat/completions")
            .setValue(s.customEndpoint)
            .onChange(async (v) => {
              s.customEndpoint = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName("最大输出 Token")
      .setDesc("默认 4096")
      .addText((t) =>
        t
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
      .setName("测试连接")
      .setDesc("发送最小请求验证 API Key 是否有效");

    let lastTestResult: "success" | "fail" | null = null;

    testSetting.addButton((b) => {
      b.setButtonText("测试").onClick(async () => {
        if (!s.apiKey) {
          new Notice("请先填写 API Key");
          return;
        }
        b.setButtonText("测试中…").setDisabled(true);
        const { callAPI, API_SYSTEM_PROMPT } = await import("../api/APIProvider");
        const result = await callAPI(
          { ...s, model: s.model || PROVIDER_DEFAULTS[s.provider].model },
          { systemPrompt: API_SYSTEM_PROMPT, userMessage: '请回复"连接成功"，仅此四字。' },
        );
        b.setButtonText("测试").setDisabled(false);
        if (result.success) {
          lastTestResult = "success";
          new Notice(`连接成功：${result.text?.slice(0, 30)}`);
        } else {
          lastTestResult = "fail";
          new Notice(`连接失败：${result.error}`);
        }
        this.display();
      });
    });
  }
}
