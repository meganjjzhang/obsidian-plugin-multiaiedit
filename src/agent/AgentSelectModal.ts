import { App, Modal, setIcon } from "obsidian";
import { CommandRule } from "./CommandRuleStore";
import { AgentInfo } from "./AgentDetector";

export interface AgentSelectResult {
	rule: CommandRule | null; // null = cancelled
}

/** Initial char → accent color bucket */
const AGENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
	C: { bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.20)", text: "rgba(167,139,250,0.90)" },
	I: { bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.20)", text: "rgba(167,139,250,0.90)" },
	O: { bg: "rgba(74,222,128,0.08)",  border: "rgba(74,222,128,0.15)",  text: "rgba(74,222,128,0.80)"  },
	A: { bg: "rgba(96,165,250,0.08)",  border: "rgba(96,165,250,0.15)",  text: "rgba(96,165,250,0.80)"  },
	G: { bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.15)",  text: "rgba(251,191,36,0.80)"  },
};

function colorFor(label: string) {
	const key = label[0]?.toUpperCase() ?? "C";
	return AGENT_COLORS[key] ?? AGENT_COLORS["C"];
}

/**
 * Agent selection modal — visual design matching Select Agent.html.
 * Shows all agents (installed + uninstalled), lets user pick one,
 * then resolves with the selected rule.
 */
export class AgentSelectModal extends Modal {
	private selected: CommandRule | null = null;
	private resolve: ((r: AgentSelectResult) => void) | null = null;

	constructor(
		app: App,
		private agents: AgentInfo[],
	) {
		super(app);
	}

	openForResult(): Promise<AgentSelectResult> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { modalEl } = this;
		modalEl.empty();
		modalEl.addClass("mae-agent-select-modal");

		// ── Header ──
		const header = modalEl.createDiv({ cls: "mae-asm-header" });
		const headerLeft = header.createDiv({ cls: "mae-asm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "mae-asm-icon" });
		setIcon(iconWrap, "bot");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "mae-asm-title", text: "Select Agent" });
		titleWrap.createDiv({ cls: "mae-asm-subtitle", text: "Choose an AI agent to execute edits" });

		const closeBtn = header.createEl("button", { cls: "mae-asm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.resolve?.({ rule: null });
			this.close();
		};

		// ── Agent list ──
		const list = modalEl.createDiv({ cls: "mae-asm-list" });

		// Pre-select first installed agent
		const firstInstalled = this.agents.find((a) => a.installed);
		if (firstInstalled) this.selected = firstInstalled.rule;

		const rowEls: Map<string, HTMLElement> = new Map();

		for (const info of this.agents) {
			const { rule, installed } = info;
			const col = colorFor(rule.label);
			const isActive = this.selected?.id === rule.id;

			const row = list.createDiv({
				cls: "mae-asm-row" + (isActive ? " active" : "") + (!installed ? " disabled" : ""),
			});
			rowEls.set(rule.id, row);

			// Avatar
			const avatar = row.createDiv({ cls: "mae-asm-avatar" });
			avatar.style.background = col.bg;
			avatar.style.borderColor = col.border;
			// Use "CI" for Claude Internal to distinguish from Claude Code
			const avatarChar = rule.id === "claude-internal" ? "CI" : rule.label[0];
			avatar.createSpan({ cls: "mae-asm-avatar-char", text: avatarChar });
			(avatar.querySelector(".mae-asm-avatar-char") as HTMLElement).style.color = col.text;

			// Info
			const info2 = row.createDiv({ cls: "mae-asm-info" });
			const nameRow = info2.createDiv({ cls: "mae-asm-name-row" });
			nameRow.createSpan({ cls: "mae-asm-name", text: rule.label });
			const badge = nameRow.createSpan({
				cls: "mae-asm-badge " + (installed ? "installed" : "missing"),
				text: installed ? "installed" : "missing",
			});

			info2.createDiv({
				cls: "mae-asm-meta",
				text: rule.vendor ? `${rule.vendor} · ${rule.installHint}` : rule.installHint,
			});

			// Radio
			const radio = row.createDiv({ cls: "mae-asm-radio" + (isActive ? " selected" : "") });
			if (isActive) radio.createDiv({ cls: "mae-asm-radio-dot" });

			if (installed) {
				row.onclick = () => {
					this.selected = rule;
					// Update all rows
					for (const [id, el] of rowEls) {
						el.removeClass("active");
						const r = el.querySelector(".mae-asm-radio");
						r?.removeClass("selected");
						r?.querySelector(".mae-asm-radio-dot")?.remove();
					}
					row.addClass("active");
					radio.addClass("selected");
					if (!radio.querySelector(".mae-asm-radio-dot")) {
						radio.createDiv({ cls: "mae-asm-radio-dot" });
					}
				};
			}
		}

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "mae-asm-footer" });

		const configBtn = footer.createEl("button", { cls: "mae-asm-config-btn", text: "+ Configure custom agent" });
		configBtn.onclick = () => {
			(this.app as any).setting?.open();
			(this.app as any).setting?.openTabById?.("multiaiedit");
			this.resolve?.({ rule: null });
			this.close();
		};

		const confirmBtn = footer.createEl("button", { cls: "mae-asm-confirm-btn", text: "Confirm" });
		confirmBtn.onclick = () => {
			this.resolve?.({ rule: this.selected });
			this.close();
		};
	}

	onClose(): void {
		this.resolve?.({ rule: null });
		this.resolve = null;
	}
}
