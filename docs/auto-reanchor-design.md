# 自动重锚功能设计文档

> 版本：v1.0 | 日期：2026-06-14 | 作者：婧晶 + 檐灯

---

## 1. 问题

批注锚点漂移是批注类产品的核心痛点。当原文被修改后（用户自编辑或 Agent 执行），批注的 `selectedText` 无法在文档中精确匹配，导致：
- 高亮消失（drifted 状态）
- 用户必须手动找到批注对应的文本位置
- 批注与原文脱节，失去参考价值

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| 不侵入原文 | 批注始终存储在 sidecar JSON，不修改原文 |
| 精度优先 | Agent 场景下使用精确 diff 映射，不依赖启发式 |
| 静默修复 | 自动修复后 Notice 通知，不阻断用户工作流 |
| 渐进降级 | 方案 B 失败 → 方案 A → 手动检查 |

## 3. 方案对比

| 方案 | 原理 | 精度 | 延迟 | 适用场景 | 工程量 |
|------|------|------|------|---------|--------|
| B. Diff 回锚 | oldText→newText diff 映射旧偏移→新偏移 | 最高 | <50ms | Agent 执行、已知原文快照 | 中（~200 行） |
| A. 模糊匹配 | trigram 相似度 + 滑动窗口搜索 | 高 | <100ms | 用户自编辑、无原文快照 | 中（~150 行） |
| C. 上下文渐进放宽 | 已有 5 步搜索 | 中 | <5ms | 上下文一侧幸存 | 已实现 |
| D. LLM 辅助 | API 调用让 LLM 定位 | 最高 | 1-3s | 大幅重写 | 大（v0.4） |

## 4. 方案 B：Diff 回锚映射器

### 4.1 核心算法

```
输入：oldText, newText, annotations[]
  ↓
1. 计算 LCS diff（oldText ↔ newText）
  ↓
2. 构建 DiffChunk[]：每个 chunk 记录 {oldStart, oldEnd, newStart, newEnd, modified}
  ↓
3. 构建 MapPoint[]：旧偏移 → 新偏移的映射表（支持二分查找）
  ↓
4. 对每个 annotation：
   a. 在 oldText 中定位 selectedText 的偏移范围
   b. 通过 MapPoint 映射到 newText 的偏移范围
   c. 提取新 selectedText / contextBefore / contextAfter / lineHint / occurrenceIndex
   d. 验证相似度 ≥ 0.3（防止误映射）
  ↓
5. 返回 AnchorUpdate[]：{id, status: "healed"|"drifted", patch}
```

### 4.2 触发时机

- Agent 执行后 Diff 确认（accept-all / accept-partial）
- `main.ts` 的 `reanchorAndConfirm()` 方法统一处理

### 4.3 相似度验证

使用字符频率 Jaccard 系数验证映射结果：
- 1.0 = 完全匹配（Agent 没动这段文本）
- 0.3 = 阈值（低于此认为映射错误，标记为 drifted）

## 5. 方案 A：编辑距离模糊定位

### 5.1 核心算法

```
输入：doc, annotation（locate() 返回 drifted 的）
  ↓
1. 缩小搜索区域：lineHint ± 50 行
  ↓
2. 滑动窗口搜索（步长 8 字符）：
   - 取 doc[i : i+needleLen]
   - 计算 trigramSimilarity(selectedText, candidate)
   - 保留最高分位置
  ↓
3. 精细搜索：最佳位置 ± 16 字符，步长 1
  ↓
4. 阈值判定：
   - ≥ 0.5 → 返回 {status: "auto-healed", from, to, confidence}
   - < 0.5 → 返回 {status: "drifted"}
```

### 5.2 Trigram 相似度

将字符串拆为 3 字符的 n-gram，计算 Jaccard 系数：
- 速度：O(n) 构建 + O(|A|+|B|) 比较
- 优势：比 Levenshtein 快 5-10x，对"改几个字"的场景精度足够

### 5.3 性能防护

- `selectedText` 超过 500 字符不执行模糊搜索
- `lineHint` 有效时搜索范围缩减到 ±50 行
- 步长 8 + 精细搜索两轮，避免 O(n²) 暴力搜索

### 5.4 触发时机

- SidebarView 的 `refresh()` 中检测到 drifted annotation
- `reanchorAndConfirm()` 中方案 B 失败的 annotation

## 6. auto-healed 状态

### 6.1 数据模型

`MatchStrategy` 新增 `"auto-healed"` 值：

```typescript
export type MatchStrategy = "strict" | "fuzzy" | "auto-healed" | "drifted";
```

`LocateResult` 新增 `confidence` 字段：

```typescript
interface LocateResult {
  status: MatchStrategy;
  from?: number;
  to?: number;
  confidence?: number;  // 0..1, auto-healed 时有值
}
```

### 6.2 视觉表现

| 位置 | strict | fuzzy | auto-healed | drifted |
|------|--------|-------|-------------|---------|
| 编辑器 | 正常高亮 | 虚线框 + 高亮 | 高亮 + 蓝色左边框 | 不渲染 |
| 侧边栏卡片 | 正常 | ⚠ 位置歧义 | 🔧 已自动修复 | ⚠ 已漂移（灰底） |
| 卡片左侧色条 | 对应颜色 | 黄色警告 | 蓝色 | 红色 |

### 6.3 用户通知

| 场景 | Notice |
|------|--------|
| Agent 执行后全部修复 | "已自动修复 N 条批注位置" |
| Agent 执行后部分修复 | "已自动修复 N 条批注位置，M 条仍需手动检查" |
| 侧边栏自编辑后修复 | "已自动修复 N 条批注位置" |
| 仍有漂移 | "N 条批注位置已漂移，请手动检查" |

## 7. 与现有系统的集成点

### 7.1 Agent 执行流程（更新）

```
Agent 执行 → Diff 确认
  ↓
reanchorAndConfirm(filePath, oldText, finalText)
  ├─ reanchorAnnotations() → 方案 B 精确映射
  ├─ 失败的 → fuzzyLocate() → 方案 A 模糊匹配
  ├─ 更新 sidecar（selectedText/context/lineHint/occIndex）
  ├─ 更新 baselineHash
  └─ Notice 通知修复结果
```

### 7.2 侧边栏自编辑修复（新增）

```
SidebarView.refresh()
  ↓
检测到 baselineHash ≠ currentHash
  ↓
遍历 annotations → locate()
  ├─ strict → OK
  ├─ fuzzy → 标记 affected.fuzzy
  ├─ drifted → 尝试 fuzzyLocate()
  │   ├─ 成功 → updateAnnotation() + affected.autoHealed++
  │   └─ 失败 → affected.drifted++
  ↓
全部修复 → confirmBaseline(silent) + Notice
部分修复 → 显示 Banner + Notice
```

## 8. 限制与边界

| 限制 | 原因 |
|------|------|
| selectedText 超过 500 字不做模糊搜索 | 性能防护 |
| trigram 相似度 < 0.5 标记为 drifted | 避免误匹配 |
| diff 回锚相似度 < 0.3 标记为 drifted | 避免映射错误 |
| 大幅重写（> 50% 文本变更）可能无法修复 | 需要方案 D（LLM 辅助，v0.4） |

---

*相关文档：[技术设计](technical-design.md)、[Agent 桥接架构](agent-bridge-architecture.md)*
