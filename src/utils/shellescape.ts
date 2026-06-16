/**
 * Shell escape utilities for safe command construction.
 *
 * Strategy: single-quote wrapping with internal single-quote escape.
 * All variable values inserted into command templates MUST pass through
 * shellEscape() to prevent injection.
 */
import { t } from "../i18n/i18n";

/**
 * Wrap a string in single quotes, escaping any embedded single quotes
 * using the standard `'\''` idiom.
 *
 * Example: "it's here" → "'it'\''s here'"
 */
export function shellEscape(str: string): string {
	return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Characters that are FORBIDDEN in the literal (non-variable) portion of a
 * command template.  If any of these appear outside a `{{var}}` placeholder,
 * the template is rejected at save time.
 */
const FORBIDDEN_SHELL_CHARS = /[|&;<>`$(){}]/;

/**
 * Validate a command template: after stripping all `{{var}}` placeholders,
 * the remaining literal text must not contain shell control characters.
 *
 * @throws Error describing the violation if validation fails.
 */
export function validateTemplate(tpl: string): void {
	const literal = tpl.replace(/\{\{[a-zA-Z]+\}\}/g, "");
	const match = literal.match(FORBIDDEN_SHELL_CHARS);
	if (match) {
		throw new Error(t("shell.error.forbiddenChar", { chars: match[0] }));
	}
}

/**
 * Allowed variable names that may appear in `{{…}}` placeholders.
 * Anything else is rejected.
 */
const ALLOWED_VARIABLES = new Set([
	"vaultPath",
	"instructionFile",
	"filePath",
	"fileName",
	"prompt",
]);

/**
 * Extract and validate all `{{var}}` references in a template.
 *
 * @returns Array of variable names found.
 * @throws Error if an unknown variable name is used.
 */
export function extractVariables(tpl: string): string[] {
	const re = /\{\{([a-zA-Z]+)\}\}/g;
	const vars: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(tpl)) !== null) {
		const name = m[1];
		if (!ALLOWED_VARIABLES.has(name)) {
			throw new Error(t("shell.error.unknownVariable", { var: name }));
		}
		if (!vars.includes(name)) vars.push(name);
	}
	return vars;
}
