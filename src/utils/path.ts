/**
 * Map a vault-relative file path to a human-readable sidecar path.
 *
 * The sidecar mirrors the original vault path structure:
 *   产品文档/需求分析.md  →  <rootDir>/产品文档/需求分析.md.json
 *   notes/todo.md         →  <rootDir>/notes/todo.md.json
 *
 * This replaces the previous base64url encoding scheme which produced
 * unreadable filenames. The path itself is the unique key, so collisions
 * are impossible.
 */
export function sidecarPath(rootDir: string, filePath: string): string {
	return `${rootDir}/${filePath}.json`;
}

/**
 * Ensure every segment of a vault path exists under `rootDir`.
 * Obsidian's `adapter.mkdir` only creates a single level, so we
 * walk each segment and create as needed.
 */
export async function ensureDir(
	adapter: { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void> },
	dir: string,
): Promise<void> {
	const parts = dir.split("/");
	let current = "";
	for (const part of parts) {
		if (!part) continue;
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}

/**
 * Remove empty ancestor directories under `rootDir` after a file
 * is moved or deleted. Stops at `rootDir` itself.
 */
export async function removeEmptyAncestors(
	adapter: { exists(path: string): Promise<boolean>; rmdir(path: string, recursive?: boolean): Promise<void> },
	rootDir: string,
	fileDir: string,
): Promise<void> {
	let dir = fileDir;
	while (dir && dir !== rootDir && dir.length > rootDir.length) {
		if (!(await adapter.exists(dir))) break;
		try {
			const children = await (adapter as unknown as {
				list(path: string): Promise<{ files: string[]; folders: string[] }>;
			}).list(dir);
			if (children.files.length === 0 && children.folders.length === 0) {
				await adapter.rmdir(dir);
			} else {
				break;
			}
		} catch {
			break;
		}
		// Move up one level
		const idx = dir.lastIndexOf("/");
		if (idx < 0) break;
		dir = dir.slice(0, idx);
	}
}
