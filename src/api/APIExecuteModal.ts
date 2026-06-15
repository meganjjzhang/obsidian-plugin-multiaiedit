import { App, Modal, Setting, Notice, setIcon } from "obsidian";
import { APIProviderConfig, APIProviderType, PROVIDER_DEFAULTS } from "./APIProvider";

export interface APIExecuteResult {
	action: "execute" | "cancel";
}

/**
 * Pre-execution confirmation modal for API Key direct call.
 * Shows:
 *  - Selected provider + model
 *  - Privacy notice (data leaves the vault)
 *  - Estimated token count
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
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("mae-confirm-modal");

		containerEl.createEl("h2", { text: "API 执行确认" });

		const providerLabel: Record<APIProviderType, string> = {
			anthropic: "Anthropic (Claude)",
			openai: "OpenAI (GPT)",
			deepseek: "DeepSeek",
			gemini: "Google Gemini",
			custom: "自定义端点",
		};

		containerEl.createEl("p", {
			text: `Provider：${providerLabel[this.config.provider]}`,
		});
		containerEl.createEl("p", {
			text: `模型：${this.config.model || PROVIDER_DEFAULTS[this.config.provider].model}`,
		});
		containerEl.createEl("p", {
			text: `批阅条数：${this.reviewCount}`,
		});
		containerEl.createEl("p", {
			text: `预估输入 Token：~${this.estimatedTokens.toLocaleString()}`,
			cls: this.estimatedTokens > 50_000 ? "mae-warn-text" : "",
		});

		const warnP = containerEl.createEl("p", {
			cls: "mae-confirm-warning",
		});
		setIcon(warnP, "alert-triangle");
		warnP.appendText(" 原文与批阅意见将发送至所选 Provider，请确认不含敏感信息。");

		new Setting(containerEl)
			.addButton((b) =>
				b.setButtonText("取消").onClick(() => {
					this.resolve?.({ action: "cancel" });
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("确认执行")
					.setCta()
					.onClick(() => {
						this.resolve?.({ action: "execute" });
						this.close();
					}),
			);
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
 * Callers update state via `setState()`; the modal auto-closes on done/error
 * after the user clicks OK.
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
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("mae-api-progress-modal");
		containerEl.createEl("h2", { text: "API 执行中…" });
		this.contentArea = containerEl.createDiv({ cls: "mae-api-progress-content" });
		this.render();
	}

	setState(state: APIProgressState): void {
		this.state = state;
		this.render();
	}

	private render(): void {
		const area = this.contentArea;
		area.empty();

		if (this.state.phase === "calling") {
			area.createEl("p", { text: "正在调用 API，请稍候…" });
			area.createDiv({ cls: "mae-spinner" });
			return;
		}

		if (this.state.phase === "error") {
			area.createEl("p", {
				cls: "mae-error-text",
			}).setText(`调用失败：${this.state.message}`);
			new Setting(area).addButton((b) =>
				b.setButtonText("关闭").onClick(() => {
					this.resolve?.(null);
					this.close();
				}),
			);
			return;
		}

		// done
		const successP = area.createEl("p");
		setIcon(successP, "check-circle");
		successP.appendText(" API 返回成功，即将打开 Diff 预览");
		new Setting(area).addButton((b) =>
			b
				.setButtonText("查看 Diff")
				.setCta()
				.onClick(() => {
					this.resolve?.(this.state.phase === "done" ? this.state.text : null);
					this.close();
				}),
		);
	}

	onClose(): void {
		if (this.state.phase === "calling") {
			new Notice("API 调用已取消");
		}
		this.resolve?.(null);
		this.resolve = null;
	}
}
