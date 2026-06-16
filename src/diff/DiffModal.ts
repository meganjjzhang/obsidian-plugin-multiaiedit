import { App, Modal, setIcon } from "obsidian";
import {
	DiffBlock,
	computeDiff,
	countChangedLines,
	applyPartialDiff,
} from "./DiffCalculator";
import { t } from "../i18n/i18n";

export interface DiffModalResult {
	action: "accept-all" | "accept-partial" | "reject";
	mergedText?: string;
}

interface Hunk {
	header: string;
	blocks: DiffBlock[];
	changeIndices: number[];
}

function groupIntoHunks(blocks: DiffBlock[], ctxLines = 2): Hunk[] {
	const n = blocks.length;
	const changed = new Set<number>();
	blocks.forEach((b, i) => { if (b.type !== "unchanged") changed.add(i); });
	if (changed.size === 0) return [];

	const ranges: Array<{ start: number; end: number }> = [];
	let curStart = -1;
	let curEnd = -1;
	const changedArr = [...changed].sort((a, b) => a - b);
	for (const idx of changedArr) {
		const s = Math.max(0, idx - ctxLines);
		const e = Math.min(n - 1, idx + ctxLines);
		if (curStart === -1) {
			curStart = s; curEnd = e;
		} else if (s <= curEnd + 1) {
			curEnd = Math.max(curEnd, e);
		} else {
			ranges.push({ start: curStart, end: curEnd });
			curStart = s; curEnd = e;
		}
	}
	if (curStart !== -1) ranges.push({ start: curStart, end: curEnd });

	return ranges.map(({ start, end }) => {
		const slice = blocks.slice(start, end + 1);
		const changeIndices = slice.filter(b => b.type !== "unchanged").map(b => b.index);
		const firstRemoved = slice.find(b => b.type === "removed" || b.type === "unchanged");
		const firstAdded   = slice.find(b => b.type === "added"   || b.type === "unchanged");
		const oldStart = firstRemoved?.oldLineNumber ?? slice[0]?.oldLineNumber ?? 1;
		const newStart = firstAdded?.newLineNumber   ?? slice[0]?.newLineNumber ?? 1;
		const oldCount = slice.filter(b => b.type !== "added").length;
		const newCount = slice.filter(b => b.type !== "removed").length;
		const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
		return { header, blocks: slice, changeIndices };
	});
}

export class DiffModal extends Modal {
	private blocks: DiffBlock[];
	private hunks: Hunk[];
	/** true = accepted, false = rejected, undefined = pending */
	private hunkDecisions: Map<number, boolean> = new Map();
	private acceptMap: Map<number, boolean> = new Map();
	private result: DiffModalResult | null = null;
	private resolve: ((result: DiffModalResult) => void) | null = null;

	constructor(
		app: App,
		private originalText: string,
		private modifiedText: string,
		private fileName: string,
	) {
		super(app);
		this.blocks = computeDiff(originalText, modifiedText);
		this.hunks = groupIntoHunks(this.blocks);
		// Default: all changes accepted
		for (const b of this.blocks) {
			if (b.type !== "unchanged") this.acceptMap.set(b.index, true);
		}
	}

	openForResult(): Promise<DiffModalResult> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { modalEl } = this;
		modalEl.empty();
		modalEl.addClass("prm-diff-modal");

		const { added, removed } = countChangedLines(this.blocks);

		// ── Header ──
		const header = modalEl.createDiv({ cls: "prm-dm-header" });
		const headerLeft = header.createDiv({ cls: "prm-dm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "prm-dm-icon" });
		setIcon(iconWrap, "git-compare-arrows");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "prm-dm-title", text: t("diff.title") });
		titleWrap.createDiv({
			cls: "prm-dm-subtitle",
			text: t("diff.subtitle", { file: this.fileName, n: this.hunks.length }),
		});

		const headerRight = header.createDiv({ cls: "prm-dm-header-right" });
		const hunkBadge = headerRight.createSpan({ cls: "prm-dm-hunk-badge" });
		hunkBadge.setText(`${this.hunks.length} ${t("diff.hunks")}`);

		const closeBtn = headerRight.createEl("button", { cls: "prm-dm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.result = { action: "reject" };
			this.close();
		};

		// ── Hunk list ──
		const content = modalEl.createDiv({ cls: "prm-dm-content" });

		if (this.hunks.length === 0) {
			content.createDiv({ cls: "prm-dm-empty", text: t("diff.noChanges") });
		} else {
			this.hunks.forEach((hunk, idx) => {
				this.renderHunk(content, hunk, idx);
			});
		}

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "prm-dm-footer" });

		const statsEl = footer.createDiv({ cls: "prm-dm-stats" });
		statsEl.createSpan({ cls: "prm-dm-stat-label", text: t("diff.changesLabel") });
		statsEl.createSpan({ cls: "prm-dm-stat-add", text: `+${added} lines` });
		statsEl.createSpan({ cls: "prm-dm-stat-del", text: `-${removed} lines` });

		const btns = footer.createDiv({ cls: "prm-dm-btns" });

		const rollbackBtn = btns.createEl("button", { cls: "prm-dm-btn-rollback" });
		setIcon(rollbackBtn, "rotate-ccw");
		rollbackBtn.createSpan({ text: t("diff.btn.rollbackAll") });
		rollbackBtn.onclick = () => {
			this.result = { action: "reject" };
			this.close();
		};

		const applyBtn = btns.createEl("button", { cls: "prm-dm-btn-accept" });
		setIcon(applyBtn, "check");
		applyBtn.createSpan({ text: t("diff.btn.applySelected") });
		applyBtn.onclick = () => {
			this.result = this.buildResultFromAcceptMap();
			this.close();
		};
	}

	onClose(): void {
		if (this.resolve) {
			if (!this.result) {
				this.result = this.buildResultFromAcceptMap();
			}
			this.resolve(this.result);
			this.resolve = null;
		}
	}

	private buildResultFromAcceptMap(): DiffModalResult {
		// Build the result from current hunk-level decisions.
		// Default map value is true, so untouched hunks are accepted unless rejected.
		const decisions = [...this.acceptMap.values()];
		const allAccepted = decisions.every(v => v);
		const allRejected = decisions.every(v => !v);
		if (allRejected) {
			return { action: "reject" };
		}
		if (allAccepted) {
			return { action: "accept-all" };
		}
		const merged = applyPartialDiff(this.originalText, this.blocks, this.acceptMap);
		return { action: "accept-partial", mergedText: merged };
	}

	private renderHunk(parent: HTMLElement, hunk: Hunk, idx: number): void {
		const wrap = parent.createDiv({ cls: "prm-dm-hunk" });

		// Hunk header
		const hunkHeader = wrap.createDiv({ cls: "prm-dm-hunk-header" });
		const hunkLeft = hunkHeader.createDiv({ cls: "prm-dm-hunk-header-left" });
		hunkLeft.createSpan({ cls: "prm-dm-hunk-pos", text: hunk.header });

		const hunkActions = hunkHeader.createDiv({ cls: "prm-dm-hunk-actions" });

		// Reject first, Accept second (right of Reject per design spec)
		const rejectBtn = hunkActions.createEl("button", { cls: "prm-dm-hunk-btn reject" });
		setIcon(rejectBtn, "x");
		rejectBtn.createSpan({ text: t("diff.btn.reject") });

		const acceptBtn = hunkActions.createEl("button", { cls: "prm-dm-hunk-btn accept" });
		setIcon(acceptBtn, "check");
		acceptBtn.createSpan({ text: t("diff.btn.accept") });

		acceptBtn.onclick = () => {
			hunk.changeIndices.forEach(i => this.acceptMap.set(i, true));
			this.hunkDecisions.set(idx, true);
			// Hide the hunk with a brief fade
			wrap.addClass("prm-dm-hunk-decided");
			window.setTimeout(() => wrap.remove(), 220);
		};

		rejectBtn.onclick = () => {
			hunk.changeIndices.forEach(i => this.acceptMap.set(i, false));
			this.hunkDecisions.set(idx, false);
			wrap.addClass("prm-dm-hunk-decided");
			window.setTimeout(() => wrap.remove(), 220);
		};

		// Diff lines
		const linesWrap = wrap.createDiv({ cls: "prm-dm-lines" });

		for (const block of hunk.blocks) {
			const row = linesWrap.createDiv({ cls: "prm-dm-line prm-dm-line-" + block.type });

			const lineNum = row.createSpan({ cls: "prm-dm-linenum" });
			const n = block.type === "removed" ? block.oldLineNumber
				: block.type === "added" ? block.newLineNumber
				: (block.oldLineNumber ?? "");
			lineNum.setText(String(n ?? ""));

			const prefix = row.createSpan({ cls: "prm-dm-prefix" });
			prefix.setText(block.type === "added" ? "+" : block.type === "removed" ? "-" : " ");

			row.createSpan({ cls: "prm-dm-text", text: block.content });
		}
	}
}
