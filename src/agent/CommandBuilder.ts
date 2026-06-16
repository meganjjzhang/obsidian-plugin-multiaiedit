import { CommandRule } from "./CommandRuleStore";
import { shellEscape } from "../utils/shellescape";

export interface TemplateVars {
	/** Absolute path to the Obsidian vault root */
	vaultPath: string;
	/** Relative path to the generated instruction file (within vault) */
	instructionFile: string;
	/** Relative path of the current markdown file */
	filePath: string;
	/** Just the filename (with .md extension) */
	fileName: string;
	/** Inline prompt text (when no instruction file is generated) */
	prompt: string;
}

/**
 * Build a full command string from a CommandRule template + variable values.
 *
 * - Each `{{var}}` placeholder is replaced with the shellEscaped value.
 * - Template literal text has already been validated at save time
 *   (no shell control chars allowed).
 */
export function buildCommand(rule: CommandRule, vars: TemplateVars): string {
	let cmd = rule.template;
	for (const [key, value] of Object.entries(vars) as Array<[string, string]>) {
		const token = `{{${key}}}`;
		if (cmd.includes(token)) {
			cmd = cmd.split(token).join(shellEscape(value));
		}
	}
	return cmd;
}

/**
 * Check whether a template requires an instruction file (i.e. it
 * references {{instructionFile}}). If not, the CLI can be invoked
 * with an inline {{prompt}} instead.
 */
export function templateNeedsInstructionFile(rule: CommandRule): boolean {
	return rule.template.includes("{{instructionFile}}");
}
