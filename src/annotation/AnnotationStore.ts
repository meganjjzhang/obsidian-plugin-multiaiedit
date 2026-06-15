import { App, TAbstractFile, TFile, EventRef, Events } from "obsidian";
import { Annotation, AnnotationFile, emptyAnnotationFile, FILE_VERSION } from "./AnnotationModel";
import { sidecarPath, ensureDir, removeEmptyAncestors } from "../utils/path";
import { sha256 } from "../utils/hash";

const WRITE_DEBOUNCE_MS = 300;

/**
 * AnnotationStore — in-memory cache + debounced sidecar JSON I/O.
 * Owns vault rename / delete tracking and exposes a tiny event bus
 * (`onChange`) that the UI subscribes to.
 */
export class AnnotationStore extends Events {
  private cache: Map<string, AnnotationFile> = new Map();
  private writeTimers: Map<string, number> = new Map();
  private pendingFlush: Set<string> = new Set();
  private vaultRefs: EventRef[] = [];

  /** Returns the current sidecar root directory — reads from the plugin
   *  settings each time so that runtime changes to `sidecarDir` take
   *  effect immediately without rebuilding the store. */
  private get rootDir(): string {
    return this.getRootDir();
  }

  constructor(
    private app: App,
    private getRootDir: () => string,
  ) {
    super();
  }

  // ---------- lifecycle ----------

  registerVaultEvents(): void {
    this.vaultRefs.push(
      this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)),
    );
    this.vaultRefs.push(this.app.vault.on("delete", (file) => this.handleDelete(file)));
  }

  destroy(): void {
    for (const t of this.writeTimers.values()) window.clearTimeout(t);
    this.writeTimers.clear();
    for (const ref of this.vaultRefs) this.app.vault.offref(ref);
    this.vaultRefs = [];
  }

  // ---------- read ----------

  /** Get annotations for `filePath`, loading from disk on first access. */
  async getFile(filePath: string): Promise<AnnotationFile> {
    const cached = this.cache.get(filePath);
    if (cached) return cached;
    const loaded = await this.loadFromDisk(filePath);
    this.cache.set(filePath, loaded);
    return loaded;
  }

  getCached(filePath: string): AnnotationFile | undefined {
    return this.cache.get(filePath);
  }

  // ---------- write ----------

  async addAnnotation(filePath: string, ann: Annotation): Promise<void> {
    const file = await this.getFile(filePath);
    file.annotations.push(ann);
    if (!file.baselineHash) file.baselineHash = ann.baselineHash;
    this.scheduleWrite(filePath);
    this.trigger("change", filePath);
  }

  async updateAnnotation(filePath: string, id: string, patch: Partial<Annotation>): Promise<void> {
    const file = await this.getFile(filePath);
    const idx = file.annotations.findIndex((a) => a.id === id);
    if (idx < 0) return;
    file.annotations[idx] = { ...file.annotations[idx], ...patch, updatedAt: Date.now() };
    this.scheduleWrite(filePath);
    this.trigger("change", filePath);
  }

  async removeAnnotation(filePath: string, id: string): Promise<void> {
    const file = await this.getFile(filePath);
    file.annotations = file.annotations.filter((a) => a.id !== id);
    this.scheduleWrite(filePath);
    this.trigger("change", filePath);
  }

  /** Update baselineHash for all annotations of a file (after Diff confirm or
   * "I have checked" banner). Set `silent` to skip the `change` event — used
   * by the sidebar's auto-heal path to avoid re-entrant refreshes. */
  async confirmBaseline(filePath: string, hash: string, silent = false): Promise<void> {
    const file = await this.getFile(filePath);
    file.baselineHash = hash;
    for (const ann of file.annotations) ann.baselineHash = hash;
    this.scheduleWrite(filePath);
    if (!silent) this.trigger("change", filePath);
  }

  // ---------- disk ----------

  private scheduleWrite(filePath: string): void {
    this.pendingFlush.add(filePath);
    const old = this.writeTimers.get(filePath);
    if (old) window.clearTimeout(old);
    const t = window.setTimeout(() => this.flush(filePath), WRITE_DEBOUNCE_MS);
    this.writeTimers.set(filePath, t);
  }

  /** Force flush for one file (used on plugin unload / before export). */
  async flushAll(): Promise<void> {
    const paths = Array.from(this.pendingFlush);
    await Promise.all(paths.map((p) => this.flush(p)));
  }

  private async flush(filePath: string): Promise<void> {
    this.pendingFlush.delete(filePath);
    this.writeTimers.delete(filePath);
    const data = this.cache.get(filePath);
    if (!data) return;
    await this.writeToDisk(filePath, data);
  }

  private async loadFromDisk(filePath: string): Promise<AnnotationFile> {
    const path = sidecarPath(this.rootDir, filePath);
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) return emptyAnnotationFile(filePath);
      const raw = await adapter.read(path);
      const json = JSON.parse(raw) as AnnotationFile;
      if (!json || json.version !== FILE_VERSION || !Array.isArray(json.annotations)) {
        // Invalid or mismatched structure — start fresh but preserve any
        // valid annotations array from the old file.
        const safeAnnotations = Array.isArray(json?.annotations) ? json.annotations : [];
        return { ...emptyAnnotationFile(filePath), annotations: safeAnnotations, version: FILE_VERSION };
      }
      json.filePath = filePath;
      return json;
    } catch (e) {
      console.warn("[Promptuary] failed to load sidecar", path, e);
      return emptyAnnotationFile(filePath);
    }
  }

  private async writeToDisk(filePath: string, data: AnnotationFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    const path = sidecarPath(this.rootDir, filePath);
    const dir = path.slice(0, path.lastIndexOf("/"));
    try {
      await ensureDir(adapter, dir);
      const json = JSON.stringify(data, null, 2);
      await adapter.write(path, json);
    } catch (e) {
      console.error("[Promptuary] failed to write sidecar", path, e);
    }
  }

  // ---------- vault tracking ----------

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (!oldPath.endsWith(".md")) return;
    // Flush any pending writes for the old path before moving the sidecar,
    // otherwise the timer could fire and recreate the old file on disk.
    await this.flush(oldPath);
    const adapter = this.app.vault.adapter;
    const oldSidecar = sidecarPath(this.rootDir, oldPath);
    const newSidecar = sidecarPath(this.rootDir, file.path);
    try {
      if (await adapter.exists(oldSidecar)) {
        const raw = await adapter.read(oldSidecar);
        const data = JSON.parse(raw) as AnnotationFile;
        data.filePath = file.path;
        for (const ann of data.annotations) ann.filePath = file.path;
        // Ensure new directory structure exists
        const newDir = newSidecar.slice(0, newSidecar.lastIndexOf("/"));
        await ensureDir(adapter, newDir);
        await adapter.write(newSidecar, JSON.stringify(data, null, 2));
        await adapter.remove(oldSidecar);
        // Clean up empty ancestor directories left by the old path
        const oldDir = oldSidecar.slice(0, oldSidecar.lastIndexOf("/"));
        await removeEmptyAncestors(adapter, this.rootDir, oldDir);
      }
    } catch (e) {
      console.warn("[Promptuary] rename sidecar failed", e);
    }
    if (this.cache.has(oldPath)) {
      const data = this.cache.get(oldPath)!;
      data.filePath = file.path;
      this.cache.delete(oldPath);
      this.cache.set(file.path, data);
    }
    this.trigger("change", file.path);
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (!file.path.endsWith(".md")) return;
    // Flush any pending writes so the timer doesn't recreate the sidecar
    // after we've moved it to orphans.
    await this.flush(file.path);
    const adapter = this.app.vault.adapter;
    const sidecar = sidecarPath(this.rootDir, file.path);
    const orphans = `${this.rootDir}/orphans`;
    try {
      if (await adapter.exists(sidecar)) {
        await ensureDir(adapter, orphans);
        // Preserve the original path structure in orphans for readability:
        //   .promptuary/annotations/笔记/文档.md.json
        //   → .promptuary/annotations/orphans/笔记/文档.md.json
        const relativePath = sidecar.slice(this.rootDir.length + 1);
        const target = `${orphans}/${relativePath}`;
        const targetDir = target.slice(0, target.lastIndexOf("/"));
        await ensureDir(adapter, targetDir);
        await adapter.rename(sidecar, target);
        // Clean up empty ancestor directories left by the deleted file
        const fileDir = sidecar.slice(0, sidecar.lastIndexOf("/"));
        await removeEmptyAncestors(adapter, this.rootDir, fileDir);
      }
    } catch (e) {
      console.warn("[Promptuary] orphan sidecar move failed", e);
    }
    this.cache.delete(file.path);
    this.trigger("change", file.path);
  }

  // ---------- helpers exposed to UI ----------

  /** SHA256 of a vault file's text. */
  async fileHash(filePath: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(filePath);
    if (!(f instanceof TFile)) return "";
    const text = await this.app.vault.read(f);
    return sha256(text);
  }
}
