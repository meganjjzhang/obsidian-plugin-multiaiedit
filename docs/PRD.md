# MultiAIEdit — 产品设计方案（PRD）

> 版本：v0.5 | 日期：2026-06-14 | 作者：婧晶 + 檐灯

---

## 1. 产品定位

**一句话**：Obsidian 阅读标注与 AI 批阅插件——阅读时高亮/记笔记，批阅时快速留下修改意见，一键导出给外部 AI 或 Agent 执行修改。

**解决的问题**：用户在 Obsidian 阅读、批阅文档时，想法和修改意见分散在脑中或聊天窗口里，难以低成本记录、汇总并交给 AI 批量执行。现有高亮/笔记插件停在“标注记录”，没有打通“阅读标注 → 批阅意见 → 外部 AI 修改”的链路。

**核心差异**：MultiAIEdit 不做通用知识管理，也不自建 AI Agent，而是做**阅读标注到 AI 批阅执行的桥梁**。插件的核心壁垒是：

1. 阅读中低摩擦记录：高亮 + 笔记。
2. 批阅中低摩擦表达修改意图：删除线 + 自然语言批阅意见。
3. 将批阅意见结构化导出给外部 AI / Agent。
4. 桌面端提供 Agent 一键执行与 Diff 确认。

**设计原则**：
- 基础高亮和笔记是入口，不是终点；产品不做复杂标签、集合、复习、摘录库。
- 批阅时不强迫用户选择“修改/删除/补充/疑问”，让大模型根据自然语言意见判断具体操作。
- 插件只管采集、结构化、导出和验证，不造 LLM 的轮子。
- 优先利用用户已有 Agent 产品（Claude Code / Codex / Aider / Gemini CLI 等）。
- 移动端只做阅读标注、批阅记录、导出/复制；AI 执行和 Diff 确认仅桌面端。

---

## 2. 目标用户与场景

### 2.1 核心用户

- 产品经理/编辑/写作者：批阅产品文档、方案、周报时需要大量微调。
- 研究者：阅读论文/报告时标记重点、补充想法、后续整理。
- 团队负责人：审阅下属文档时给出修改意见。
- 开发者：审阅技术文档、README、PRD，与 CLI Agent 用户高度重叠。

### 2.2 核心场景

| 场景 | 当前痛点 | MultiAIEdit 解法 |
|------|---------|------------------|
| 阅读资料 | 重要内容想先标记，不想每次都写完整批注 | 阅读模式：选中文本后直接选高亮颜色，或快速记笔记 |
| 批阅产品文档 | 修改意见多，逐条手改容易遗漏 | 批阅模式：选中文本后写一句批阅意见，侧边栏统一汇总 |
| 删除/合并内容 | 想快速表达“这段不要了/重复了” | 批阅模式提供删除线按钮，形成强删除意图 |
| 外部 AI 执行 | 想把所有批阅意见一次性交给 Claude Code / ChatGPT | 导出批阅文件 / 复制 Prompt / 桌面端 CLI 一键执行 |
| 移动端阅读 | 手机上主要是阅读和记录，不适合执行修改 | 移动端保留阅读/批阅记录与导出，回到桌面执行 |

### 2.3 场景闭环分析

| 环节 | 桌面端 | 移动端 | 说明 |
|------|--------|--------|------|
| 阅读高亮 | 支持 | 支持 | 插件内完成 |
| 阅读笔记 | 支持 | 支持 | 插件内完成 |
| 批阅意见 | 支持 | 支持 | 删除线 + 文本框 |
| 侧边栏汇总 | 支持 | 支持 | 阅读 / 批阅 / 全部胶囊切换 |
| 导出批阅文件 | 支持 | 支持 | 默认导出批阅意见，可选附带阅读笔记 |
| 复制 Prompt | 支持 | 支持 | 插件内完成 |
| CLI 一键执行 | 支持 | 不支持 | 桌面端 Electron 可调用 child_process |
| Diff 预览 + 确认 | 支持 | 不支持 | 仅桌面端闭环 |
| API 直调 | 支持 | 可支持 | P2 兜底，低优先级 |

---

## 3. 核心链路

### 3.1 阅读链路

```text
选中文本 → 选择高亮颜色 / 添加笔记 → 侧边栏阅读列表 → 可选导出为参考上下文
```

阅读链路目标是提高使用频率，降低第一次使用门槛。

### 3.2 批阅链路

```text
切到批阅 → 选中文本 → 删除线 / 输入批阅意见 → 侧边栏批阅列表 → 导出/复制/Agent 执行 → Diff 确认
```

批阅链路目标是把自然语言意见转换为 AI 可执行的结构化输入。

### 3.3 AI 执行方式

实施优先级：

1. P0：导出批阅文件。
2. P0：复制 Prompt。
3. P1：CLI 一键执行，支持用户自定义命令规则。
4. P1：Cursor 直调，打开 Cursor 并注入批阅文件。
5. P2：API Key 直调模型，BYOK 低优先级兜底。

```text
批阅数据 sidecar
   ↓
Prompt / 批阅文件生成器
   ├─ 导出 Markdown / JSON
   ├─ 复制 Prompt
   ├─ CLI 一键执行：Claude Code / Codex / Aider / Gemini CLI / Cursor
   ├─ Cursor 直调：打开 Cursor 并注入批阅指令文件
   └─ API Key 直调：低优先级兜底，BYOK 直调模型 API
```

---

## 4. 核心交互设计

### 4.1 侧边栏胶囊模式

侧边栏顶部提供三个胶囊：

```text
[阅读] [批阅] [全部]
```

三种状态的定义：

| 胶囊 | 侧边栏展示 | 选中文本默认浮层 | 定位 |
|------|------------|------------------|------|
| 阅读 | 只看高亮和笔记 | 高亮颜色 + 笔记按钮 | 高频阅读记录 |
| 批阅 | 只看批阅意见 | 删除线按钮 + 批阅文本框 | AI 修改意图采集 |
| 全部 | 查看高亮、笔记、批阅 | 默认按阅读模式处理 | 全局查看，不是操作模式 |

关键规则：
- “全部”是查看筛选，不是第三种操作模式。
- 用户处于“全部”时，选中文本后的浮层默认使用阅读模式。
- 阅读/批阅不做权限隔离，只影响默认展示和默认操作。

### 4.2 阅读模式：选中文本后的浮层

阅读模式下，选中文本后直接展示预置高亮颜色与笔记入口。

```text
[黄] [蓝] [绿] [紫] [笔记]
```

交互规则：
- 点击颜色：立即创建高亮，不打开大弹窗。
- 点击"笔记"：打开轻量输入框，输入后创建 note。
- 高亮颜色固定为预置 4 色，MVP 不做自定义颜色。
- 不再提供"转为 AI 批注"按钮；用户通过顶部胶囊切换到"批阅"来进入批阅流程。

**平台差异（移动端降级）**：
iOS/Android 触屏选区会先弹出系统菜单(Copy/Paste/Share)遮挡浮层,移动端 v0.1 改为**底部工具栏方案**——选中文本后,Obsidian 移动端底部出现工具栏,内容随当前模式切换。详见 [technical-design.md](technical-design.md) §6.2。

| 平台 | 选中后入口形态 |
|------|---------------|
| 桌面端 | 选区上方浮层 |
| 移动端 | 屏幕底部工具栏 |

推荐颜色含义（仅作为默认说明，不强制）：

| 颜色 | 默认语义 |
|------|----------|
| 黄 | 重点 |
| 蓝 | 可引用 |
| 绿 | 灵感/补充 |
| 紫 | 待确认 |

### 4.3 批阅模式：选中文本后的浮层

批阅模式下，选中文本后只提供两个核心控件：

```text
[S 删除线]  [输入批阅意见……]
```

交互规则：
- 点击删除线按钮：对选中文本创建 `review`，并标记 `strike: true`。
- 输入批阅意见：创建 `review`，保存自然语言意见。
- 删除线和文本框可以同时使用。
- 不再区分 modify / delete / add / question，交给大模型根据文本判断用户意图。
- **移动端**：与 §4.2 相同,降级为底部工具栏,内容为 `[S 删除线]` + 批阅文本框。

示例：

| 用户操作 | 保存结果 | AI 理解 |
|----------|----------|---------|
| 只点删除线 | `strike: true` | 倾向删除该文本 |
| 输入“改得更口语化” | `reviewText` | 改写 |
| 输入“这里补一个案例” | `reviewText` | 补充 |
| 删除线 + “和上一段重复，可合并” | `strike + reviewText` | 删除或合并 |
| 输入“数据来源？” | `reviewText` | 疑问/需补充依据 |

### 4.4 侧边栏列表

#### 阅读列表

展示高亮和笔记。

```text
阅读
- 黄色高亮：面向0-3岁宝宝的家长
- 笔记：这个例子可以放到开头
- 蓝色高亮：留作后续引用
```

卡片字段：
- 类型：高亮 / 笔记
- 颜色：仅高亮显示
- 原文摘录
- 笔记内容（如有）
- 操作：跳转 / 编辑 / 删除

#### 批阅列表

展示所有 review。

```text
批阅
- 删除线：这段重复
- 批阅：改成“新生代妈妈”，更聚焦
- 批阅：这里补一个实际案例
```

卡片字段：
- 是否删除线
- 原文摘录
- 批阅意见
- 操作：跳转 / 编辑 / 删除

#### 全部列表

按文档位置或创建时间展示全部记录，卡片带类型标识。

### 4.5 导出批阅文件

默认只导出批阅列表；可选附带阅读笔记作为参考上下文。

导出 Markdown 示例：

```markdown
# AI 批阅指令 — 产品定位文档

- 原文件: [[产品定位文档]]
- 导出时间: 2026-06-11
- 批阅数量: 3
- 附带阅读笔记: 否

---

## 批阅意见

### 1. 批阅
原文：
> 面向0-3岁宝宝的家长

意见：
> 改成“新生代妈妈”，更聚焦

### 2. 删除线
原文：
> 帮助家庭记录宝宝的成长瞬间，留住每一个珍贵时刻。

意见：
> 用户标记为删除线。请判断是否删除或合并。

### 3. 批阅
原文：
> 覆盖80%的新生代家庭

意见：
> 数据来源不清楚，需要补充依据。

---

## 执行要求
1. 根据每条批阅意见修改原文。
2. 不要修改未被批阅覆盖的内容，除非为保持上下文连贯而必要。
3. 删除线表示强删除/合并意图，但最终请结合上下文判断。
4. 输出完整修改后的 Markdown 文档。
```

### 4.6 复制 Prompt

复制 Prompt 与导出文件共用同一套生成器，区别是：
- 复制 Prompt 引用原文绝对路径 + 批阅意见，不嵌入原文，token 更省。
- 导出批阅文件只保存批阅意见和上下文快照，不嵌入原文。

### 4.7 CLI 一键执行（P1）

桌面端支持检测已安装 Agent CLI，自动拼接命令并唤起终端执行。

MVP 预设：

| Agent | 检测命令 | 安装方式 |
|-------|----------|----------|
| Claude Code | `which claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `which codex` | `npm i -g @openai/codex` |
| Aider | `which aider` | `pip install aider-chat` |
| Gemini CLI | `which gemini` | `npm i -g @google/gemini-cli` |
| Cursor | `which cursor` | 桌面应用，检测 `/usr/local/bin/cursor` 或 `/Applications/Cursor.app` |

支持用户自定义命令规则模板：

```text
cd "{{vaultPath}}" && claude "读取 {{instructionFile}}，按批阅意见修改 {{filePath}}"
```

可用变量：

| 变量 | 含义 |
|------|------|
| `{{vaultPath}}` | vault 根目录绝对路径 |
| `{{instructionFile}}` | 生成的批阅指令文件路径 |
| `{{fileName}}` | 当前文件名 |
| `{{filePath}}` | 当前文件相对路径 |
| `{{prompt}}` | 内联 prompt 文本 |

安全要求：
- 执行前展示完整命令，用户确认后执行。
- 不执行 sudo，不自动安装 Agent。
- 可设置为“仅复制命令”。

### 4.8 Diff 预览与确认（P1）

桌面端通过 CLI/API 触发修改后，插件提供 Diff 预览。

技术方案：jsdiff + 自定义 Modal。

流程：

```text
执行前保存 originalText
→ Agent 修改文件
→ 读取 newText
→ jsdiff 计算差异
→ Diff Modal 展示
→ 用户选择：全部接受 / 逐块接受 / 回滚
```

选择 jsdiff + Modal 而不是 CM6 MergeView 的理由：
- 用户核心诉求是确认 AI 没改错，不是在 Diff 中编辑。
- 逐块接受/拒绝更符合批阅粒度。
- 开发量小，后续可迁移到 MergeView。

### 4.9 Cursor 直调（P1）

Cursor 不是纯 CLI 工具，不能像 Claude Code 那样直接用 `cursor "prompt"` 驱动执行。Cursor 直调的核心思路是**打开 Cursor 并注入批阅文件路径**，让用户在 Cursor Agent 中手动触发或用 `.cursorrules` 自动继承上下文。

**调用方式**：

```text
open -a Cursor "{{vaultPath}}"
# 然后将批阅文件路径写入 .cursorrules 或剪贴板提示
```

**流程**：

```text
生成批阅指令文件（.multiaiedit/exports/xxx.md）
→ 将文件路径写入 vault 根目录的 .cursorrules（追加模式）
→ 用 open -a Cursor 打开 vault 目录
→ 侧边栏提示：在 Cursor 中按 Cmd+I 唤起 Agent，已为你注入批阅文件
```

**`.cursorrules` 追加示例**：

```text
## MultiAIEdit 批阅任务（自动注入，用完请删除）
请读取并执行批阅文件：.multiaiedit/exports/2026-06-14-产品定位.md
```

**用户设置项**：
- 注入模式：写入 `.cursorrules`（默认） / 仅复制路径提示 / 不注入
- 执行后是否清理 `.cursorrules` 追加内容

**限制**：
- Cursor 暂不支持 CLI 无人值守执行，用户需在 Cursor 内手动触发 Agent。
- 仅 macOS 支持 `open -a Cursor`；Windows 后续视需求补充。
- 不做 Diff 回写到 Obsidian（Cursor 有自己的 Diff 确认流程）。

---

### 4.10 API Key 直调（P2）

**定位**：不安装任何 CLI、不打开外部工具的最后兜底路径。用户提供 API Key，插件直接调模型 API，将批阅意见 + 原文发送，获取修改后文本，走 Diff 流程确认。

**支持 Provider**：

| Provider | API 端点 | 认证方式 |
|----------|----------|----------|
| Anthropic (Claude) | `https://api.anthropic.com/v1/messages` | `x-api-key` header |
| OpenAI (GPT) | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/...` | `?key=` query param |
| 自定义端点 | 用户填写 | OpenAI 兼容格式 |

**交互流程**：

```text
用户点击"API 执行"
→ 检查是否已配置 API Key（未配置则跳转设置）
→ 构建 System Prompt + 用户 Prompt（原文 + 批阅意见）
→ 调用 API，流式输出进度
→ 获取修改后文本
→ jsdiff Diff 预览 + 确认（与 §4.8 相同流程）
```

**Prompt 构建**：

```text
System：你是专业文档编辑助手。请严格按照批阅意见修改文档，不修改未被批阅的部分，输出完整修改后的 Markdown。

User：
## 原文
{{originalText}}

## 批阅意见
{{reviewInstructions}}
```

**安全与隐私**：
- API Key 仅存储在本地 Obsidian 插件数据（`this.saveData()`），不上传。
- 首次使用展示隐私提示：原文和批阅意见将发送给所选 Provider，请确认。
- 不做代理、不做中转，直连 Provider 端点。

**失败处理**：
- 网络超时 / 401 / 429 等错误展示明确提示，不静默失败。
- 支持重试（最多 2 次）。

**设置项**（归属 §7 API 配置）：
- Provider 选择
- API Key（密码输入框）
- 模型名（如 `claude-opus-4-5`, `gpt-4o`）
- 自定义端点 URL
- 最大 Token 数（默认 4096）

---

### 4.11 文件变更检测（P0）(修复了"自动更新 hash 永远检测不到变更"的逻辑漏洞):

| Hash | 持久化 | 计算时机 | 含义 |
|------|-------|---------|------|
| `baselineHash` | 是,在 sidecar | 创建批注时 / Diff 确认完成时 / 用户手动确认时 | "上次用户认可的状态" |
| `currentHash` | 否 | `onActiveLeafChange` 实时计算 | 当前文件真实状态 |

检测到 `baselineHash != currentHash` 时:
- 侧边栏顶部显示横幅:"原文已变更,部分标注可能需要调整"
- 仍按文本锚点定位(strict / fuzzy / drifted)渲染
- 不做逐条状态机,不做自动重锚定
- 导出时依赖上下文快照,让 LLM 语义匹配

baselineHash 何时更新:
- ✅ 用户在横幅点击"我已检查过"
- ✅ Agent 执行 Diff 流程完成确认后
- ❌ `vault.on('modify')` **不**自动更新(否则横幅永远不会触发)

完整算法详见 [technical-design.md](technical-design.md) §5。

---

## 5. 数据架构

### 5.1 存储结构

```text
vault/
├── .multiaiedit/
│   ├── annotations/
│   │   ├── 产品定位.json
│   │   └── ...
│   ├── config.json
│   └── command-rules.json
├── CLAUDE.md
└── GEMINI.md
```

### 5.2 Annotation 数据模型

```ts
type AnnotationType = "highlight" | "note" | "review";
type ViewMode = "reading" | "reviewing" | "all";
type HighlightColor = "yellow" | "blue" | "green" | "purple";
type MatchStrategy = "strict" | "fuzzy" | "drifted";

interface Annotation {
  id: string;
  type: AnnotationType;
  filePath: string;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  lineHint: number;             // 创建时近似行号,定位辅助
  occurrenceIndex: number;      // selectedText 在文档中第几次出现(0-based),消歧用
  baselineHash: string;         // 创建/Diff 确认时记录的文件 hash,用于变更检测

  // reading
  highlightColor?: HighlightColor;
  noteText?: string;

  // reviewing
  reviewText?: string;
  strike?: boolean;

  createdAt: number;
  updatedAt: number;
}
```

> 说明:`from/to` 不持久化,加载时通过 `selectedText + contextBefore/After + lineHint + occurrenceIndex` 动态定位。`matchStrategy` 是定位结果(运行时),不写回 sidecar。完整算法详见 [technical-design.md](technical-design.md) §4。

### 5.3 Sidecar JSON 示例

```json
{
  "version": 1,
  "filePath": "产品定位.md",
  "baselineHash": "sha256:abc...",
  "annotations": [
    {
      "id": "ann-001",
      "type": "highlight",
      "selectedText": "面向0-3岁宝宝的家长",
      "contextBefore": "我们的使命是帮助家庭记录成长。",
      "contextAfter": "强调宝宝的第一次理念。",
      "lineHint": 12,
      "occurrenceIndex": 0,
      "baselineHash": "sha256:abc...",
      "highlightColor": "yellow",
      "createdAt": 1718002800000,
      "updatedAt": 1718002800000
    },
    {
      "id": "ann-002",
      "type": "review",
      "selectedText": "面向0-3岁宝宝的家长",
      "contextBefore": "我们的使命是帮助家庭记录成长。",
      "contextAfter": "强调宝宝的第一次理念。",
      "lineHint": 12,
      "occurrenceIndex": 0,
      "baselineHash": "sha256:abc...",
      "reviewText": "改成新生代妈妈,更聚焦",
      "strike": false,
      "createdAt": 1718002900000,
      "updatedAt": 1718002900000
    }
  ]
}
```

### 5.4 不做的事

- 不做 modify/delete/add/question 四类强结构化选择。
- 不做复杂标签、集合、阅读回顾、间隔复习。
- 不做逐条批注状态机。
- 不做上下文指纹模糊匹配和自动重锚定。
- 不做自建 Agent。

---

## 6. 技术架构

### 6.1 技术栈

| 层 | 技术选型 | 理由 |
|----|----------|------|
| 框架 | Obsidian API + TypeScript | Obsidian 插件标准 |
| 构建 | esbuild | Obsidian 社区标准 |
| UI | Obsidian 原生组件 | MVP 减少复杂度 |
| 数据 | JSON sidecar 文件 | 不污染原文，Vault 内自包含 |
| 高亮 | Decoration API | Obsidian 官方推荐 |
| Diff | jsdiff | 轻量、纯 JS、易渲染 Modal |
| CLI 检测 | child_process | 桌面端 Electron 可用 |
| 平台判断 | Platform.isMobile | 移动端功能降级 |

### 6.2 模块划分

```text
src/
├── main.ts
├── settings/
│   └── SettingsTab.ts
├── annotation/
│   ├── AnnotationModel.ts
│   └── AnnotationStore.ts
├── editor/
│   ├── AnnotationDecorator.ts
│   ├── SelectionPopover.ts      # 阅读/批阅模式下选中文本浮层
│   └── NoteModal.ts             # 笔记输入
├── sidebar/
│   ├── SidebarView.ts
│   ├── ModeCapsule.ts           # 阅读 / 批阅 / 全部
│   └── AnnotationCard.ts
├── export/
│   ├── ReviewExporter.ts        # 导出批阅文件
│   └── PromptExporter.ts
├── agent/
│   ├── AgentDetector.ts
│   ├── CommandBuilder.ts
│   ├── CommandRuleStore.ts
│   └── TerminalLauncher.ts
├── diff/
│   ├── DiffCalculator.ts
│   └── DiffModal.ts
├── api/                         # P2 低优先级
│   ├── APIProvider.ts
│   └── ResponseParser.ts
└── utils/
    ├── hash.ts
    └── platform.ts
```

### 6.3 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 模式设计 | 阅读 / 批阅 / 全部胶囊 | 低成本匹配用户当前意图 |
| 批阅类型 | 统一 review | 不强迫用户分类，交给大模型判断 |
| 删除意图 | `strike: true` | 快速表达强删除/合并意图 |
| 高亮颜色 | 4 个预置色 | MVP 足够，避免复杂设置 |
| 导出范围 | 默认只导出 review | 防止高亮/笔记干扰 AI 执行 |
| 阅读笔记 | 可选作为参考上下文 | 保留灵活性 |
| 移动端 | 只做记录和导出 | 不执行 CLI，不做 Diff |

---

## 7. 设置面板

### 标注设置
- 默认模式：阅读 / 批阅 / 全部（默认：阅读）。
- 高亮颜色：黄 / 蓝 / 绿 / 紫（MVP 不支持自定义）。
- 上下文行数：默认 3 行。
- Sidecar 目录：默认 `.multiaiedit/`。

### 导出设置
- 导出目录：默认 `.multiaiedit/exports/`。
- 导出格式：Markdown（P0），JSON（v0.3）。
- 是否附带阅读笔记：默认否。
- Prompt 模板：可编辑。

### Agent 命令规则（桌面端 only）
- 预设规则：Claude Code / Codex CLI / Aider / Gemini CLI。
- 自定义规则：添加/编辑/删除命令模板。
- 执行模式：自动执行 / 仅复制命令。
- 执行前确认：默认开启。

### API 配置（P2 低优先级）
- Provider：OpenAI / Anthropic / Gemini / 自定义端点。
- API Key。
- 模型名。
- 自定义端点 URL。

---

## 8. 平台策略

### 8.1 移动端

移动端支持：
- 阅读高亮。
- 阅读笔记。
- 批阅意见。
- 侧边栏阅读 / 批阅 / 全部。
- 导出批阅文件。
- 复制 Prompt。

移动端不支持：
- CLI 一键执行。
- MCP Server。
- Diff 预览与确认。

### 8.2 桌面端

桌面端支持全部功能，包括：
- CLI Agent 检测。
- 终端唤起。
- Diff 预览。
- API 直调兜底。

`manifest.json` 不设置 `isDesktopOnly: true`，让移动端可安装但自动功能降级。

---

## 9. Agent 产品全景

### 9.1 CLI 直调（v0.2）

| Agent | 检测命令 | 推荐度 | 说明 |
|-------|----------|--------|------|
| Claude Code | `which claude` | 最高 | 文件系统兼容、CLAUDE.md、MCP 原生支持 |
| Codex CLI | `which codex` | 高 | OpenAI 生态 |
| Aider | `which aider` | 高 | 开源、BYOK、自动 Git |
| Gemini CLI | `which gemini` | 高 | 免费额度高、GEMINI.md |
| Cursor | 检测 `/Applications/Cursor.app` | 中 | 非纯 CLI，通过 `open -a Cursor` + `.cursorrules` 注入；见 §4.9 |

### 9.2 MCP 协议（v0.4+）

| Agent | 特点 |
|-------|------|
| Goose | MCP-first，最契合长期架构 |
| Claude Desktop | MCP 原生 |
| Cline | IDE Agent + MCP |
| Amazon Q | AWS 生态 |

### 9.3 Web / API

ChatGPT / Claude.ai / Gemini 等通过导出文件或复制 Prompt 覆盖。

**API Key 直调**（P2，见 §4.10）：无需打开任何外部产品，插件内直接 BYOK 调用模型 API，适合不安装 CLI 工具的用户。支持 Anthropic / OpenAI / Gemini / 自定义端点。

---

## 10. MVP 范围与演进路线

### v0.1 — 基础阅读与批阅

| 功能         | 说明                 |
| ---------- | ------------------ |
| 阅读/批阅/全部胶囊 | 侧边栏顶部切换            |
| 阅读高亮       | 选中文本后直接选 4 种颜色     |
| 阅读笔记       | 选中文本后添加轻量笔记        |
| 批阅意见       | 删除线 + 批阅文本框        |
| Sidecar 存储 | JSON 文件读写          |
| 侧边栏        | 阅读列表 / 批阅列表 / 全部列表 |
| 导出批阅文件     | Markdown，默认只导出批阅意见 |
| 复制 Prompt  | 原文 + 批阅意见复制到剪贴板    |

### v0.2 — CLI 一键执行 + Diff 预览

| 功能         | 说明                                                                         |
| ---------- | -------------------------------------------------------------------------- |
| Agent 检测   | Claude / Codex / Aider / Gemini                                            |
| 命令规则模板     | 预设 + 自定义变量 + 白名单 lint                                                      |
| 终端唤起       | **macOS first**:Terminal/iTerm2 自动唤起;Windows / Linux **仅复制命令**(用户粘贴到自己的终端) |
| 执行前确认      | 展示完整命令,二次确认                                                                |
| Agent 配置文件 | CLAUDE.md / GEMINI.md                                                      |
| Diff 预览    | jsdiff + Modal,接受/回滚                                                       |

> Windows / Linux 一键唤起的覆盖在 v0.3 视用户反馈再做。理由:跨 DE 终端碎片化,v0.2 强行覆盖性价比低。详见 [technical-design.md](technical-design.md) §6.3。

### v0.3 — 增强视图

| 功能 | 说明 |
|------|------|
| 全库标注视图 | 跨文件查看阅读/批阅 |
| 搜索 | 按关键词查找 |
| JSON 导出 | 程序化消费 |
| 文件移动追踪 | 监听 rename |

### v0.4 — API 直调 + MCP Server

| 功能         | 说明                               |
| ---------- | -------------------------------- |
| API Key 直调 | 低优先级兜底                           |
| MCP Server | 暴露 list_annotations / apply_edit |
| 更多 Agent   | Cursor / Devin / Cline           |

### v0.5 — 协作与迁移

| 功能 | 说明 |
|------|------|
| 批注集合 | 跨文件组织 |
| 从内联标记导入 | 兼容 `%%AJ:%%` |
| 从其他插件迁移 | Sidebar Highlights / HiNote |

---

## 11. 竞品差异化

| 产品 | 高亮 | 笔记 | 不污染原文 | 导出给 AI | CLI 一键执行 | Cursor 直调 | API Key 直调 | Diff 确认 |
|------|------|------|------------|-----------|--------------|------------|--------------|----------|
| Sidebar Highlights | 支持 | 支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| HiNote | 支持 | 支持 | 不支持 | 部分支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| Axl Light | 支持 | 基础 | 支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| MultiAIEdit v0.1 | 支持 | 支持 | 支持 | 支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| MultiAIEdit v0.2 | 支持 | 支持 | 支持 | 支持 | 支持 | 不支持 | 不支持 | 支持 |
| MultiAIEdit v0.4 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |

**v0.1 差异化**：高亮/笔记不是终点，而是可导出给 AI 的结构化批阅入口。

**v0.2 差异化**：打通”批阅意见 → 外部 Agent 执行 → Diff 安全确认”闭环。

**v0.4 差异化**：补全零门槛路径——Cursor 直调（无需命令行）和 API Key 直调（无需任何外部工具）。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 产品变成通用高亮插件 | 定位发散 | 不做复杂标签、集合、复习、摘录库 |
| 批阅不分类会不会降低 AI 准确度 | AI 理解偏差 | 导出时明确说明删除线和自然语言意见，让模型判断 |
| 用户找不到 AI 批阅入口 | 转化不足 | 侧边栏胶囊中固定展示“批阅”，文案明确 |
| 全部模式造成困惑 | 操作不确定 | 全部只作为查看筛选，选中文本默认阅读模式 |
| Agent 执行错误 | 文件被错误修改 | Diff 预览 + 回滚 |
| 移动端能力少 | 体验不完整 | 移动端定位为记录与导出，桌面端完成执行闭环 |
| 命令执行安全 | 用户担心风险 | 执行前确认，不自动安装，不 sudo |

---

## 附录 A：导出路径与 AI 工具适配

| AI 工具 | 使用方式 | 最佳桥接方法 |
|---------|----------|--------------|
| Claude Code | CLI 一键执行 | v0.2 方法 1 |
| Codex CLI | CLI 一键执行 | v0.2 方法 1 |
| Aider | CLI 一键执行 | v0.2 方法 1 |
| Gemini CLI | CLI 一键执行 | v0.2 方法 1 |
| Cursor | Cursor 直调（§4.9） | v0.4，open -a Cursor + .cursorrules 注入 |
| ChatGPT Web | 上传原文 + 批阅文件 | v0.1 导出文件 |
| Claude Web | 上传或加入 Project | v0.1 导出文件 |
| Cursor / Windsurf | 在项目中引用批阅文件 | v0.1 导出文件 |
| API / 自动化 | 解析 JSON | v0.3 JSON 导出 |
| Anthropic / OpenAI / Gemini API | API Key 直调（§4.10） | v0.4，BYOK 插件内直调 |

## 附录 B：短期替代方案

在插件开发完成前，可以用内联标记法临时模拟：

```markdown
这是一段需要处理的内容。%%AJ: 改得更口语化%%
这是一段重复内容。%%AJ: 删除或与上一段合并%%
```

给 AI 的指令：

```text
找出所有 %%AJ: ...%% 标记，根据标记内容修改文档，修改完成后删除标记。
```

---

*相关文档：[Agent 桥接架构详细设计](agent-bridge-architecture.md)，[外部设计工具 brief](external-design-brief.md)*
