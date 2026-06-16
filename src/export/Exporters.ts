import { App, Notice, TFile } from "obsidian";
import { AnnotationFile } from "../annotation/AnnotationModel";
import { t } from "../i18n/i18n";

/** Rough token estimate: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKEN_WARN = 100_000;

export interface ExportOptions {
  includeReadingNotes: boolean; // §4.5: default false
  exportDir: string; // e.g. ".promptuary/exports"
}

/**
 * Build the Markdown body for an export. Pure function — does not write
 * the vault. Reused by both ReviewExporter and PromptExporter.
 */
export function buildReviewMarkdown(
  fileName: string,
  filePath: string,
  data: AnnotationFile,
  opts: { includeReadingNotes: boolean },
): string {
  const reviews = data.annotations.filter((a) => a.type === "review");
  const notes = data.annotations.filter((a) => a.type === "note");

  const dateStr = new Date().toISOString().slice(0, 10);
  let md = `# ${t("export.reviewTitle")} — ${fileName}\n\n`;
  md += `- ${t("export.originalFile")}: [[${stripMd(filePath)}]]\n`;
  md += `- ${t("export.exportTime")}: ${dateStr}\n`;
  md += `- ${t("export.reviewCount")}: ${reviews.length}\n`;
  md += `- ${t("export.includeReading")}: ${opts.includeReadingNotes ? t("common.yes") : t("common.no")}\n\n`;
  md += "---\n\n";

  if (reviews.length === 0) {
    md += `## ${t("export.reviewSection")}\n\n${t("export.none")}\n`;
  } else {
    md += `## ${t("export.reviewSection")}\n\n`;
    reviews.forEach((ann, i) => {
      const title = ann.strike ? t("export.strikethrough") : "批阅";
      md += `### ${i + 1}. ${title}\n`;
      md += `${t("export.original")}：\n`;
      md += `> ${escQuote(ann.selectedText)}\n\n`;
      md += `${t("export.context")}：\n`;
      md += `> 前：${escQuote(ann.contextBefore)}\n`;
      md += `> 后：${escQuote(ann.contextAfter)}\n\n`;
      md += `${t("export.opinion")}：\n`;
      const text = ann.reviewText
        ? ann.reviewText
        : ann.strike
        ? "用户标记为删除线。请判断是否删除或合并。"
        : "（无文本）";
      md += `> ${escQuote(text)}\n\n`;
    });
  }

  if (opts.includeReadingNotes && notes.length > 0) {
    md += "---\n\n## 阅读笔记（参考上下文）\n\n";
    notes.forEach((ann, i) => {
      md += `### ${i + 1}. 笔记\n`;
      md += `> ${escQuote(ann.selectedText)}\n\n`;
      md += `${escQuote(ann.noteText ?? "")}\n\n`;
    });
  }

  md += "---\n\n";

  md += `## ${t("export.execRequirement")}\n`;
  md += t("export.execRequirementText") + "\n";

  return md;
}

/**
 * Build the prompt body that references the original file by absolute path
 * instead of embedding the full text. This keeps the prompt short and lets
 * the AI tool read the file directly.
 */
export function buildPromptText(
  fileName: string,
  filePathAbsolute: string,
  data: AnnotationFile,
  opts: { includeReadingNotes: boolean },
): string {
  const reviews = data.annotations.filter((a) => a.type === "review");
  const notes = data.annotations.filter((a) => a.type === "note");

  let prompt = `${t("export.promptHeader")}《${fileName}》\n\n`;
  prompt += `${t("export.execRequirement")}：\n`;
  prompt += t("export.execRequirementText") + "\n\n";

  prompt += `## ${t("export.originalFile")}\n\n`;
  prompt += `${filePathAbsolute}\n\n`;

  prompt += `## ${t("export.promptReviews")}\n\n`;
  if (reviews.length === 0) {
    prompt += `${t("export.none")}\n`;
  } else {
    reviews.forEach((ann, i) => {
      prompt += `### ${i + 1}. ${ann.strike ? t("export.strikethrough") : "批阅"}\n`;
      prompt += `${t("export.original")}："${escQuote(ann.selectedText)}"\n`;
      prompt += `${t("export.context")}（前）：${escQuote(ann.contextBefore)}\n`;
      prompt += `${t("export.context")}（后）：${escQuote(ann.contextAfter)}\n`;
      const text = ann.reviewText
        ? ann.reviewText
        : ann.strike
        ? "请删除或与相邻段落合并。"
        : "（无文本）";
      prompt += `${t("export.opinion")}：${text}\n\n`;
    });
  }

  if (opts.includeReadingNotes && notes.length > 0) {
    prompt += "## 阅读笔记（参考）\n\n";
    notes.forEach((ann, i) => {
      prompt += `### ${i + 1}.\n`;
      prompt += `原文："${escQuote(ann.selectedText)}"\n`;
      prompt += `笔记：${escQuote(ann.noteText ?? "")}\n\n`;
    });
  }

  return prompt;
}

function stripMd(p: string): string {
  return p.replace(/\.md$/i, "");
}

function escQuote(s: string): string {
  return s.replace(/\n/g, " ").trim();
}

export class ReviewExporter {
  private get exportDir(): string {
    return this.getExportDir();
  }
  constructor(private app: App, private getExportDir: () => string) {}

  async exportToVault(
    filePath: string,
    data: AnnotationFile,
    opts: { includeReadingNotes: boolean },
  ): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(t("export.notice.fileNotFound"));
      return null;
    }
    const fileName = file.basename;
    const md = buildReviewMarkdown(fileName, filePath, data, opts);

    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.exportDir))) {
      await adapter.mkdir(this.exportDir);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = `${this.exportDir}/${fileName}-${stamp}.md`;
    // Use adapter.write() instead of vault.create() — hidden dirs (.promptuary)
    // are not indexed by Vault, so vault.create() returns null.
    await adapter.write(target, md);
    const tokens = estimateTokens(md);
    if (tokens > TOKEN_WARN) {
      new Notice(t("export.notice.exportedTokens", { n: tokens }));
    } else {
      new Notice(t("export.notice.exportedTokens", { n: tokens }));
    }
    return target;
  }
}

export class PromptExporter {
  constructor(private app: App) {}

  async copyToClipboard(
    filePath: string,
    data: AnnotationFile,
    opts: { includeReadingNotes: boolean },
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(t("export.notice.fileNotFound"));
      return;
    }
    const fileName = file.basename;
    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath
      ?? this.app.vault.getRoot().path;
    const filePathAbsolute = `${vaultPath}/${filePath}`;
    const prompt = buildPromptText(fileName, filePathAbsolute, data, opts);
    await copyToClipboard(prompt);
    const tokens = estimateTokens(prompt);
    new Notice(t("export.notice.promptCopied", { n: tokens }));
  }
}

/** Cross-platform clipboard copy using navigator.clipboard API. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Use navigator.clipboard API instead of deprecated execCommand
    await navigator.clipboard.writeText(text);
  }
}
