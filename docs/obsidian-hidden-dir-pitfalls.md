# Obsidian 插件开发踩坑：隐藏目录 + Finder 打开

> 2026-06-15 实战总结，来自 Promptuary 插件导出流程改造

---

## 问题 1：`require('electron').shell` 在渲染进程不可用

### 现象

调用 `shell.openPath()` 或 `shell.showItemInFolder()` 后，Finder 完全没有反应，也没有报错。代码静默失败。

### 根因

Obsidian 插件运行在 Electron **渲染进程**（renderer process）。`shell` 模块属于**主进程**（main process）模块。

在渲染进程中 `require('electron')` 只返回渲染进程可用的 API：

| 模块 | 渲染进程可用 |
|------|:---:|
| `clipboard` | ✅ |
| `ipcRenderer` | ✅ |
| `nativeImage` | ✅ |
| `webFrame` | ✅ |
| **`shell`** | ❌ |
| **`dialog`** | ❌ |
| **`app`** | ❌ |
| **`BrowserWindow`** | ❌ |

调用 `shell.openPath()` 时，`shell` 为 `undefined`，访问其方法抛出 TypeError，但 try-catch 吞掉了错误，导致静默失败。

### 解决方案

用 `child_process.exec()` 执行系统命令（已在 TerminalLauncher 中验证可用）：

| 功能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 打开文件夹 | `open "path"` | `explorer "path"` | `xdg-open "path"` |
| **定位文件**（等价 showItemInFolder） | `open -R "path"` | `explorer /select,"path"` | `xdg-open "parent_dir"` |

```typescript
import { exec } from "child_process";

function revealInFileManager(absPath: string): void {
  const cmd = process.platform === "darwin"
    ? `open -R "${absPath}"`
    : process.platform === "win32"
      ? `explorer /select,"${absPath}"`
      : `xdg-open "${path.dirname(absPath)}"`;
  exec(cmd);
}
```

### 参考

- Electron 官方文档：[Main Process Modules vs Renderer Process Modules](https://www.electronjs.org/docs/latest/api/shell)
- Obsidian 插件全部运行在渲染进程，无法直接访问主进程模块

---

## 问题 2：`vault.create()` 对隐藏目录返回 null

### 现象

```typescript
const created = await this.app.vault.create('.promptuary/exports/file.md', content);
console.log(created); // null
created.path; // TypeError: Cannot read properties of null
```

### 根因

Obsidian 的 Vault 只索引**可见路径**下的文件。以 `.` 开头的隐藏目录不属于 Vault 索引范围。

`vault.create()` 的行为：
- 可见路径（如 `Notes/file.md`）：创建文件，返回 `TFile`
- 隐藏路径（如 `.promptuary/file.md`）：创建文件到磁盘，但 **不加入索引**，返回 `null`

这不抛错，但后续访问 `created.path` 就会 TypeError。

### 解决方案

对隐藏目录下的文件，使用 `adapter.write()` 代替 `vault.create()`：

```typescript
const adapter = this.app.vault.adapter;

// 确保目录存在
if (!(await adapter.exists(dirPath))) {
  await adapter.mkdir(dirPath);
}

// 直接写入，不依赖 Vault 索引
await adapter.write(filePath, content);

// 返回路径字符串，不依赖 TFile
return filePath;
```

**对比**：

| 方法 | 适用场景 | 返回值 | Vault 索引 |
|------|---------|--------|:---:|
| `vault.create(path, content)` | 可见目录 | `TFile \| null` | ✅ 加入 |
| `adapter.write(path, content)` | 任意路径 | `void` | ❌ 不加入 |
| `vault.read(file)` | 读取 TFile | `string` | — |
| `adapter.read(path)` | 读取任意路径 | `string` | — |

---

## 问题 3：隐藏目录 + Finder 的交互设计

### 设计决策

导出目录改为 `.promptuary/exports`（隐藏，不污染工作区），导出后用 Finder 定位文件。

- `shell.openPath(隐藏目录)` → Finder 打开了但默认不显示隐藏文件，用户看不到内容
- `open -R "具体文件"` → Finder 打开父目录并**选中该文件**，用户一眼能看到

### 最终实现

```
导出批注 → adapter.write() 写入 .promptuary/exports/ → exec('open -R') 在 Finder 定位
```

### 迁移逻辑

旧用户可能还在用可见目录，`loadSettings()` 自动迁移：

```typescript
const LEGACY_EXPORT_DIRS = ["Promptuary/exports", "MultiAIEdit/exports", ".multiaiedit/exports"];
if (LEGACY_EXPORT_DIRS.includes(this.settings.exportDir)) {
  this.settings.exportDir = ".promptuary/exports";
  await this.saveSettings();
}
```

---

## 快速参考

```
Obsidian 插件渲染进程限制:
├── require('electron').shell  ❌ 不可用（主进程模块）
├── require('child_process')   ✅ 可用
├── require('fs')              ✅ 可用
├── require('path')            ✅ 可用
└── require('os')              ✅ 可用

隐藏目录操作:
├── vault.create()    ❌ 返回 null
├── vault.read()      ❌ 找不到 TFile
├── adapter.write()   ✅ 直接写磁盘
├── adapter.read()    ✅ 直接读磁盘
├── adapter.exists()  ✅ 检查存在
└── adapter.mkdir()   ✅ 创建目录

Finder 打开:
├── shell.openPath()       ❌ 渲染进程不可用
├── shell.showItemInFolder() ❌ 渲染进程不可用
├── exec('open "dir"')     ✅ 打开文件夹
├── exec('open -R "file"') ✅ 定位文件（推荐）
└── exec('explorer /select,"file"') ✅ Windows 定位文件
```
