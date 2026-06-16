/**
 * FolderOpener — 在系统文件管理器中打开本地文件夹 / 定位文件
 *
 * 使用 child_process（已在 TerminalLauncher 中验证可用），
 * 而非 require('electron').shell（渲染进程不可用）。
 * 移动端：提示不支持
 */
import { App, Notice, FileSystemAdapter } from "obsidian";
import { isMobile } from "./platform";
import { t } from "../i18n/i18n";

// ---------- helpers ----------

/** 获取 vault 内相对路径对应的绝对路径 */
export function getAbsolutePath(app: App, relativePath: string): string | null {
	const adapter = app.vault.adapter as FileSystemAdapter;
	if (typeof adapter.getFullPath === "function") {
		return adapter.getFullPath(relativePath);
	}
	// Fallback: basePath + relative
	const basePath = (adapter as unknown as { basePath?: string }).basePath;
	if (basePath) {
		return `${basePath}/${relativePath}`;
	}
	return null;
}

/** 确保目录存在，返回其相对路径 */
export async function ensureDir(app: App, relDir: string): Promise<string> {
	if (!(await app.vault.adapter.exists(relDir))) {
		await app.vault.adapter.mkdir(relDir);
	}
	return relDir;
}

// ---------- public API ----------

export interface OpenResult {
	success: boolean;
	path: string;
	error?: string;
}

/**
 * 在系统文件管理器中定位并选中指定文件。
 *
 * macOS: `open -R` （等价于 shell.showItemInFolder）
 * Windows: `explorer /select,`
 * Linux: `xdg-open` 打开父目录
 */
export async function revealInFileManager(
	app: App,
	relPath: string,
): Promise<OpenResult> {
	if (isMobile()) {
		new Notice(t("folder.notice.mobileNotSupported"));
		return { success: false, path: "", error: "mobile" };
	}

	const absPath = getAbsolutePath(app, relPath);
	if (!absPath) {
		new Notice(t("folder.notice.cannotResolveFile"));
		return { success: false, path: relPath, error: "no-abs-path" };
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node.js builtin lazy import for desktop-only feature
		const { exec } = require("child_process") as {
			exec: (cmd: string, cb: (err: Error | null) => void) => void;
		};

		let cmd: string;
		if (process.platform === "darwin") {
			// macOS: open -R reveals & selects the file in Finder
			cmd = `open -R "${absPath}"`;
		} else if (process.platform === "win32") {
			// Windows: explorer /select opens Explorer and selects the file
			cmd = `explorer /select,"${absPath}"`;
		} else {
			// Linux: xdg-open the parent directory
			const parentDir = absPath.substring(0, absPath.lastIndexOf("/"));
			cmd = `xdg-open "${parentDir}"`;
		}

		await new Promise<void>((resolve, reject) => {
			exec(cmd, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return { success: true, path: absPath };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		new Notice(t("folder.notice.openFailed", { error: msg }));
		return { success: false, path: absPath, error: msg };
	}
}

/**
 * 在系统文件管理器中打开本地文件夹。
 *
 * macOS: `open`
 * Windows: `explorer`
 * Linux: `xdg-open`
 */
export async function openFolderInSystem(
	app: App,
	relDir: string,
	opts?: { ensureExists?: boolean },
): Promise<OpenResult> {
	if (isMobile()) {
		new Notice(t("folder.notice.mobileNotSupported"));
		return { success: false, path: "", error: "mobile" };
	}

	if (opts?.ensureExists) {
		await ensureDir(app, relDir);
	}

	const absPath = getAbsolutePath(app, relDir);
	if (!absPath) {
		new Notice(t("folder.notice.cannotResolveFolder"));
		return { success: false, path: relDir, error: "no-abs-path" };
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node.js builtin lazy import for desktop-only feature
		const { exec } = require("child_process") as {
			exec: (cmd: string, cb: (err: Error | null) => void) => void;
		};

		const cmd = process.platform === "win32"
			? `explorer "${absPath}"`
			: process.platform === "darwin"
				? `open "${absPath}"`
				: `xdg-open "${absPath}"`;

		await new Promise<void>((resolve, reject) => {
			exec(cmd, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return { success: true, path: absPath };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		new Notice(t("folder.notice.openFailed", { error: msg }));
		return { success: false, path: absPath, error: msg };
	}
}
