# MultiAIEdit 完整技术方案

> 版本：v1.0 | 日期：2026-06-11 | 作者：婧晶 + 檐灯
> 配套：[PRD v0.4](PRD.md)
> 取代：sidecar-anchoring-design.md（已并入第 4 节）、technical-difficulties.md（已并入第 6 节）

---

## 1. 总体判断（结论先行）

| 维度 | 结论 |
|------|------|
| 整体可行性 | 全部模块均有标准做法或同类竞品验证，不存在"理论卡点" |
| v0.1 真正的不确定项 | 仅 1 个：**CM6 Decoration 跨行高亮 + 选中浮层**，必须先做 PoC |
| v0.2 工程量最大模块 | CLI 跨平台执行，**v0.2 收敛为 macOS first**，Windows/Linux 仅"复制命令" |
| 移动端策略 | v0.1 浮层降级为**底部工具栏**，CLI 与 Diff 完全隐藏 |
| 数据安全策略 | sidecar JSON + 文本锚点 + 上下文快照，**不做逐条状态机和自动重锚定** |

---

## 2. 数据模型（PRD §5.2 的扩展规范）

### 2.1 完整 Annotation 模型

```ts
type AnnotationType = "highlight" | "note" | "review";
type HighlightColor = "yellow" | "blue" | "green" | "purple";
type MatchStrategy = "strict" | "fuzzy" | "drifted";

interface Annotation {
  // 标识与归属
  id: string;                     // ann_<timestamp>_<rand>
  type: AnnotationType;
  filePath: string;               // vault 相对路径
  createdAt: number;
  updatedAt: number;

  // 文本锚点（核心,持久化）
  selectedText: string;
  contextBefore: string;          // 选区前 ~50 字符
  contextAfter: string;           // 选区后 ~50 字符
  lineHint: number;               // 创建时近似行号
  occurrenceIndex: number;        // 创建时 selectedText 在文档中第几次出现(0-based)

  // 文件指纹(用于变更检测)
  baselineHash: string;           // 基线 hash:创建/确认 Diff 时记录,用于和 currentHash 比对
  // currentHash 不持久化, 实时计算

  // 类型相关数据
  highlightColor?: HighlightColor; // type=highlight
  noteText?: string;               // type=note
  reviewText?: string;             // type=review
  strike?: boolean;                // type=review
}
```

### 2.2 不持久化的运行时字段

| 字段 | 来源 | 说明 |
|------|------|------|
| `from` / `to` | CM6 偏移量 | 加载时通过文本锚点动态计算 |
| `matchStrategy` | 定位结果 | 每次定位重新计算,不写回 sidecar |
| `currentHash` | 实时计算 | 与 `baselineHash` 比对得到"是否变更" |

### 2.3 Sidecar 文件路径规则

```
vault/.multiaiedit/annotations/<encoded-relative-path>.json
```

**编码规则**：原文件相对路径中的 `/` 替换为 `__`，避免目录嵌套带来的同名冲突。
- `notes/meeting.md` → `notes__meeting.json`
- `产品定位.md` → `产品定位.json`

理由：sidecar 平铺存储便于全库扫描；不嵌套避免 `notes/meeting.md` 与 `meeting.md` 撞名。

### 2.4 Sidecar JSON 完整示例

```json
{
  "version": 1,
  "filePath": "notes/产品定位.md",
  "baselineHash": "sha256:abc123...",
  "annotations": [
    {
      "id": "ann_1718096000_a3f2",
      "type": "highlight",
      "filePath": "notes/产品定位.md",
      "selectedText": "面向0-3岁宝宝的家长",
      "contextBefore": "我们的使命是帮助家庭记录成长。",
      "contextAfter": "强调宝宝的第一次理念。",
      "lineHint": 42,
      "occurrenceIndex": 0,
      "baselineHash": "sha256:abc123...",
      "highlightColor": "yellow",
      "createdAt": 1718002800000,
      "updatedAt": 1718002800000
    }
  ]
}
```

---

## 3. 模块架构

```text
src/
├── main.ts
├── settings/SettingsTab.ts
├── annotation/
│   ├── AnnotationModel.ts        # 类型定义
│   ├── AnnotationStore.ts        # 内存缓存 + debounce 写入
│   └── AnnotationLocator.ts      # 文本锚点 → from/to (核心算法,见 §4)
├── editor/
│   ├── AnnotationDecorator.ts    # CM6 Decoration 渲染
│   ├── SelectionPopover.ts       # 桌面端浮层
│   ├── BottomToolbar.ts          # 移动端底部工具栏 (浮层降级)
│   └── NoteModal.ts
├── sidebar/
│   ├── SidebarView.ts
│   ├── ModeCapsule.ts
│   ├── AnnotationCard.ts
│   └── ChangeBanner.ts           # baselineHash != currentHash 横幅
├── export/
│   ├── ReviewExporter.ts
│   └── PromptExporter.ts
├── agent/                        # v0.2,桌面端 only
│   ├── AgentDetector.ts
│   ├── CommandBuilder.ts         # 模板 + 白名单变量替换
│   ├── CommandRuleStore.ts
│   └── TerminalLauncher.ts
├── diff/                         # v0.2
│   ├── DiffCalculator.ts
│   └── DiffModal.ts
├── api/                          # v0.4
└── utils/
    ├── hash.ts
    ├── platform.ts
    └── shellescape.ts
```

---

## 4. 锚点定位机制

### 4.1 核心原则

**只存文本锚点,不存偏移量。** sidecar JSON 中持久化 `selectedText + contextBefore/After + lineHint + occurrenceIndex`,加载时通过文本搜索动态计算 `from/to`。

### 4.2 创建批注流程

```text
用户选中文本
  ↓
获取 selectedText + 当前 from/to + 行号 → lineHint
  ↓
截取 contextBefore (from 前 ~50 字符)、contextAfter (to 后 ~50 字符)
  ↓
计算 occurrenceIndex (selectedText 在全文第几次出现, 0-based)
  ↓
计算 baselineHash = SHA256(当前文件全文)
  ↓
写入 sidecar JSON (不含 from/to)
```

### 4.3 加载/打开文件流程（重新定位）

```typescript
function locateAnnotation(doc: string, ann: Annotation): LocateResult {
  // 第 1 步: 全量拼接最严格匹配
  const full = ann.contextBefore + ann.selectedText + ann.contextAfter;
  let matches = findAll(doc, full);
  if (matches.length === 1) return { status: 'strict', range: matches[0] };

  // 第 2 步: 多匹配时, 优先选离 lineHint 最近且 index 一致
  if (matches.length > 1) {
    const ordered = matches.sort((a, b) =>
      Math.abs(a.line - ann.lineHint) - Math.abs(b.line - ann.lineHint));
    const idx = matches.indexOf(ordered[0]);
    if (idx === ann.occurrenceIndex) {
      return { status: 'strict', range: ordered[0] };
    }
  }

  // 第 3 步: 降级为 contextBefore + selectedText
  matches = findAll(doc, ann.contextBefore + ann.selectedText);
  if (matches.length === 1) return { status: 'strict', range: matches[0] };

  // 第 4 步: 用 occurrenceIndex 在 selectedText 全部出现位置中消歧
  const occ = findAll(doc, ann.selectedText);
  if (occ.length > ann.occurrenceIndex) {
    return { status: 'fuzzy', range: occ[ann.occurrenceIndex] };
  }

  // 第 5 步: 完全找不到
  return { status: 'drifted' };
}
```

### 4.4 关于 occurrenceIndex 的语义边界

- **用途**：仅作为"创建时的快照启发式",在多匹配时辅助消歧。
- **不保证编辑后仍准确**：若用户在前文插入了相同字符串,occurrenceIndex 会失准——此时通过 contextBefore/After 兜底。
- **不在编辑后回写**：保持原值即可,定位失败时降级到 fuzzy/drifted。

### 4.5 渲染策略（明确 fuzzy 的视觉表现）

| status | 编辑器渲染 | 侧边栏卡片 |
|--------|-----------|-----------|
| strict | 正常高亮 | 普通展示 |
| fuzzy | 仍渲染高亮(occurrenceIndex 命中位置) | 卡片左上角 ⚠️,Tooltip 提示"位置存在歧义,点击跳转其他候选" |
| drifted | 不渲染高亮 | 卡片底色变灰,标记"漂移",支持手动重锚或删除 |

### 4.6 编辑会话内的高亮跟随

- **v0.1**：不做实时偏移跟随,只在打开/切换文件时定位一次。配合 baselineHash 横幅,体验可接受。
- **v0.2**：CM6 `updateListener` 监听 Transaction,**单文件 < 200 条时全量重建**,> 200 条降级为视口内重建。

---

## 5. 文件变更检测（baselineHash 状态机）

### 5.1 双 hash 模型

| Hash | 持久化 | 计算时机 | 含义 |
|------|-------|---------|------|
| `baselineHash` | 是,在 sidecar | 创建批注时 / Diff 确认完成时 | "上次用户认可的状态" |
| `currentHash` | 否 | `onActiveLeafChange` 时实时 SHA256(文件) | 当前真实状态 |

### 5.2 触发规则（修复原方案漏洞）

```text
切到某文件 → 计算 currentHash
  ↓
比对 baselineHash
  ├─ 相等 → 正常渲染
  └─ 不等 → 顶部横幅"原文已变更, 部分标注可能需要调整"
            + 渲染按定位结果(strict / fuzzy / drifted)
              ↓
            用户操作:
              - "我已检查过" → baselineHash := currentHash
              - "Agent 执行 Diff 已确认" → 自动 baselineHash := currentHash
              - 不操作 → 横幅持续显示
```

**关键修复**：`vault.on('modify')` 不自动更新 baselineHash,否则永远检测不到变更。只有用户主动确认或 Diff 流程完成时才更新 baseline。

### 5.3 不做的事

| 不做 | 理由 |
|------|------|
| 逐条状态机 | 工程量巨大,做错比不做更糟 |
| 自动重锚定 (Levenshtein 等) | 文本漂移检测是经典难题,ROI 太低 |
| 上下文模糊匹配 | LLM 是更好的语义匹配器,导出时把上下文快照交给它就行 |

---

## 6. 难点逐模块分析

### 6.1 难点 1：CM6 高亮渲染（风险高,工期 2-3 天,v0.1）

#### 跨行高亮

CM6 Decoration 基于字符偏移,跨行选区拆分为多个独立 Decoration:
- 首行：`from = selectionStart, to = 行末`
- 中间行：`from = 行首, to = 行末`
- 尾行：`from = 行首, to = selectionEnd`

视觉断裂规避:
- 每行 Decoration 用同一 CSS class
- 用 `background-color` 而非 `border` / `box-shadow`
- 配合 `display: inline` 对齐到内容区边缘

参考 Sidebar Highlights 插件实现。

#### 删除线

`strike: true` 的 review 用独立 Decoration 样式：`text-decoration: line-through` + muted red 背景,与高亮 class 区分。

#### 主题兼容

```css
.cm-multiaiedit-highlight-yellow {
  background-color: rgba(244, 211, 94, 0.32);
}
.theme-dark .cm-multiaiedit-highlight-yellow {
  background-color: rgba(244, 211, 94, 0.25);
}
```

#### 与原生 `==高亮==` 的视觉区分

Obsidian 原生 `==text==` 渲染为黄色高亮,本插件 4 色高亮需在视觉上明显不同:
- 本插件高亮使用淡色背景 + 左侧 2px 颜色条,与原生 `==高亮==` 区分
- 在卡片中明确标注"插件高亮"字样

#### MVP 简化

v0.1 不做实时跟随(切换文件时定位即可),复杂度降 60%。

---

### 6.2 难点 2：选中文本浮层（风险高,工期 2-3 天,v0.1）

#### 桌面端方案

```typescript
const coords = view.coordsAtPos(from);  // {left, top, bottom, ...}
// 浮层定位到 coords 上方
```

跨行选区取 from 行的 bottom 作为锚点；监听 `view.scrollDOM` 的 scroll 事件让浮层跟随或隐藏。

#### 移动端降级（修正 PRD §4.2/§4.3）

iOS/Android 触屏选区会先弹出系统菜单,浮层会被遮挡。**移动端 v0.1 改为底部工具栏方案**:
- 选中文本后,Obsidian 移动端底部出现工具栏
- 工具栏内容随当前模式(阅读/批阅)切换
- 不与系统选区菜单冲突

| 平台 | 方案 |
|------|------|
| 桌面端 | CM6 Panel Extension / 绝对定位 DOM + coordsAtPos |
| 移动端 | 底部工具栏 (BottomToolbar.ts) |
| 兜底 | 右键菜单 / Command Palette |

#### 模式感知切换

| 模式 | 浮层/工具栏内容 |
|------|----------------|
| 阅读 | [黄][蓝][绿][紫][笔记] |
| 批阅 | [S 删除线][输入批阅意见...] |
| 全部 | 默认走阅读模式 (PRD §4.1) |

---

### 6.3 难点 3：CLI 跨平台执行（风险中高,v0.2,平台收敛）

#### 平台范围（修正 PRD §10 v0.2）

| 平台 | v0.2 支持 | 实现 |
|------|----------|------|
| macOS | 完整一键执行 | `osascript -e 'tell app "Terminal"...'`,可配置 iTerm2 |
| Windows | **仅复制命令** | 用户粘贴到自己的终端 |
| Linux | **仅复制命令** | DE 差异太大,不做自动唤起 |

理由：Windows / Linux 终端唤起方式碎片化(cmd vs PowerShell vs WT;gnome-terminal vs konsole vs xfce4-terminal),v0.2 强行覆盖性价比低。v0.3 视用户反馈再做。

#### 命令注入防御（白名单,不再用黑名单）

**原方案漏洞**：黑名单"禁止 sudo / | / `"漏掉了 `>` `$()` `&&` `;` 仍可注入。

**白名单策略**：
1. 模板内**仅允许预设变量**(`{{vaultPath}}` `{{instructionFile}}` `{{filePath}}` `{{fileName}}` `{{prompt}}`)和字面字符。
2. 模板字面值**不允许**包含 shell 控制字符:`| & ; > < \` $ ( ) { }`,保存时 lint 报错。
3. 所有变量值经 `shellEscape()` 单引号包裹,内含单引号转义为 `'\''`。
4. 最终命令在执行前**完整展示给用户**,二次确认。

```typescript
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

const FORBIDDEN_CHARS = /[|&;<>`$(){}]/;
function validateTemplate(tpl: string): void {
  // 把 {{var}} 占位符抠掉后, 剩余字面值不允许包含控制字符
  const literal = tpl.replace(/\{\{[a-z]+\}\}/g, '');
  if (FORBIDDEN_CHARS.test(literal)) {
    throw new Error('模板含禁用字符');
  }
}
```

#### 执行结果监听（无返回值的状态机）

osascript 启动 Terminal 后即返回,只能通过 vault 事件监听:

```text
IDLE → 用户点击执行 → CONFIRMING (展示完整命令)
   → 用户确认 → RUNNING (保存 originalText, 监听目标文件)
   → vault.on('modify', file) 命中目标 → DIFF_PREVIEW
   → 5min 超时 → 提示"未检测到变更, 请手动检查"
```

只监听 PRD 当前文件,Agent 修改的其他文件(CLAUDE.md / 新文件)忽略。

#### Obsidian 社区审核

`child_process` 有安全审查。**v0.1 不打包 CLI 模块**(也不需要),v0.2 单独提交并在 README 说明:
- 命令完整展示后用户确认才执行
- 不执行 sudo,不自动安装 Agent
- 提供"仅复制命令"模式作为安全降级

---

### 6.4 难点 4：Sidecar 存储（风险中,工期 1-2 天,v0.1）

#### 并发写入：debounce + 内存缓存

```typescript
private cache: Map<string, AnnotationFile> = new Map();
private writeQueue: Map<string, NodeJS.Timeout> = new Map();

saveAnnotation(filePath: string, ann: Annotation): void {
  this.cache.get(filePath).annotations.push(ann);
  if (this.writeQueue.has(filePath)) {
    clearTimeout(this.writeQueue.get(filePath));
  }
  this.writeQueue.set(filePath, setTimeout(() => {
    this.flushToDisk(filePath);
  }, 300));
}
```

#### 重命名追踪

```typescript
this.app.vault.on('rename', (file, oldPath) => {
  const oldSidecar = encodeSidecarPath(oldPath);
  const newSidecar = encodeSidecarPath(file.path);
  // 1. 重命名 sidecar 文件
  // 2. 更新 sidecar 内 filePath 字段
  // 3. 更新内存缓存的 key
});
```

#### 删除追踪与孤儿清理

```typescript
this.app.vault.on('delete', (file) => {
  const sidecarPath = encodeSidecarPath(file.path);
  // 默认: 移到 .multiaiedit/orphans/ 而非直接删除, 避免误删
  // 设置中提供"立即删除孤儿 sidecar"选项
});
```

启动时扫描 `.multiaiedit/annotations/`,对照 vault 当前文件检查孤儿,在设置中暴露"清理孤儿 sidecar"按钮。

#### 插件卸载时数据保留

设置面板提供:
- "卸载时保留 .multiaiedit/ 数据"(默认开启)
- "立即删除所有 sidecar"(危险操作,需二次确认)

---

### 6.5 难点 5：移动端适配（风险中,持续）

| 能力 | 桌面端 Electron | 移动端 WebView | 处理 |
|------|----------------|---------------|------|
| child_process | ✅ | ❌ | `Platform.isMobile` 隐藏 CLI 模块 |
| fs | 完整 Node.js | 仅 vault 抽象 | 统一走 `vault.adapter` |
| CM6 API | 完整 | 可用但触屏受限 | 浮层降级为底部工具栏 |
| fetch CORS | Electron renderer **仍有 CORS** | 有 CORS | 统一用 `requestUrl()` |
| Diff 预览 | ✅ | ❌ | 移动端不渲染 Diff 入口 |

**Platform.isMobile 必须真机测试**,模拟器不可信。

---

### 6.6 难点 6：Diff 预览（风险中低,工期 1-2 天,v0.2）

技术选型:`jsdiff` + 自定义 Modal,理由见 PRD §4.8。

```typescript
import * as Diff from 'diff';
const changes = Diff.diffLines(originalText, newText);
// added → 绿背景, removed → 红背景, unchanged → 默认
```

逐块接受/拒绝维护 `acceptedChanges: Map<changeIndex, boolean>`,最终合并时只应用 accepted 的块。

#### 边缘情况

| 情况 | 处理 |
|------|------|
| 模型返回被 \`\`\`markdown\`\`\` 包裹 | `cleanModelOutput()` 剥离 fence |
| 返回内容 < 原文 50% | 提示"可能截断,请检查" |
| Diff > 500 行变更 | Modal 启用虚拟滚动(react-window 或自实现) |
| Diff 确认完成 | `baselineHash := SHA256(newText)`,清除变更横幅 |

---

## 7. 工程计划

### 7.1 v0.1 开发顺序（7 天）

| Day | 任务 | 产出 |
|-----|------|------|
| 1-2 | **PoC**：CM6 跨行高亮 + 桌面端浮层 + 移动端底部工具栏 | 验证核心可行性 |
| 3 | AnnotationStore (debounce / rename / delete) + AnnotationLocator | 数据层完整 |
| 4 | 侧边栏(ItemView + 胶囊 + 批注列表 + 跳转/删除) | 阅读链路闭环 |
| 5 | ReviewExporter + PromptExporter + 复制 Prompt | 批阅链路闭环 |
| 6 | baselineHash 横幅 + fuzzy/drifted 渲染 + 移动端真机测试 | 边界完善 |
| 7 | Buffer (修复 + 交互打磨) | 提交审核 |

### 7.2 v0.1 PoC 验收清单

- [ ] 跨行选区高亮渲染正确,首尾对齐
- [ ] 切换文件时高亮通过文本锚点正确恢复
- [ ] 桌面端浮层定位到选区上方,滚动跟随/隐藏
- [ ] 移动端底部工具栏选中触发,模式切换内容变化
- [ ] sidecar JSON 读写正确,debounce 不丢数据
- [ ] baselineHash 不等时横幅正确显示
- [ ] fuzzy 状态卡片显示 ⚠️ 并可跳转候选位置
- [ ] drifted 状态不渲染高亮但卡片可见,可手动删除/重锚

### 7.3 风险矩阵

| 模块 | 风险 | v0.1 必须 | 备注 |
|------|------|----------|------|
| CM6 高亮渲染 | 高 | 是 | 先做 PoC |
| 选中文本浮层 | 高 | 是 | 移动端降级为底部工具栏 |
| Sidecar 存储 | 中 | 是 | debounce + rename + 孤儿清理 |
| 锚点定位 | 中 | 是 | 文本搜索分级算法 |
| 侧边栏 / 导出 / 复制 | 低 | 是 | 标准实现 |
| CLI 执行 | 中高 | 否(v0.2) | macOS first |
| Diff 预览 | 中低 | 否(v0.2) | jsdiff + Modal |
| API 直调 | 低 | 否(v0.4) | requestUrl |

---

## 8. 安全策略汇总

| 维度 | 策略 |
|------|------|
| Sidecar 数据 | vault 内自包含,不发送外网 |
| API Key | `plugin.saveData()` 持久化,不写入 sidecar,不导出 |
| CLI 命令 | 白名单变量 + shellEscape + 执行前完整展示 |
| 命令模板 lint | 字面值禁止 `\| & ; > < \` $ ( ) { }`,保存时校验 |
| Diff 安全 | 修改前保存 originalText,支持回滚 |
| 移动端 | 不暴露任何 CLI / 命令配置入口 |
| 卸载 | 默认保留 `.multiaiedit/`,提供主动清理选项 |

---

## 9. 与外部 AI 的接口契约

### 9.1 导出 Markdown 结构（覆盖原文已变情况）

导出不嵌入完整原文。每条批阅必含:`原文选中片段` `意见` `上下文(前)` `上下文(后)`,AI 工具通过上下文快照语义匹配原文。复制 Prompt 通过绝对路径引用原文,导出文件不含原文。详见 PRD §4.5、§4.6。

### 9.2 导出 JSON（v0.3）

```json
{
  "schemaVersion": 1,
  "filePath": "notes/产品定位.md",
  "exportTime": "2026-06-11T10:30:00Z",
  "annotations": [
    {
      "id": "ann_1718096000_a3f2",
      "type": "review",
      "selectedText": "...",
      "contextBefore": "...",
      "contextAfter": "...",
      "reviewText": "...",
      "strike": false
    }
  ]
}
```

### 9.3 Prompt token 预估

复制 Prompt / 导出文件时显示预估 token 数(粗略 4 字符 = 1 token);超过 100k 时提示"建议分段导出"。

---

## 10. PRD 回灌清单

本方案要求同步更新 PRD:

| PRD 位置 | 修改 |
|----------|------|
| §5.2 数据模型 | 加入 `lineHint` `occurrenceIndex` `baselineHash` 字段 |
| §4.2 / §4.3 | 增补"移动端浮层降级为底部工具栏"说明 |
| §4.9 文件变更检测 | 改为 baselineHash + currentHash 双 hash 模型 |
| §10 v0.2 | CLI 执行收敛为"macOS 一键执行 + Win/Linux 仅复制命令" |

---

*相关文档:[PRD v0.4](PRD.md), [Agent 桥接架构](agent-bridge-architecture.md)*
*已废弃:sidecar-anchoring-design.md, technical-difficulties.md (内容已并入本文档)*
