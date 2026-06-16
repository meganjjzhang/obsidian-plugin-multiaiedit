import { App, Modal, setIcon } from "obsidian";
import { CommandRule } from "./CommandRuleStore";
import { AgentInfo } from "./AgentDetector";
import { t } from "../i18n/i18n";

export interface AgentSelectResult {
	rule: CommandRule | null; // null = cancelled
}

/** Initial char → accent color bucket */
const AGENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
	C: { bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.20)", text: "rgba(167,139,250,0.90)" },
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
		modalEl.addClass("prm-agent-select-modal");

		// ── Header ──
		const header = modalEl.createDiv({ cls: "prm-asm-header" });
		const headerLeft = header.createDiv({ cls: "prm-asm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "prm-asm-icon" });
		setIcon(iconWrap, "bot");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "prm-asm-title", text: t("agent.select.title") });
		titleWrap.createDiv({ cls: "prm-asm-subtitle", text: t("agent.select.subtitle") });

		const closeBtn = header.createEl("button", { cls: "prm-asm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.resolve?.({ rule: null });
			this.close();
		};

		// ── Agent list ──
		const list = modalEl.createDiv({ cls: "prm-asm-list" });

		// Pre-select first installed agent
		const firstInstalled = this.agents.find((a) => a.installed);
		if (firstInstalled) this.selected = firstInstalled.rule;

		const rowEls: Map<string, HTMLElement> = new Map();

		for (const info of this.agents) {
			const { rule, installed } = info;
			const col = colorFor(rule.label);
			const isActive = this.selected?.id === rule.id;

			const row = list.createDiv({
				cls: "prm-asm-row" + (isActive ? " active" : "") + (!installed ? " disabled" : ""),
			});
			rowEls.set(rule.id, row);

			// Avatar
			const avatar = row.createDiv({ cls: "prm-asm-avatar" });
			avatar.style.setProperty('--prm-color-bg', col.bg);
			avatar.style.setProperty('--prm-color-border', col.border);
			avatar.addClass('prm-dynamic-bg');
			avatar.addClass('prm-dynamic-border-color');
			avatar.createSpan({ cls: "prm-asm-avatar-char", text: rule.label[0] });
			(avatar.querySelector(".prm-asm-avatar-char") as HTMLElement).style.setProperty('--prm-color-text', col.text);
			(avatar.querySelector(".prm-asm-avatar-char") as HTMLElement).addClass('prm-dynamic-text-color');

			// Info
			const info2 = row.createDiv({ cls: "prm-asm-info" });
			const nameRow = info2.createDiv({ cls: "prm-asm-name-row" });
			nameRow.createSpan({ cls: "prm-asm-name", text: rule.label });
			const _badge = nameRow.createSpan({
				cls: "prm-asm-badge " + (installed ? "installed" : "missing"),
				text: installed ? t("agent.select.installed") : t("agent.select.missing"),
			});

			info2.createDiv({
				cls: "prm-asm-meta",
				text: rule.vendor ? `${rule.vendor} · ${rule.installHint}` : rule.installHint,
			});

			// Radio
			const radio = row.createDiv({ cls: "prm-asm-radio" + (isActive ? " selected" : "") });
			if (isActive) radio.createDiv({ cls: "prm-asm-radio-dot" });

			if (installed) {
				row.onclick = () => {
					this.selected = rule;
					// Update all rows
					for (const [_id, el] of rowEls) {
						el.removeClass("active");
						const r = el.querySelector(".prm-asm-radio");
						r?.removeClass("selected");
						r?.querySelector(".prm-asm-radio-dot")?.remove();
					}
					row.addClass("active");
					radio.addClass("selected");
					if (!radio.querySelector(".prm-asm-radio-dot")) {
						radio.createDiv({ cls: "prm-asm-radio-dot" });
					}
				};
			}
		}

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "prm-asm-footer" });

		const configBtn = footer.createEl("button", { cls: "prm-asm-config-btn", text: t("agent.select.addCustom") });
		configBtn.onclick = () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian internal API, no public type available
			(this.app as any).setting?.open();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian internal API, no public type available
			(this.app as any).setting?.openTabById?.("promptuary");
			this.resolve?.({ rule: null });
			this.close();
		};

		const confirmBtn = footer.createEl("button", { cls: "prm-asm-confirm-btn", text: t("agent.select.btn.confirm") });
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
