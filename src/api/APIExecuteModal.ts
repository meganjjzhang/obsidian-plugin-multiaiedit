import { App, Modal, setIcon, Notice } from "obsidian";
import { APIProviderConfig, APIProviderType, PROVIDER_DEFAULTS } from "./APIProvider";
import { t } from "../i18n/i18n";

export interface APIExecuteResult {
	action: "execute" | "cancel";
}

/** Provider initial → accent color bucket */
const PROVIDER_COLORS: Record<string, { bg: string; border: string; text: string }> = {
	A: { bg: "rgba(96,165,250,0.10)",  border: "rgba(96,165,250,0.20)",  text: "rgba(96,165,250,0.90)" },  // Anthropic
	O: { bg: "rgba(74,222,128,0.08)",  border: "rgba(74,222,128,0.15)",  text: "rgba(74,222,128,0.80)" },  // OpenAI
	D: { bg: "rgba(96,165,250,0.10)",  border: "rgba(96,165,250,0.20)",  text: "rgba(96,165,250,0.90)" },  // DeepSeek
	G: { bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.15)",  text: "rgba(251,191,36,0.80)" },  // Gemini
	C: { bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.20)", text: "rgba(167,139,250,0.90)" }, // Custom
};

const PROVIDER_LABEL: Record<APIProviderType, string> = {
	anthropic: "Anthropic (Claude)",
	openai: "OpenAI (GPT)",
	deepseek: "DeepSeek",
	gemini: "Google Gemini",
	custom: t("settings.api.provider.custom"),
};

function colorFor(provider: APIProviderType) {
	const key = provider[0]?.toUpperCase() ?? "C";
	return PROVIDER_COLORS[key] ?? PROVIDER_COLORS["C"];
}

/**
 * Pre-execution confirmation modal for API Key direct call.
 * Visual design matching API Confirm.html — same language as CommandConfirmModal.
 */
export class APIConfirmModal extends Modal {
	private resolve: ((r: APIExecuteResult) => void) | null = null;

	constructor(
		app: App,
		private config: APIProviderConfig,
		private estimatedTokens: number,
		private reviewCount: number,
	) {
		super(app);
	}

	openForResult(): Promise<APIExecuteResult> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { modalEl } = this;
		modalEl.empty();
		modalEl.addClass("prm-api-confirm-modal");

		const col = colorFor(this.config.provider);
		const providerName = PROVIDER_LABEL[this.config.provider];
		const modelName = this.config.model || PROVIDER_DEFAULTS[this.config.provider].model;

		// ── Header ──
		const header = modalEl.createDiv({ cls: "prm-apm-header" });
		const headerLeft = header.createDiv({ cls: "prm-apm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "prm-apm-icon" });
		setIcon(iconWrap, "zap");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "prm-apm-title", text: t("api.execute.title") });
		titleWrap.createDiv({
			cls: "prm-apm-subtitle",
			text: `${providerName} · ${t("api.execute.subtitle")}`,
		});

		const closeBtn = header.createEl("button", { cls: "prm-apm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.resolve?.({ action: "cancel" });
			this.close();
		};

		// ── Provider badge row ──
		const badgeRow = modalEl.createDiv({ cls: "prm-apm-provider-row" });
		const providerAvatar = badgeRow.createDiv({ cls: "prm-apm-provider-avatar" });
		providerAvatar.style.setProperty('--prm-color-bg', col.bg);
		providerAvatar.style.setProperty('--prm-color-border', col.border);
		providerAvatar.addClass('prm-dynamic-bg');
		providerAvatar.addClass('prm-dynamic-border-color');
		const avatarChar = providerAvatar.createSpan({ cls: "prm-apm-provider-char", text: providerName[0] });
		avatarChar.style.setProperty('--prm-color-text', col.text);
		avatarChar.addClass('prm-dynamic-text-color');
		badgeRow.createSpan({ cls: "prm-apm-provider-name", text: providerName });
		const badge = badgeRow.createSpan({ cls: "prm-apm-provider-badge", text: t("api.execute.provider") });
		badge.style.setProperty('--prm-color-bg', col.bg);
		badge.style.setProperty('--prm-color-border', col.border);
		badge.style.setProperty('--prm-color-text', col.text);
		badge.addClass('prm-dynamic-bg');
		badge.addClass('prm-dynamic-border-color');
		badge.addClass('prm-dynamic-text-color');

		// ── Info table ──
		const infoWrap = modalEl.createDiv({ cls: "prm-apm-info-wrap" });
		const infoBox = infoWrap.createDiv({ cls: "prm-apm-info-box" });

		const addRow = (label: string, value: string, warn = false) => {
			const row = infoBox.createDiv({ cls: "prm-apm-info-row" });
			row.createSpan({ cls: "prm-apm-info-label", text: label });
			const val = row.createSpan({ cls: warn ? "prm-apm-info-value prm-apm-info-warn" : "prm-apm-info-value", text: value });
			return val;
		};

		addRow(t("api.execute.model"), modelName);
		addRow(t("api.execute.reviews"), t("api.execute.reviewCount", { n: this.reviewCount }));
		addRow(t("api.execute.tokens"), `~${this.estimatedTokens.toLocaleString()}`, this.estimatedTokens > 50_000);

		// ── Warning ──
		const warnBox = modalEl.createDiv({ cls: "prm-apm-warning" });
		const warnIcon = warnBox.createDiv({ cls: "prm-apm-warning-icon" });
		setIcon(warnIcon, "alert-triangle");
		warnBox.createEl("p", {
			cls: "prm-apm-warning-text",
			text: t("api.execute.warning"),
		});

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "prm-apm-footer" });
		const cancelBtn = footer.createEl("button", { cls: "prm-apm-btn prm-apm-btn-cancel" });
		const cancelInner = cancelBtn.createSpan({ cls: "prm-apm-btn-inner" });
		const cancelIcon = cancelInner.createSpan({ cls: "prm-apm-btn-icon" });
		setIcon(cancelIcon, "x");
		cancelInner.createSpan({ text: t("api.execute.btn.cancel") });
		cancelBtn.onclick = () => {
			this.resolve?.({ action: "cancel" });
			this.close();
		};

		const execBtn = footer.createEl("button", { cls: "prm-apm-btn prm-apm-btn-exec" });
		const execInner = execBtn.createSpan({ cls: "prm-apm-btn-inner" });
		const execIcon = execInner.createSpan({ cls: "prm-apm-btn-icon" });
		setIcon(execIcon, "send");
		execInner.createSpan({ text: t("api.execute.btn.confirm") });
		execBtn.onclick = () => {
			this.resolve?.({ action: "execute" });
			this.close();
		};
	}

	onClose(): void {
		this.resolve?.({ action: "cancel" });
		this.resolve = null;
	}
}

// ---------- Progress / result modal ----------

export type APIProgressState =
	| { phase: "calling" }
	| { phase: "done"; text: string }
	| { phase: "error"; message: string };

/**
 * Modal shown while the API call is in progress.
 * Three visual states: calling (spinner), error, done.
 */
export class APIProgressModal extends Modal {
	private state: APIProgressState = { phase: "calling" };
	private contentArea!: HTMLElement;
	private resolve: ((text: string | null) => void) | null = null;

	constructor(app: App) {
		super(app);
		// Prevent accidental close while calling
		this.modalEl.addEventListener("keydown", (e) => {
			if (this.state.phase === "calling" && e.key === "Escape") {
				e.stopPropagation();
			}
		}, true);
	}

	openForResult(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { modalEl } = this;
		modalEl.empty();
		modalEl.addClass("prm-api-progress-modal");

		// ── Header ──
		const header = modalEl.createDiv({ cls: "prm-ppm-header" });
		const headerLeft = header.createDiv({ cls: "prm-ppm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "prm-ppm-icon" });
		setIcon(iconWrap, "zap");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "prm-ppm-title", text: t("api.progress.title") });
		titleWrap.createDiv({ cls: "prm-ppm-subtitle", text: t("api.progress.subtitle") });

		// ── Content area (re-rendered by setState) ──
		this.contentArea = modalEl.createDiv({ cls: "prm-ppm-content" });

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "prm-ppm-footer" });
		const closeBtnWrap = footer.createDiv({ cls: "prm-ppm-footer-right" });
		const closeBtn = closeBtnWrap.createEl("button", { cls: "prm-ppm-btn prm-ppm-btn-close" });
		const closeInner = closeBtn.createSpan({ cls: "prm-ppm-btn-inner" });
		closeInner.createSpan({ text: t("api.progress.btn.close") });
		closeBtn.onclick = () => {
			this.resolve?.(null);
			this.close();
		};
		closeBtn.addClass("prm-hidden"); // hidden during calling

		const diffBtn = closeBtnWrap.createEl("button", { cls: "prm-ppm-btn prm-ppm-btn-diff" });
		const diffInner = diffBtn.createSpan({ cls: "prm-ppm-btn-inner" });
		const diffIcon = diffInner.createSpan({ cls: "prm-ppm-btn-icon" });
		setIcon(diffIcon, "git-compare");
		diffInner.createSpan({ text: t("api.progress.btn.viewDiff") });
		diffBtn.onclick = () => {
			this.resolve?.(this.state.phase === "done" ? this.state.text : null);
			this.close();
		};
		diffBtn.addClass("prm-hidden");

		this.render();
	}

	setState(state: APIProgressState): void {
		this.state = state;
		this.render();
	}

	private render(): void {
		const area = this.contentArea;
		area.empty();

		// Footer buttons
		const footerRight = this.modalEl.querySelector(".prm-ppm-footer-right") as HTMLElement;
		const closeBtn = footerRight?.querySelector(".prm-ppm-btn-close") as HTMLElement;
		const diffBtn = footerRight?.querySelector(".prm-ppm-btn-diff") as HTMLElement;
		if (closeBtn) closeBtn.addClass("prm-hidden");
		if (diffBtn) diffBtn.addClass("prm-hidden");

		if (this.state.phase === "calling") {
			area.createDiv({ cls: "prm-ppm-spinner" });
			area.createEl("p", { cls: "prm-ppm-calling-text", text: t("api.progress.calling") });
			return;
		}

		if (this.state.phase === "error") {
			const errBox = area.createDiv({ cls: "prm-ppm-error" });
			const errIcon = errBox.createDiv({ cls: "prm-ppm-error-icon" });
			setIcon(errIcon, "x-circle");
			errBox.createEl("p", { cls: "prm-ppm-error-text", text: t("api.progress.failed", { error: this.state.message }) });
			if (closeBtn) closeBtn.removeClass("prm-hidden");
			return;
		}

		// done
		const doneBox = area.createDiv({ cls: "prm-ppm-success" });
		const doneIcon = doneBox.createDiv({ cls: "prm-ppm-success-icon" });
		setIcon(doneIcon, "check-circle");
		doneBox.createEl("p", { cls: "prm-ppm-success-text", text: t("api.progress.success") });
		if (diffBtn) diffBtn.removeClass("prm-hidden");
	}

	onClose(): void {
		if (this.state.phase === "calling") {
			new Notice(t("api.progress.cancelled"));
		}
		this.resolve?.(null);
		this.resolve = null;
	}
}
