import { validateTemplate, extractVariables } from "../utils/shellescape";

// ---------- types ----------

export interface CommandRule {
	id: string;
	label: string;
	detectCmd: string;     // e.g. "which claude"
	template: string;       // e.g. 'cd "{{vaultPath}}" && claude ...'
	installHint: string;   // shown when Agent is not installed
	isPreset: boolean;     // true for built-in, false for user-created
	vendor?: string;       // display: "Anthropic", "OpenAI", etc.
}

// ---------- preset rules ----------

export const PRESET_RULES: CommandRule[] = [
	{
		id: "claude",
		label: "Claude Code",
		vendor: "Anthropic",
		detectCmd: "which claude",
		template:
			'cd {{vaultPath}} && claude "读取 {{instructionFile}}，按批注指令修改对应文件"',
		installHint: "npm i -g @anthropic-ai/claude-code",
		isPreset: true,
	},
	{
		id: "claude-internal",
		label: "Claude Internal",
		vendor: "Anthropic (internal)",
		detectCmd: "which claude-internal",
		template:
			'cd {{vaultPath}} && claude-internal --config-dir ~/.claude-internal "读取 {{instructionFile}}，按批注指令修改对应文件"',
		installHint: "内部版本，需要内部权限",
		isPreset: true,
	},
	{
		id: "codex",
		label: "Codex CLI",
		vendor: "OpenAI",
		detectCmd: "which codex",
		template:
			'cd {{vaultPath}} && codex "读取 {{instructionFile}}，按批注指令修改对应文件"',
		installHint: "npm i -g @openai/codex",
		isPreset: true,
	},
	{
		id: "aider",
		label: "Aider",
		vendor: "Paul Gauthier",
		detectCmd: "which aider",
		template:
			'cd {{vaultPath}} && aider --msg "读取 {{instructionFile}}，按批注指令修改对应文件"',
		installHint: "pip install aider-chat",
		isPreset: true,
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		vendor: "Google",
		detectCmd: "which gemini",
		template:
			'cd {{vaultPath}} && gemini "读取 {{instructionFile}}，按批注指令修改对应文件"',
		installHint: "npm i -g @google/gemini-cli",
		isPreset: true,
	},
];

// ---------- store ----------

export class CommandRuleStore {
	private customRules: CommandRule[] = [];

	loadFromJSON(raw: unknown): void {
		if (!Array.isArray(raw)) return;
		this.customRules = (raw as CommandRule[]).filter((r) => {
			if (!r.id || !r.label || !r.template || !r.detectCmd) return false;
			try {
				validateTemplate(r.template);
				extractVariables(r.template);
				return true;
			} catch {
				return false;
			}
		});
	}

	toJSON(): CommandRule[] {
		return this.customRules;
	}

	/** All rules: presets + custom */
	allRules(): CommandRule[] {
		return [...PRESET_RULES, ...this.customRules];
	}

	/** Only custom rules */
	getCustomRules(): CommandRule[] {
		return [...this.customRules];
	}

	/** Find by id */
	getById(id: string): CommandRule | undefined {
		return this.allRules().find((r) => r.id === id);
	}

	/** Add a new custom rule. Validates the template. */
	add(rule: Omit<CommandRule, "isPreset">): void {
		validateTemplate(rule.template);
		extractVariables(rule.template);
		if (this.allRules().some((r) => r.id === rule.id)) {
			throw new Error(`规则 ID "${rule.id}" 已存在`);
		}
		this.customRules.push({ ...rule, isPreset: false });
	}

	/** Update an existing custom rule. Presets cannot be edited. */
	update(id: string, patch: Partial<Omit<CommandRule, "id" | "isPreset">>): void {
		if (PRESET_RULES.some((r) => r.id === id)) {
			throw new Error("预设规则不可编辑");
		}
		const idx = this.customRules.findIndex((r) => r.id === id);
		if (idx === -1) throw new Error(`自定义规则 "${id}" 不存在`);
		const merged = { ...this.customRules[idx], ...patch };
		if (patch.template) {
			validateTemplate(merged.template);
			extractVariables(merged.template);
		}
		this.customRules[idx] = merged;
	}

	/** Remove a custom rule by id */
	remove(id: string): void {
		if (PRESET_RULES.some((r) => r.id === id)) {
			throw new Error("预设规则不可删除");
		}
		this.customRules = this.customRules.filter((r) => r.id !== id);
	}
}
