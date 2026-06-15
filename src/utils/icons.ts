/**
 * Icon registry for Promptuary plugin.
 *
 * Uses Obsidian's built-in `addIcon` / `setIcon` with Lucide icons where possible,
 * and registers custom SVG icons for cases where Lucide doesn't have an exact match.
 */
import { addIcon, setIcon } from "obsidian";

// ── Custom SVG icons (Lucide doesn't cover these) ──

const SVG_HIGHLIGHTER = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`;

const SVG_CHECK_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-9.5 9.5L10 17"/></svg>`;

const SVG_DIFF = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="m8 6-3 3 3 3"/><path d="m16 6 3 3-3 3"/></svg>`;

const SVG_DIYA = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0v-3a1 1 0 0 0-1-1Z"/><path d="M12 8c-2.2 0-4 1.8-4 4v3c0 2.2 1.8 4 4 4s4-1.8 4-4v-3c0-2.2-1.8-4-4-4Z"/><path d="M12 2v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M2 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M19.07 4.93l-1.41 1.41"/><path d="M20 12h2"/><path d="M19.07 19.07l-1.41-1.41"/><path d="M12 18v2"/></svg>`;

/** Register all custom icons. Call once in plugin onload(). */
export function registerIcons(): void {
	addIcon("prm-highlighter", SVG_HIGHLIGHTER);
	addIcon("prm-check-check", SVG_CHECK_CHECK);
	addIcon("prm-diff", SVG_DIFF);
	addIcon("prm-diya", SVG_DIYA);
}

/** Set a Lucide or custom icon on an element. Wrapper for convenience. */
export function setIconOn(el: HTMLElement, iconName: string): void {
	setIcon(el, iconName);
}

/**
 * Create an inline icon span (for use inside text flows, e.g. status badges).
 * Returns an HTMLElement that can be appended anywhere.
 */
export function createIconSpan(
	parent: HTMLElement,
	iconName: string,
	cls?: string,
): HTMLElement {
	const span = parent.createSpan({ cls: `prm-icon ${cls ?? ""}`.trim() });
	setIcon(span, iconName);
	return span;
}

// ── Inline SVG snippets for CSS pseudo-elements ──
// These are encoded as data URIs in styles.css

/** SVG markup for pencil/note icon (replaces "✎" emoji) */
export const SVG_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`;

/** SVG markup for message-square icon (replaces "💬" emoji) */
export const SVG_MESSAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

/** SVG markup for file icon (replaces "📄" emoji) */
export const SVG_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;
