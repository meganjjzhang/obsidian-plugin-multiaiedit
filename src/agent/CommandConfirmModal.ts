import { App, Modal, setIcon, Notice } from "obsidian";
import { copyToClipboard } from "../export/Exporters";
import { CommandRule } from "./CommandRuleStore";
import { t } from "../i18n/i18n";

/** Initial char → accent color bucket (same as AgentSelectModal) */
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
 * Modal that shows the full command about to be executed and asks
 * the user to confirm.  Visual design matching Confirm Execution.html.
 *
 * Also offers a "Copy Command" fallback so the user can paste it
 * into their own terminal.
 */
export class CommandConfirmModal extends Modal {
	private resolve: ((confirmed: boolean) => void) | null = null;

	constructor(
		app: App,
		private command: string,
		private rule: CommandRule,
		private instructionFile?: string,
	) {
		super(app);
	}

	/**
	 * Open the modal and return a promise that resolves with
	 * `true` if the user confirmed, `false` if cancelled.
	 */
	openForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { modalEl } = this;
		modalEl.empty();
		modalEl.addClass("prm-confirm-modal");

		const col = colorFor(this.rule.label);

		// ── Header ──
		const header = modalEl.createDiv({ cls: "prm-ccm-header" });
		const headerLeft = header.createDiv({ cls: "prm-ccm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "prm-ccm-icon" });
		setIcon(iconWrap, "terminal");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "prm-ccm-title", text: t("agent.confirm.title") });
		titleWrap.createDiv({
			cls: "prm-ccm-subtitle",
			text: t("agent.confirm.subtitle", { label: this.rule.label }),
		});

		const closeBtn = header.createEl("button", { cls: "prm-ccm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.resolve?.(false);
			this.close();
		};

		// ── Agent badge row ──
		const badgeRow = modalEl.createDiv({ cls: "prm-ccm-agent-row" });
		const agentAvatar = badgeRow.createDiv({ cls: "prm-ccm-agent-avatar" });
		agentAvatar.style.setProperty('--prm-color-bg', col.bg);
		agentAvatar.style.setProperty('--prm-color-border', col.border);
		agentAvatar.addClass('prm-dynamic-bg');
		agentAvatar.addClass('prm-dynamic-border-color');
		const avatarSpan = agentAvatar.createSpan({ cls: "prm-ccm-agent-char", text: this.rule.label[0] });
		avatarSpan.style.setProperty('--prm-color-text', col.text);
		avatarSpan.addClass('prm-dynamic-text-color');

		badgeRow.createSpan({ cls: "prm-ccm-agent-name", text: this.rule.label });

		const badge = badgeRow.createSpan({
			cls: "prm-ccm-agent-badge installed",
			text: t("agent.confirm.installed"),
		});

		if (this.rule.vendor) {
			badgeRow.createSpan({
				cls: "prm-ccm-agent-vendor",
				text: `${this.rule.vendor}`,
			});
		}

		// ── Command display ──
		const cmdWrap = modalEl.createDiv({ cls: "prm-ccm-cmd-wrap" });
		const cmdBox = cmdWrap.createDiv({ cls: "prm-ccm-cmd-box" });
		const cmdHeader = cmdBox.createDiv({ cls: "prm-ccm-cmd-header" });
		cmdHeader.createSpan({ cls: "prm-ccm-cmd-label", text: t("agent.confirm.commandLabel") });
		cmdBox.createEl("code", { cls: "prm-ccm-code", text: this.command });

		// ── Warning ──
		const warnBox = modalEl.createDiv({ cls: "prm-ccm-warning" });
		const warnIcon = warnBox.createDiv({ cls: "prm-ccm-warning-icon" });
		setIcon(warnIcon, "alert-triangle");
		warnBox.createEl("p", {
			cls: "prm-ccm-warning-text",
			text: t("agent.confirm.warning"),
		});

		// ── Instruction file hint (optional) ──
		if (this.instructionFile) {
			const hintRow = modalEl.createDiv({ cls: "prm-ccm-hint" });
			const hintIcon = hintRow.createDiv({ cls: "prm-ccm-hint-icon" });
			setIcon(hintIcon, "file-text");
			hintRow.createSpan({
				cls: "prm-ccm-hint-text",
				text: t("agent.confirm.instructionFile", { path: this.instructionFile }),
			});
		}

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "prm-ccm-footer" });
		const footerLeft = footer.createDiv({ cls: "prm-ccm-footer-left" });
		const cancelBtn = footerLeft.createEl("button", { cls: "prm-ccm-btn prm-ccm-btn-cancel" });
		const cancelInner = cancelBtn.createSpan({ cls: "prm-ccm-btn-inner" });
		const cancelIcon = cancelInner.createSpan({ cls: "prm-ccm-btn-icon" });
		setIcon(cancelIcon, "x");
		cancelInner.createSpan({ text: t("agent.confirm.btn.cancel") });
		cancelBtn.onclick = () => {
			this.resolve?.(false);
			this.close();
		};

		const footerRight = footer.createDiv({ cls: "prm-ccm-footer-right" });
		const copyBtn = footerRight.createEl("button", { cls: "prm-ccm-btn prm-ccm-btn-copy" });
		const copyInner = copyBtn.createSpan({ cls: "prm-ccm-btn-inner" });
		const copyIcon = copyInner.createSpan({ cls: "prm-ccm-btn-icon" });
		setIcon(copyIcon, "copy");
		copyInner.createSpan({ text: t("agent.confirm.btn.copyCommand") });
		copyBtn.onclick = () => {
			void copyToClipboard(this.command);
			new Notice(t("agent.confirm.notice.copied"));
			this.resolve?.(false);
			this.close();
		};

		const execBtn = footerRight.createEl("button", { cls: "prm-ccm-btn prm-ccm-btn-exec" });
		const execInner = execBtn.createSpan({ cls: "prm-ccm-btn-inner" });
		const execIcon = execInner.createSpan({ cls: "prm-ccm-btn-icon" });
		setIcon(execIcon, "play");
		execInner.createSpan({ text: t("agent.confirm.btn.execute") });
		execBtn.onclick = () => {
			this.resolve?.(true);
			this.close();
		};
	}

	onClose(): void {
		// If the modal is closed without a choice, treat as cancel.
		this.resolve?.(false);
		this.resolve = null;
	}
}
