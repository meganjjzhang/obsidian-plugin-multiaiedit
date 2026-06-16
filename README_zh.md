# Promptuary

<p align="center">
  <img src="img/logo.gif" width="128" height="128" alt="Promptuary Logo">
</p>

> Obsidian 阅读标注与 AI 批量批阅插件。阅读时高亮记笔记，批阅时留下修改意见，多条意见一键交给外部 AI 执行修改。

[English](README.md)

---

## 目标人群与场景

**谁在用**

- **产品经理 / 编辑 / 写作者**：批阅产品文档、方案、周报，需要大量微调但不想逐条手改
- **研究者**：阅读论文 / 报告时标记重点、补充想法
- **团队负责人**：审阅下属文档时给出修改意见
- **开发者**：审阅技术文档、README、PRD，与 CLI Agent 用户高度重叠

**解决什么问题**

在 Obsidian 里阅读和批阅文档时，想法和修改意见分散在脑中或聊天窗口里，难以低成本记录、汇总并交给 AI 批量执行。现有高亮 / 笔记插件停在"标注记录"，没有打通**阅读标注 → 批阅意见 → 外部 AI 修改**的链路。

---

## 主要功能

### 阅读模式

- **4 色高亮**：选中文本后单击颜色，即刻标注，不污染原文（存储于 sidecar JSON）
- **阅读笔记**：选中文本后点击 Note 展开输入区，快速添加文字笔记，与原文绑定

### 批阅模式

- **删除线（Delete）**：一键标记"强删除/合并"意图，选中即生效
- **自然语言批阅意见**：点击 Note 展开输入区，直接写"改得更口语化""这里补一个案例"，不强迫分类
- **侧边栏批阅列表**：所有意见汇总，支持跳转、编辑、删除

### 浮窗交互

选中文本后弹出浮窗，纵向三段式布局：

1. **模式胶囊**：顶部 [阅读] / [批阅] 快速切换
2. **按钮行**：阅读模式 → 4 色高亮 + Note；批阅模式 → Delete + Note
3. **Note 展开区**：点击 Note 后向下展开，含颜色标记 + 标签 + 输入框 + Save

### AI 执行方式（四条路径）

| 路径 | 优先级 | 平台 | 说明 |
|------|--------|------|------|
| 导出批阅文件 | P0 | 全平台 | 生成 Markdown 指令文件，可上传给任意 AI |
| 复制 Prompt | P0 | 全平台 | 原文 + 批阅意见一键复制到剪贴板 |
| CLI 一键执行 | P1 | 桌面端 | 调用 Claude Code / Codex / Aider / Gemini CLI 等，自动唤起终端 |
| API Key 直调 | P2 | 桌面端 | BYOK 直连 Anthropic / OpenAI / DeepSeek / Gemini / 自定义端点，插件内闭环 |

### Diff 确认与自动重锚（桌面端）

AI 或 API 修改文件后，插件自动比对差异，提供**全部接受 / 逐块接受 / 回滚**。

确认后自动重锚批注位置：
1. **方案 B（Diff 回锚）**：基于 LCS diff 计算旧偏移 → 新偏移映射，精准更新
2. **方案 A（模糊定位兜底）**：编辑距离 + trigram 相似度滑动窗口，自动修复漂移批注
3. 已执行的批阅意见自动移除，失效阅读批注自动清理

---

## 使用方式

### 1. 安装

> 当前为开发版，尚未上架 Obsidian 社区插件市场。

**手动安装：**

```bash
git clone https://github.com/your-repo/obsidian-promptuary
cd obsidian-promptuary
npm install
npm run build
```

将 `main.js`、`manifest.json`、`styles.css` 复制到 Vault 的 `.obsidian/plugins/promptuary/` 目录，重启 Obsidian 后在「设置 → 第三方插件」中启用。

---

### 2. 阅读标注

1. 打开任意 Markdown 文件
2. 点击左侧 Ribbon 高亮笔图标或命令面板搜索「打开 Promptuary 侧边栏」
3. 选择顶部胶囊 **「阅读」**
4. 选中文本 → 浮层出现模式胶囊 + 颜色按钮 → 单击颜色完成高亮
5. 点击 **Note** 展开输入区，添加文字说明后点 Save

---

### 3. 批阅文档

1. 切换浮窗或侧边栏顶部胶囊到 **「批阅」**
2. 选中要修改的文本
3. 点击 **Delete** 切换删除线（再次点击可取消），或点击 **Note** 展开输入区写修改意见
4. 所有意见汇总在侧边栏批阅列表

---

### 4. 导出给 AI 执行

**方式 A：导出文件 / 复制 Prompt（全平台）**

点击侧边栏底部「导出批阅文件」或「复制 Prompt」，将生成的 Markdown 指令文件上传给 ChatGPT、Claude Web 等任意 AI 工具。

**方式 B：CLI 一键执行（桌面端）**

需先安装任意一款 Agent CLI：

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code
npm i -g @openai/codex               # Codex CLI
pip install aider-chat               # Aider
npm i -g @google/gemini-cli          # Gemini CLI
```

在侧边栏底部点击 Agent 按钮 → 选择已安装的 Agent → 确认命令 → 终端自动执行 → 执行完成后自动弹出 Diff 预览。

未安装的 Agent 按钮灰显，点击后复制命令到剪贴板手动执行。

**方式 C：API Key 直调（桌面端）**

无需安装任何 CLI 工具，在插件内直接调用模型 API。

1. 打开「设置 → API 直调」
2. 选择 Provider（Anthropic / OpenAI / DeepSeek / Gemini / 自定义端点）
3. 填写 API Key 和模型名
4. 点击「测试」验证连接
5. 在命令面板（`Cmd+P`）搜索「**API Key 直调执行**」或使用侧边栏按钮
6. 确认隐私提示 → 插件调用 API → 自动弹出 Diff 预览

---

### 5. Diff 预览与确认

AI 执行修改后，插件展示逐行差异：

- **全部接受**：保留所有 AI 修改
- **逐块接受**：勾选想保留的修改片段
- **回滚**：恢复原文，所有修改丢弃

确认后自动重锚批注，已执行的批阅意见自动移除。

---

## 设置项

### 基础设置

| 设置 | 说明 | 默认值 |
|------|------|--------|
| 默认模式 | 侧边栏初始状态（阅读/批阅/全部） | 阅读 |
| 上下文长度 | 批注前后保存的字符数，用于锚点定位 | 50 |
| Sidecar 目录 | 批注 JSON 存储位置 | `.promptuary/annotations` |
| 导出目录 | 批阅文件保存位置 | `.promptuary/exports` |
| 导出时附带阅读笔记 | 将阅读笔记作为参考上下文一并导出 | 否 |

### Agent 与终端（桌面端）

| 设置 | 说明 | 默认值 |
|------|------|--------|
| 终端应用 | macOS CLI 执行使用的终端 | Terminal |
| 自定义命令规则 | 用户自定义 Agent CLI 命令模板 | — |

预设 Agent（4 个）：

| Agent | 检测命令 | 安装方式 |
|-------|---------|---------|
| Claude Code | `which claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `which codex` | `npm i -g @openai/codex` |
| Aider | `which aider` | `pip install aider-chat` |
| Gemini CLI | `which gemini` | `npm i -g @google/gemini-cli` |

可用模板变量：`{{vaultPath}}` `{{instructionFile}}` `{{filePath}}` `{{fileName}}` `{{prompt}}`

### API 直调（桌面端）

| 设置 | 说明 | 默认值 |
|------|------|--------|
| Provider | Anthropic / OpenAI / DeepSeek / Gemini / 自定义 | Anthropic |
| API Key | 仅保存在本地，不上传 | — |
| 模型 | 留空使用默认值 | 按 Provider 不同 |
| 自定义端点 URL | OpenAI 兼容格式（仅自定义模式） | — |
| 最大输出 Token | API 调用的最大返回 Token 数 | 4096 |
| 测试连接 | 发送最小请求验证 API Key 是否有效 | — |

---

## 支持的 AI 工具

| AI 工具 | 接入方式 |
|---------|----------|
| Claude Code | CLI 一键执行 |
| Codex CLI | CLI 一键执行 |
| Aider | CLI 一键执行 |
| Gemini CLI | CLI 一键执行 |
| 自定义 Agent CLI | CLI 一键执行 |
| Anthropic API | API Key 直调 |
| OpenAI API | API Key 直调 |
| DeepSeek API | API Key 直调 |
| Google Gemini API | API Key 直调 |
| 自定义 OpenAI 兼容端点 | API Key 直调 |
| ChatGPT Web / Claude Web | 导出文件 / 复制 Prompt |

---

## 平台支持

| 功能 | 桌面端 | 移动端 |
|------|--------|--------|
| 阅读高亮 / 笔记 | ✅ | ✅（底部工具栏） |
| 批阅意见 | ✅ | ✅（底部工具栏） |
| 侧边栏 | ✅ | ✅ |
| 导出批阅文件 | ✅ | ✅ |
| 复制 Prompt | ✅ | ✅ |
| CLI 一键执行 | ✅（macOS 完整，Win/Linux 复制命令） | ❌ |
| API Key 直调 | ✅ | ❌ |
| Diff 预览与确认 | ✅ | ❌ |
| 自动重锚 | ✅ | ❌ |

> 移动端使用底部工具栏（BottomToolbar）替代桌面端浮窗，避开 iOS/Android 系统选区菜单冲突。

---

## 数据存储

批注以 **sidecar JSON** 格式存储在 `.promptuary/annotations/` 目录下，不修改原始 Markdown 文件。

```
vault/
├── .promptuary/
│   ├── annotations/    # 批注数据（每个文件一个 JSON）
│   └── exports/         # 导出的批阅指令文件
├── 你的文档.md         # 原文不被修改
```

批注 JSON 结构（AnnotationFile）：

```json
{
  "version": 1,
  "filePath": "path/to/doc.md",
  "baselineHash": "sha256...",
  "annotations": [
    {
      "id": "ann_xxx",
      "type": "highlight | note | review",
      "selectedText": "选中的文本",
      "contextBefore": "...",
      "contextAfter": "...",
      "lineHint": 5,
      "occurrenceIndex": 0,
      "highlightColor": "yellow | blue | green | purple",
      "noteText": "阅读笔记内容",
      "reviewText": "批阅意见内容",
      "strike": false
    }
  ]
}
```

API Key 仅保存在 Obsidian 本地插件数据（`this.saveData()`），不上传，不经过任何代理。

---

## 锚点定位机制

批注不存储偏移量（from/to），加载时通过文本搜索动态计算：

1. **精确匹配**：`selectedText` 在文档中唯一 → 直接定位
2. **occurrenceIndex + lineHint 消歧**：重复段落用出现序号 + 行号提示
3. **模糊定位（fuzzyLocate）**：编辑距离 + trigram 相似度滑动窗口
4. **漂移检测**：`baselineHash` 比对，文档变更后自动提醒
5. **自动修复**：Agent Diff 确认后自动重锚（方案 B + 方案 A 兜底）

---

## 版本路线

| 版本 | 状态 | 主要功能 |
|------|------|----------|
| v0.1 | ✅ 完成 | 阅读高亮、批阅意见、导出文件、复制 Prompt |
| v0.2 | ✅ 完成 | CLI 一键执行、Diff 预览、自动重锚 |
| v0.3 | 规划中 | 全库标注视图、跨文件搜索、JSON 导出 |
| v0.4 | ✅ 完成 | API Key 直调（Anthropic / OpenAI / DeepSeek / Gemini / 自定义） |
| v0.5 | 规划中 | MCP Server、批注集合、从其他插件迁移 |

---

## 命令面板快捷命令

| 命令 | 说明 |
|------|------|
| 打开 Promptuary 侧边栏 | 打开右侧侧边栏 |
| 高亮（黄） | 快速黄色高亮选中文本 |
| 添加笔记 | 为选中文本添加阅读笔记 |
| 添加批阅意见 | 为选中文本添加批阅 |
| 导出批阅文件 | 导出当前文件的批阅意见 |
| 复制 Prompt | 一键复制到剪贴板 |
| 使用 Claude Code 执行 | CLI 一键执行 |
| 使用 Codex CLI 执行 | CLI 一键执行 |
| 使用 Aider 执行 | CLI 一键执行 |
| 使用 Gemini CLI 执行 | CLI 一键执行 |
| 复制 Agent 命令 | 复制命令到剪贴板 |
| API Key 直调执行 | 插件内直接调用模型 API |
