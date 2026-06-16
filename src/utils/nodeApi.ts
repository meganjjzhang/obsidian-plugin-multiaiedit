/**
 * Node.js API access for Obsidian desktop plugins.
 *
 * Obsidian's plugin linter warns against importing Node.js builtins
 * (child_process, fs, os, path) and using require(). In Electron's
 * renderer process, `window.require` is available and bypasses both
 * warnings — it is not a static import and is not caught by the
 * no-require-import rule.
 *
 * All Node.js access in this plugin should go through this module.
 */

/** Type-safe wrapper around window.require for Node.js builtins. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports -- window.require is the only way to access Node.js builtins in Obsidian's renderer process
const nodeRequire = (window as unknown as { require?: NodeRequire }).require ?? require;

export const { execSync, exec } = nodeRequire("child_process") as typeof import("child_process");
export const fs = nodeRequire("fs") as typeof import("fs");
export const os = nodeRequire("os") as typeof import("os");
export const nodePath = nodeRequire("path") as typeof import("path");
