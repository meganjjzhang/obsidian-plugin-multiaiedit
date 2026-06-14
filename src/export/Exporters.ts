import { App, Notice, TFile } from "obsidian";
import { Annotation, AnnotationFile } from "../annotation/AnnotationModel";

/** Rough token estimate: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKEN_WARN = 100_000;

export interface ExportOptions {
  includeReadingNotes: boolean; // §4.5: default false
  exportDir: string; // e.g. ".multiaiedit/exports"
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
  originalText?: string,
): string {
  const reviews = data.annotations.filter((a) => a.type === "review");
  const notes = data.annotations.filter((a) => a.type === "note");

  const dateStr = new Date().toISOString().slice(0, 10);
  let md = `# AI 批阅指令 — ${fileName}\n\n`;
  md += `- 原文件: [[${stripMd(filePath)}]]\n`;
  md += `- 导出时间: ${dateStr}\n`;
  md += `- 批阅数量: ${reviews.length}\n`;
  md += `- 附带阅读笔记: ${opts.includeReadingNotes ? "是" : "否"}\n\n`;
  md += "---\n\n";

  if (reviews.length === 0) {
    md += "## 批阅意见\n\n（无）\n";
  } else {
    md += "## 批阅意见\n\n";
    reviews.forEach((ann, i) => {
      const title = ann.strike ? "删除线" : "批阅";
      md += `### ${i + 1}. ${title}\n`;
      md += "原文：\n";
      md += `> ${escQuote(ann.selectedText)}\n\n`;
      md += "上下文：\n";
      md += `> 前：${escQuote(ann.contextBefore)}\n`;
      md += `> 后：${escQuote(ann.contextAfter)}\n\n`;
      md += "意见：\n";
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

  // Include the full original text so the exported file is self-contained
  // and AI tools can execute modifications without needing the source vault.
  if (originalText) {
    md += "## 原文\n\n";
    md += "```markdown\n" + originalText + "\n```\n\n";
    md += "---\n\n";
  }

  md += "## 执行要求\n";
  md += "1. 根据每条批阅意见修改原文。\n";
  md += "2. 不要修改未被批阅覆盖的内容，除非为保持上下文连贯而必要。\n";
  md += "3. 删除线表示强删除/合并意图，但最终请结合上下文判断。\n";
  md += "4. 输出完整修改后的 Markdown 文档。\n";

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

  let prompt = `请根据下方"批阅意见"修改文档《${fileName}》。\n\n`;
  prompt += "执行要求：\n";
  prompt += "1. 根据每条批阅意见修改原文。\n";
  prompt += "2. 不要修改未被批阅覆盖的内容，除非为保持上下文连贯而必要。\n";
  prompt += "3. 删除线 (strike: true) 表示强删除/合并意图，最终请结合上下文判断。\n";
  prompt += "4. 输出完整修改后的 Markdown 文档。\n\n";

  prompt += "## 原文路径\n\n";
  prompt += `${filePathAbsolute}\n\n`;

  prompt += "## 批阅意见\n\n";
  if (reviews.length === 0) {
    prompt += "（无）\n";
  } else {
    reviews.forEach((ann, i) => {
      prompt += `### ${i + 1}. ${ann.strike ? "删除线" : "批阅"}\n`;
      prompt += `原文："${escQuote(ann.selectedText)}"\n`;
      prompt += `上下文（前）：${escQuote(ann.contextBefore)}\n`;
      prompt += `上下文（后）：${escQuote(ann.contextAfter)}\n`;
      const text = ann.reviewText
        ? ann.reviewText
        : ann.strike
        ? "请删除或与相邻段落合并。"
        : "（无文本）";
      prompt += `意见：${text}\n\n`;
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
      new Notice("找不到原文件");
      return null;
    }
    const fileName = file.basename;
    const originalText = await this.app.vault.read(file);
    const md = buildReviewMarkdown(fileName, filePath, data, opts, originalText);

    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.exportDir))) {
      await adapter.mkdir(this.exportDir);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = `${this.exportDir}/${fileName}-${stamp}.md`;
    await adapter.write(target, md);
    const tokens = estimateTokens(md);
    if (tokens > TOKEN_WARN) {
      new Notice(`已导出 ${target}（约 ${tokens} tokens，建议分段处理）`);
    } else {
      new Notice(`已导出 ${target}（约 ${tokens} tokens）`);
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
      new Notice("找不到原文件");
      return;
    }
    const fileName = file.basename;
    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath
      ?? this.app.vault.getRoot().path;
    const filePathAbsolute = `${vaultPath}/${filePath}`;
    const prompt = buildPromptText(fileName, filePathAbsolute, data, opts);
    await copyToClipboard(prompt);
    const tokens = estimateTokens(prompt);
    new Notice(`Prompt 已复制（约 ${tokens} tokens${tokens > TOKEN_WARN ? "，建议分段" : ""}）`);
  }
}

/** Cross-platform clipboard copy. Falls back from navigator.clipboard to
 *  execCommand for mobile / non-secure contexts. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for mobile or non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
