import { App, Modal, setIcon } from "obsidian";
import {
	DiffBlock,
	computeDiff,
	countChangedLines,
	applyPartialDiff,
} from "./DiffCalculator";

export interface DiffModalResult {
	action: "accept-all" | "accept-partial" | "reject";
	mergedText?: string;
}

interface Hunk {
	header: string;         // e.g. "@@ -23,3 +23,5 @@"
	context: string;        // section name hint
	blocks: DiffBlock[];    // all blocks in this hunk (context + changed)
	changeIndices: number[];// block.index values that are added/removed
}

/**
 * Group flat DiffBlocks into hunks.
 * Each hunk = a group of changed lines with 2-line context above/below.
 */
function groupIntoHunks(blocks: DiffBlock[], ctxLines = 2): Hunk[] {
	const n = blocks.length;
	// Mark changed positions
	const changed = new Set<number>();
	blocks.forEach((b, i) => { if (b.type !== "unchanged") changed.add(i); });

	if (changed.size === 0) return [];

	// Build index ranges for each hunk
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

	return ranges.map(({ start, end }, i) => {
		const slice = blocks.slice(start, end + 1);
		const changeIndices = slice.filter(b => b.type !== "unchanged").map(b => b.index);
		const firstChanged = slice.find(b => b.type !== "unchanged");
		const oldStart = slice[0]?.oldLineNumber ?? (firstChanged?.oldLineNumber ?? 0);
		const newStart = slice[0]?.newLineNumber ?? (firstChanged?.newLineNumber ?? 0);
		const oldCount = slice.filter(b => b.type === "removed" || b.type === "unchanged").length;
		const newCount = slice.filter(b => b.type === "added"   || b.type === "unchanged").length;
		const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
		return { header, context: `section ${i + 1}`, blocks: slice, changeIndices };
	});
}

export class DiffModal extends Modal {
	private blocks: DiffBlock[];
	private hunks: Hunk[];
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
		modalEl.addClass("mae-diff-modal");

		const { added, removed } = countChangedLines(this.blocks);

		// ── Header ──
		const header = modalEl.createDiv({ cls: "mae-dm-header" });
		const headerLeft = header.createDiv({ cls: "mae-dm-header-left" });
		const iconWrap = headerLeft.createDiv({ cls: "mae-dm-icon" });
		setIcon(iconWrap, "mae-diff");
		const titleWrap = headerLeft.createDiv();
		titleWrap.createDiv({ cls: "mae-dm-title", text: "Diff Preview" });
		titleWrap.createDiv({
			cls: "mae-dm-subtitle",
			text: `${this.fileName} — ${this.hunks.length} changes proposed`,
		});

		const headerRight = header.createDiv({ cls: "mae-dm-header-right" });
		headerRight.createSpan({ cls: "mae-dm-hunk-badge", text: `${this.hunks.length} hunks` });
		const closeBtn = headerRight.createEl("button", { cls: "mae-dm-close" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.result = { action: "reject" };
			this.close();
		};

		// ── Hunk list ──
		const content = modalEl.createDiv({ cls: "mae-dm-content" });

		if (this.hunks.length === 0) {
			content.createDiv({ cls: "mae-dm-empty", text: "No changes detected." });
		} else {
			for (const hunk of this.hunks) {
				this.renderHunk(content, hunk);
			}
		}

		// ── Footer ──
		const footer = modalEl.createDiv({ cls: "mae-dm-footer" });

		const statsEl = footer.createDiv({ cls: "mae-dm-stats" });
		statsEl.createSpan({ cls: "mae-dm-stat-label", text: "Changes: " });
		statsEl.createSpan({ cls: "mae-dm-stat-add", text: `+${added} lines` });
		statsEl.createSpan({ cls: "mae-dm-stat-del", text: `-${removed} lines` });

		const btns = footer.createDiv({ cls: "mae-dm-btns" });

		const rollbackBtn = btns.createEl("button", { cls: "mae-dm-btn-rollback" });
		rollbackBtn.innerHTML = `<span class="mae-dm-btn-icon"></span> Rollback all`;
		setIcon(rollbackBtn.querySelector(".mae-dm-btn-icon")!, "rotate-ccw");
		rollbackBtn.onclick = () => {
			this.result = { action: "reject" };
			this.close();
		};

		const acceptBtn = btns.createEl("button", { cls: "mae-dm-btn-accept" });
		acceptBtn.innerHTML = `<span class="mae-dm-btn-icon"></span> Accept all`;
		setIcon(acceptBtn.querySelector(".mae-dm-btn-icon")!, "mae-check-check");
		acceptBtn.onclick = () => {
			this.result = { action: "accept-all" };
			this.close();
		};
	}

	onClose(): void {
		if (this.resolve) {
			// If user didn't click a button, build partial from current acceptMap
			if (!this.result) {
				const allAccepted = [...this.acceptMap.values()].every(v => v);
				const allRejected = [...this.acceptMap.values()].every(v => !v);
				if (allRejected) {
					this.result = { action: "reject" };
				} else {
					const merged = applyPartialDiff(this.originalText, this.blocks, this.acceptMap);
					this.result = { action: "accept-partial", mergedText: merged };
				}
			}
			this.resolve(this.result);
			this.resolve = null;
		}
	}

	private renderHunk(parent: HTMLElement, hunk: Hunk): void {
		const wrap = parent.createDiv({ cls: "mae-dm-hunk" });

		// Hunk header row
		const hunkHeader = wrap.createDiv({ cls: "mae-dm-hunk-header" });
		const hunkLeft = hunkHeader.createDiv({ cls: "mae-dm-hunk-header-left" });
		hunkLeft.createSpan({ cls: "mae-dm-hunk-pos", text: hunk.header });
		hunkLeft.createSpan({ cls: "mae-dm-hunk-ctx", text: hunk.context });

		const hunkActions = hunkHeader.createDiv({ cls: "mae-dm-hunk-actions" });

		const acceptHunkBtn = hunkActions.createEl("button", { cls: "mae-dm-hunk-btn accept" });
		acceptHunkBtn.innerHTML = `<span class="mae-dm-hunk-btn-icon"></span> Accept`;
		setIcon(acceptHunkBtn.querySelector(".mae-dm-hunk-btn-icon")!, "check");
		const rejectHunkBtn = hunkActions.createEl("button", { cls: "mae-dm-hunk-btn reject" });
		rejectHunkBtn.innerHTML = `<span class="mae-dm-hunk-btn-icon"></span> Reject`;
		setIcon(rejectHunkBtn.querySelector(".mae-dm-hunk-btn-icon")!, "x");

		// Wire hunk-level accept/reject
		acceptHunkBtn.onclick = () => {
			hunk.changeIndices.forEach(i => this.acceptMap.set(i, true));
			rows.forEach((row, i) => {
				const b = hunk.blocks[i];
				if (b.type !== "unchanged") {
					row.removeClass("mae-dm-line-rejected");
					row.addClass("mae-dm-line-accepted");
				}
			});
			acceptHunkBtn.addClass("active");
			rejectHunkBtn.removeClass("active");
		};
		rejectHunkBtn.onclick = () => {
			hunk.changeIndices.forEach(i => this.acceptMap.set(i, false));
			rows.forEach((row, i) => {
				const b = hunk.blocks[i];
				if (b.type !== "unchanged") {
					row.removeClass("mae-dm-line-accepted");
					row.addClass("mae-dm-line-rejected");
				}
			});
			rejectHunkBtn.addClass("active");
			acceptHunkBtn.removeClass("active");
		};

		// Default: all accepted
		acceptHunkBtn.addClass("active");

		// Diff lines
		const linesWrap = wrap.createDiv({ cls: "mae-dm-lines" });
		const rows: HTMLElement[] = [];

		for (const block of hunk.blocks) {
			const row = linesWrap.createDiv({
				cls: "mae-dm-line mae-dm-line-" + block.type,
			});
			rows.push(row);

			if (block.type !== "unchanged") row.addClass("mae-dm-line-accepted");

			// Line number
			const lineNum = row.createSpan({ cls: "mae-dm-linenum" });
			const n = block.type === "removed" ? block.oldLineNumber
				: block.type === "added" ? block.newLineNumber
				: (block.oldLineNumber ?? "");
			lineNum.setText(String(n ?? ""));

			// Prefix
			const prefix = row.createSpan({ cls: "mae-dm-prefix" });
			prefix.setText(block.type === "added" ? "+" : block.type === "removed" ? "-" : " ");

			// Content
			row.createSpan({ cls: "mae-dm-text", text: block.content });
		}
	}
}
