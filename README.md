# MultiAIEdit

> Obsidian 阅读标注与 AI 批阅插件。阅读时高亮记笔记，批阅时留下修改意见，一键交给外部 AI 执行修改。

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
- **阅读笔记**：选中文本后快速添加文字笔记，与原文绑定

### 批阅模式

- **删除线**：一键标记"强删除/合并"意图
- **自然语言批阅意见**：直接写"改得更口语化""这里补一个案例"，不强迫分类
- **侧边栏批阅列表**：所有意见汇总，支持跳转、编辑、删除

### AI 执行方式（四条路径）

| 路径 | 优先级 | 平台 | 说明 |
|------|--------|------|------|
| 导出批阅文件 | P0 | 全平台 | 生成 Markdown 指令文件，可上传给任意 AI |
| 复制 Prompt | P0 | 全平台 | 原文 + 批阅意见一键复制到剪贴板 |
| CLI 一键执行 | P1 | 桌面端 | 调用 Claude Code / Codex / Aider / Gemini CLI，自动唤起终端 |
| Cursor 直调 | P1 | macOS | 打开 Cursor 并注入 `.cursorrules`，Cmd+I 即可执行 |
| API Key 直调 | P2 | 桌面端 | BYOK 直连 Anthropic / OpenAI / Gemini，插件内闭环 |

### Diff 确认（桌面端）

AI 或 API 修改文件后，插件自动比对差异，提供**全部接受 / 逐块接受 / 回滚**，避免 AI 改错无法撤销。

---

## 使用方式

### 1. 安装

> 当前为开发版，尚未上架 Obsidian 社区插件市场。

**手动安装：**

```bash
git clone https://github.com/your-repo/obsidian-plugin-multiaiedit
cd obsidian-plugin-multiaiedit
npm install
npm run build
```

将 `main.js`、`manifest.json`、`styles.css` 复制到 Vault 的 `.obsidian/plugins/multiaiedit/` 目录，重启 Obsidian 后在「设置 → 第三方插件」中启用。

---

### 2. 阅读标注

1. 打开任意 Markdown 文件
2. 点击右侧 MultiAIEdit 图标（高亮笔）打开侧边栏
3. 选择顶部胶囊 **「阅读」**
4. 选中文本 → 浮层出现颜色按钮 → 单击颜色完成高亮
5. 点击「笔记」可添加文字说明

---

### 3. 批阅文档

1. 切换侧边栏顶部胶囊到 **「批阅」**
2. 选中要修改的文本
3. 点击 **「S」删除线按钮** 表示强删除意图，或在输入框直接写修改意见
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

在侧边栏底部选择「CLI 执行」→ 选择已安装的 Agent → 确认命令 → 终端自动执行，执行完成后自动弹出 Diff 预览。

**方式 C：Cursor 直调（macOS）**

需安装 [Cursor](https://cursor.sh/)（检测 `/Applications/Cursor.app`）。

在侧边栏底部点击「Cursor 直调」→ 确认 → 插件自动向 `.cursorrules` 注入批阅任务 → Cursor 打开当前 Vault → 按 `Cmd+I` 唤起 Composer Agent 执行。

Diff 确认完成后，可在设置中开启「执行后自动清理 `.cursorrules`」。

**方式 D：API Key 直调（桌面端）**

无需安装任何 CLI 工具，在插件内直接调用模型 API。

1. 打开「设置 → API Key 直调（P2）」
2. 选择 Provider（Anthropic / OpenAI / Gemini / 自定义端点）
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

---

## 设置项

| 设置 | 说明 | 默认值 |
|------|------|--------|
| 默认模式 | 侧边栏初始状态（阅读/批阅/全部） | 阅读 |
| 上下文长度 | 批注前后保存的字符数，用于锚点定位 | 50 |
| Sidecar 目录 | 批注 JSON 存储位置 | `.multiaiedit/annotations` |
| 导出目录 | 批阅文件保存位置 | `.multiaiedit/exports` |
| 导出时附带阅读笔记 | 将阅读笔记作为参考上下文一并导出 | 否 |
| 终端应用 | macOS CLI 执行使用的终端 | Terminal |
| Cursor 注入模式 | 写入 `.cursorrules` 或仅复制提示 | 写入 `.cursorrules` |
| Cursor 执行后清理 | Diff 确认后自动删除注入片段 | 否 |
| API Provider | Anthropic / OpenAI / Gemini / 自定义 | Anthropic |
| API Key | 仅保存在本地，不上传 | — |
| 最大输出 Token | API 调用的最大返回 Token 数 | 4096 |

---

## 支持的 AI 工具

| AI 工具 | 接入方式 |
|---------|----------|
| Claude Code | CLI 一键执行 |
| Codex CLI | CLI 一键执行 |
| Aider | CLI 一键执行 |
| Gemini CLI | CLI 一键执行 |
| Cursor | Cursor 直调（macOS） |
| Anthropic API | API Key 直调 |
| OpenAI API | API Key 直调 |
| Google Gemini API | API Key 直调 |
| 自定义 OpenAI 兼容端点 | API Key 直调 |
| ChatGPT Web / Claude Web | 导出文件 / 复制 Prompt |

---

## 平台支持

| 功能 | 桌面端 | 移动端 |
|------|--------|--------|
| 阅读高亮 / 笔记 | ✅ | ✅ |
| 批阅意见 | ✅ | ✅ |
| 侧边栏 | ✅ | ✅ |
| 导出批阅文件 | ✅ | ✅ |
| 复制 Prompt | ✅ | ✅ |
| CLI 一键执行 | ✅（macOS 完整，Win/Linux 复制命令） | ❌ |
| Cursor 直调 | ✅（macOS） | ❌ |
| API Key 直调 | ✅ | ❌ |
| Diff 预览与确认 | ✅ | ❌ |

---

## 数据存储

批注以 **sidecar JSON** 格式存储在 `.multiaiedit/annotations/` 目录下，不修改原始 Markdown 文件。

```
vault/
├── .multiaiedit/
│   ├── annotations/    # 批注数据（每个文件一个 JSON）
│   ├── exports/        # 导出的批阅指令文件
│   └── config.json
├── 你的文档.md         # 原文不被修改
└── .cursorrules        # Cursor 直调时临时注入，可自动清理
```

API Key 仅保存在 Obsidian 本地插件数据（`this.saveData()`），不上传，不经过任何代理。

---

## 版本路线

| 版本 | 状态 | 主要功能 |
|------|------|----------|
| v0.1 | ✅ 完成 | 阅读高亮、批阅意见、导出、复制 Prompt |
| v0.2 | ✅ 完成 | CLI 一键执行、Diff 预览 |
| v0.3 | 规划中 | 全库标注视图、跨文件搜索、JSON 导出 |
| v0.4 | ✅ 完成 | Cursor 直调、API Key 直调（Anthropic / OpenAI / Gemini / 自定义） |
| v0.5 | 规划中 | MCP Server、批注集合、从其他插件迁移 |
