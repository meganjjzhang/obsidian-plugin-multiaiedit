import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MultiAIEditPlugin from "../main";
import { ViewMode } from "../annotation/AnnotationModel";
import { CommandRule, CommandRuleStore, PRESET_RULES } from "../agent/CommandRuleStore";
import { detectAgents, AgentInfo } from "../agent/AgentDetector";
import { TerminalApp } from "../agent/TerminalLauncher";
import { isMobile } from "../utils/platform";

export interface MultiAIEditSettings {
  defaultMode: ViewMode;
  contextSpan: number; // chars on each side
  sidecarDir: string;
  exportDir: string;
  includeReadingNotesInExport: boolean;
  // v0.2 Agent settings
  terminalApp: TerminalApp;
  customCommandRules: CommandRule[]; // persisted custom rules
}

export const DEFAULT_SETTINGS: MultiAIEditSettings = {
  defaultMode: "reading",
  contextSpan: 50,
  sidecarDir: ".multiaiedit/annotations",
  exportDir: ".multiaiedit/exports",
  includeReadingNotesInExport: false,
  terminalApp: "Terminal",
  customCommandRules: [],
};

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: MultiAIEditPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "MultiAIEdit 设置" });

    // --- Basic settings ---
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

    // --- Agent settings (desktop only) ---
    if (!isMobile()) {
      this.renderAgentSettings(containerEl);
    }
  }

  // ---------- Agent settings section ----------

  private renderAgentSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Agent 与终端" });

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

    // Detect installed agents
    const agentResults: AgentInfo[] = detectAgents(PRESET_RULES);
    const detectedSection = containerEl.createDiv({ cls: "mae-agent-detected" });
    detectedSection.createEl("h4", { text: "已检测的 Agent" });

    for (const info of agentResults) {
      const row = detectedSection.createDiv({ cls: "mae-agent-row" });
      const status = row.createSpan({
        cls: `mae-agent-status ${info.installed ? "installed" : "not-installed"}`,
        text: info.installed ? "✅" : "❌",
      });
      row.createSpan({ text: info.rule.label });
      if (!info.installed) {
        row.createSpan({
          cls: "mae-agent-hint",
          text: ` — 安装: ${info.rule.installHint}`,
        });
      }
    }

    // Re-detect button
    new Setting(containerEl)
      .setName("重新检测")
      .setDesc("重新扫描已安装的 Agent CLI")
      .addButton((b) =>
        b.setButtonText("检测").onClick(() => {
          this.display(); // re-render
          new Notice("检测完成");
        }),
      );

    // Custom command rules
    containerEl.createEl("h4", { text: "自定义命令规则" });

    const ruleStore = new CommandRuleStore();
    ruleStore.loadFromJSON(this.plugin.settings.customCommandRules);
    const customRules = ruleStore.getCustomRules();

    if (customRules.length === 0) {
      containerEl.createEl("p", {
        cls: "mae-empty-hint",
        text: "暂无自定义规则。点击下方「添加」按钮创建。",
      });
    } else {
      for (const rule of customRules) {
        this.renderCustomRule(containerEl, rule);
      }
    }

    // Add new rule button
    new Setting(containerEl)
      .setName("添加命令规则")
      .setDesc("自定义一个 Agent CLI 命令模板")
      .addButton((b) =>
        b.setButtonText("添加").onClick(() => {
          this.showAddRuleDialog(containerEl);
        }),
      );

    // Available variables help
    containerEl.createEl("details", {}, (details) => {
      details.createEl("summary", { text: "可用模板变量" });
      const table = details.createEl("table");
      const vars = [
        ["{{vaultPath}}", "Vault 根目录绝对路径"],
        ["{{instructionFile}}", "生成的批注指令文件路径"],
        ["{{filePath}}", "当前文件相对路径"],
        ["{{fileName}}", "当前文件名"],
        ["{{prompt}}", "内联 prompt 文本"],
      ];
      for (const [v, desc] of vars) {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: v });
        tr.createEl("td", { text: desc });
      }
    });
  }

  private renderCustomRule(containerEl: HTMLElement, rule: CommandRule): void {
    new Setting(containerEl)
      .setName(rule.label)
      .setDesc(`检测: ${rule.detectCmd}\n模板: ${rule.template}`)
      .addButton((b) =>
        b
          .setButtonText("删除")
          .setWarning()
          .onClick(async () => {
            const store = new CommandRuleStore();
            store.loadFromJSON(this.plugin.settings.customCommandRules);
            store.remove(rule.id);
            this.plugin.settings.customCommandRules = store.toJSON();
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }

  private showAddRuleDialog(containerEl: HTMLElement): void {
    const store = new CommandRuleStore();
    store.loadFromJSON(this.plugin.settings.customCommandRules);

    // Simple inline form using Obsidian settings API
    const form = containerEl.createDiv({ cls: "mae-rule-form" });

    let newId = "";
    let newLabel = "";
    let newDetectCmd = "";
    let newTemplate = "";
    let newInstallHint = "";

    new Setting(form)
      .setName("规则 ID")
      .addText((t) => t.setPlaceholder("my-agent").onChange((v) => (newId = v.trim())));
    new Setting(form)
      .setName("显示名")
      .addText((t) => t.setPlaceholder("My Agent").onChange((v) => (newLabel = v.trim())));
    new Setting(form)
      .setName("检测命令")
      .addText((t) => t.setPlaceholder("which my-agent").onChange((v) => (newDetectCmd = v.trim())));
    new Setting(form)
      .setName("命令模板")
      .addTextArea((t) =>
        t
          .setPlaceholder('cd {{vaultPath}} && my-agent "读取 {{instructionFile}}"')
          .onChange((v) => (newTemplate = v.trim())),
      );
    new Setting(form)
      .setName("安装提示")
      .addText((t) => t.setPlaceholder("npm i -g my-agent").onChange((v) => (newInstallHint = v.trim())));

    new Setting(form)
      .addButton((b) =>
        b
          .setButtonText("保存")
          .setCta()
          .onClick(async () => {
            if (!newId || !newLabel || !newTemplate || !newDetectCmd) {
              new Notice("请填写所有必填字段");
              return;
            }
            try {
              store.add({
                id: newId,
                label: newLabel,
                detectCmd: newDetectCmd,
                template: newTemplate,
                installHint: newInstallHint || "自定义安装方式",
              });
              this.plugin.settings.customCommandRules = store.toJSON();
              await this.plugin.saveSettings();
              this.display();
              new Notice(`规则 "${newLabel}" 已添加`);
            } catch (err) {
              new Notice(`添加失败: ${(err as Error).message}`);
            }
          }),
      )
      .addButton((b) =>
        b.setButtonText("取消").onClick(() => {
          form.remove();
        }),
      );
  }
}
