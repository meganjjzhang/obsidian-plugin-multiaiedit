import { App, Notice } from "obsidian";
import { isMobile } from "../utils/platform";
import { copyToClipboard } from "../export/Exporters";

export type TerminalApp = "Terminal" | "iTerm2";

export interface LaunchOptions {
	command: string;
	vaultPath: string;
	terminalApp: TerminalApp;
	/** Called when the command has been launched (macOS only) */
	onLaunched?: () => void;
	/** Called when the command was copied instead of launched (fallback) */
	onCopied?: () => void;
}

/**
 * Launch a command in the system terminal (macOS) or copy it to
 * clipboard as a fallback (Windows / Linux / mobile).
 */
export function launchInTerminal(opts: LaunchOptions): void {
	if (isMobile()) {
		copyToClipboard(opts.command);
		new Notice("命令已复制到剪贴板");
		opts.onCopied?.();
		return;
	}

	// Lazy-import to avoid bundling child_process on mobile
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { execSync } = require("child_process") as typeof import("child_process");

	// Detect platform
	const isMac = process.platform === "darwin";
	const isWindows = process.platform === "win32";

	if (isMac) {
		launchMacOS(opts);
	} else if (isWindows) {
		// Windows: just copy the command
		copyToClipboard(opts.command);
		new Notice("命令已复制到剪贴板（Windows 暂不支持一键执行）");
		opts.onCopied?.();
	} else {
		// Linux: just copy the command
		copyToClipboard(opts.command);
		new Notice("命令已复制到剪贴板（Linux 暂不支持一键执行）");
		opts.onCopied?.();
	}
}

function launchMacOS(opts: LaunchOptions): void {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { execSync } = require("child_process") as typeof import("child_process");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require("fs") as typeof import("fs");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const os = require("os") as typeof import("os");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const nodePath = require("path") as typeof import("path");

	// Write the command to a temp shell script to avoid all AppleScript quoting issues.
	// The script path is safe ASCII — no special chars to escape.
	const tmpScript = nodePath.join(os.tmpdir(), `mae-agent-${Date.now()}.sh`);
	fs.writeFileSync(tmpScript, `#!/bin/bash\n${opts.command}\n`, { mode: 0o755 });

	// Schedule cleanup after 60 s (well after execution starts)
	setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch { /* ignore */ } }, 60_000);

	let appleScript: string;

	if (opts.terminalApp === "iTerm2") {
		appleScript = `tell application "iTerm"\nactivate\ncreate window with default profile command "${tmpScript}"\nend tell`;
	} else {
		appleScript = `tell application "Terminal"\ndo script "${tmpScript}"\nactivate\nend tell`;
	}

	try {
		execSync(`osascript -e '${appleScript}'`, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: "pipe",
		});
		new Notice(`已通过 ${opts.terminalApp} 执行命令`);
		opts.onLaunched?.();
	} catch (err) {
		copyToClipboard(opts.command);
		new Notice("终端启动失败，命令已复制到剪贴板");
		opts.onCopied?.();
	}
}

// ---------- file change monitor ----------

export type ChangeStatus = "idle" | "running" | "detected" | "timeout";

export class FileChangeMonitor {
	private status: ChangeStatus = "idle";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private resolve: ((detected: boolean) => void) | null = null;
	private watchedAbsPath: string | null = null;

	/**
	 * Start monitoring a file for changes made by an external process.
	 *
	 * Uses fs.watchFile (stat polling every 1 s) instead of vault.on("modify")
	 * because vault events are only fired for writes Obsidian itself initiates —
	 * external CLI Agents write directly to disk and vault events are unreliable.
	 *
	 * Resolves `true` when mtime changes, `false` on timeout.
	 */
	startMonitor(
		app: App,
		filePath: string,
		timeoutMs = 5 * 60 * 1000,
	): Promise<boolean> {
		this.status = "running";

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as typeof import("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const nodePath = require("path") as typeof import("path");

		const vaultPath = (app.vault.adapter as unknown as { basePath?: string }).basePath ?? "";
		const absPath = nodePath.join(vaultPath, filePath);
		this.watchedAbsPath = absPath;

		return new Promise<boolean>((resolve) => {
			this.resolve = resolve;

			// Timeout guard
			this.timer = setTimeout(() => {
				this.cleanup();
				this.status = "timeout";
				resolve(false);
			}, timeoutMs);

			// Poll every 1 s using fs.watchFile
			const listener = (curr: import("fs").Stats, prev: import("fs").Stats) => {
				if (curr.mtimeMs !== prev.mtimeMs && this.status === "running") {
					this.cleanup();
					this.status = "detected";
					resolve(true);
				}
			};

			fs.watchFile(absPath, { persistent: false, interval: 1000 }, listener);

			// Override cleanup to also stop the watcher
			const origCleanup = this.cleanup.bind(this);
			this.cleanup = () => {
				origCleanup();
				try { fs.unwatchFile(absPath, listener); } catch { /* ignore */ }
			};
		});
	}

	/** Cancel an in-progress monitor */
	cancel(): void {
		if (this.status === "running") {
			this.cleanup();
			this.status = "idle";
			this.resolve?.(false);
		}
	}

	getStatus(): ChangeStatus {
		return this.status;
	}

	private cleanup = (): void => {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	};
}

