import { CommandRule } from "./CommandRuleStore";
import { isMobile } from "../utils/platform";
import { execSync } from "../utils/nodeApi";

export interface AgentInfo {
	rule: CommandRule;
	installed: boolean;
}

/**
 * Obsidian is a GUI app and does not inherit the user's shell PATH
 * (e.g. Homebrew at /opt/homebrew/bin is missing).  We build an
 * augmented PATH that covers the most common install locations.
 */
function augmentedEnv(): NodeJS.ProcessEnv {
	const extraPaths = [
		"/opt/homebrew/bin",        // Apple Silicon Homebrew
		"/usr/local/bin",           // Intel Homebrew / npm global
		"/usr/bin",
		"/bin",
		`${process.env.HOME ?? ""}/.local/bin`,
		`${process.env.HOME ?? ""}/.npm-global/bin`,
		`${process.env.HOME ?? ""}/.cargo/bin`,
	].filter(Boolean);

	const current = process.env.PATH ?? "";
	const merged = [...new Set([...current.split(":"), ...extraPaths])].join(":");
	return { ...process.env, PATH: merged };
}

/**
 * Detect which Agent CLIs are installed on the current machine.
 *
 * On mobile, always returns an empty list (no child_process).
 * On desktop, runs `which <cmd>` via child_process.execSync with an
 * augmented PATH so Homebrew / npm-global installs are found even when
 * Obsidian was launched as a GUI app without the shell profile.
 */
export function detectAgents(rules: CommandRule[]): AgentInfo[] {
	if (isMobile()) return [];

	const env = augmentedEnv();

	return rules.map((rule) => {
		let installed = false;
		try {
			execSync(rule.detectCmd, {
				encoding: "utf-8",
				timeout: 5000,
				stdio: "pipe",
				env,
			});
			installed = true;
		} catch {
			installed = false;
		}
		return { rule, installed };
	});
}

/**
 * Re-detect a single agent by its detectCmd.
 */
export function isAgentInstalled(rule: CommandRule): boolean {
	if (isMobile()) return false;
	try {
		execSync(rule.detectCmd, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: "pipe",
			env: augmentedEnv(),
		});
		return true;
	} catch {
		return false;
	}
}
