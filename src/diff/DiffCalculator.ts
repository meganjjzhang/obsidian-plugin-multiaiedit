import * as Diff from "diff";

export interface DiffBlock {
	index: number;
	type: "added" | "removed" | "unchanged";
	content: string;
	oldLineNumber?: number; // for removed/unchanged lines
	newLineNumber?: number; // for added/unchanged lines
}

/**
 * Compute a line-level diff between original and modified text.
 * Returns structured blocks suitable for rendering in DiffModal.
 */
export function computeDiff(original: string, modified: string): DiffBlock[] {
	const changes = Diff.diffLines(original, modified);
	const blocks: DiffBlock[] = [];
	let oldLine = 1;
	let newLine = 1;
	let index = 0;

	for (const change of changes) {
		const lines = (change.value || "").split("\n");
		// Remove the trailing empty string if the value ends with \n
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		if (change.added) {
			for (const line of lines) {
				blocks.push({
					index,
					type: "added",
					content: line,
					newLineNumber: newLine++,
				});
				index++;
			}
		} else if (change.removed) {
			for (const line of lines) {
				blocks.push({
					index,
					type: "removed",
					content: line,
					oldLineNumber: oldLine++,
				});
				index++;
			}
		} else {
			for (const line of lines) {
				blocks.push({
					index,
					type: "unchanged",
					content: line,
					oldLineNumber: oldLine++,
					newLineNumber: newLine++,
				});
				index++;
			}
		}
	}

	return blocks;
}

/**
 * Count how many changed lines are in the diff.
 */
export function countChangedLines(blocks: DiffBlock[]): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const b of blocks) {
		if (b.type === "added") added++;
		if (b.type === "removed") removed++;
	}
	return { added, removed };
}

/**
 * Merge the diff back into the final text by applying accepted changes.
 * `acceptMap` maps change index → boolean (true = accept, false = reject).
 * For removed lines, accept = remove them. For added lines, accept = keep them.
 */
export function applyPartialDiff(
	original: string,
	blocks: DiffBlock[],
	acceptMap: Map<number, boolean>,
): string {
	// Group blocks into hunks: a removed section followed by an added section
	// forms a single hunk. For each hunk, apply accepted changes.
	const _changes = Diff.diffLines(original, "");
	// Actually, let's use a simpler approach: rebuild from blocks

	const result: string[] = [];
	for (const block of blocks) {
		const accepted = acceptMap.get(block.index);
		switch (block.type) {
			case "unchanged":
				result.push(block.content);
				break;
			case "removed":
				// If accepted → remove (skip). If rejected → keep.
				if (accepted === true) {
					// Remove: don't push
				} else {
					result.push(block.content);
				}
				break;
			case "added":
				// If accepted → keep. If rejected → skip.
				if (accepted !== false) {
					result.push(block.content);
				}
				break;
		}
	}
	return result.join("\n") + "\n";
}

/**
 * Full acceptance: return the modified text directly.
 */
export function acceptAll(original: string, modified: string): string {
	return modified;
}

/**
 * Full rejection: return the original text.
 */
export function rejectAll(original: string): string {
	return original;
}
