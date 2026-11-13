import { App, TFile, parseLinktext } from "obsidian";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { CONFIG_FILE, ManifestEntry, RefTarget, SyncConfig, SyncManifest, SyncReport } from "./types";

const SLUG_RE = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u;

/** "LLM-as-a-judge in Code Review" -> "llm-as-a-judge-in-code-review"; CJK is kept as-is. */
export const slugify = (title: string) =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

export class SyncError extends Error {}

type Scope = { kind: "all" } | { kind: "files"; files: TFile[]; removedSources: string[] };

interface PlannedFile {
  repoPath: string;
  hash: string;
  data: string | ArrayBuffer;
}

interface PlannedNote {
  source: string;
  entry: ManifestEntry;
  files: PlannedFile[];
}

const sha256 = (data: string | ArrayBuffer | Uint8Array) =>
  createHash("sha256")
    .update(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    .digest("hex");

const toPosix = (p: string) => p.split(path.sep).join("/");
const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, "");

/**
 * One-way vault -> repo sync. The manifest records every file this plugin
 * wrote together with its hash, which lets it (a) never touch files it did
 * not write and (b) refuse to overwrite or delete files edited in the repo.
 */
export class PortfolioSyncer {
  constructor(
    private readonly app: App,
    private readonly repoPath: string,
  ) {}

  syncAll(): Promise<SyncReport> {
    return this.run({ kind: "all" });
  }

  syncFiles(files: TFile[], removedSources: string[] = []): Promise<SyncReport> {
    return this.run({ kind: "files", files, removedSources });
  }

  /** True if the note is published or was published before (so a sync may need to clean up). */
  async isRelevant(file: TFile): Promise<boolean> {
    const config = await this.loadConfig();
    if (this.collectionOf(file, config)) return true;
    const manifest = await this.loadManifest(config);
    return Object.values(manifest.entries).some((e) => e.source === file.path);
  }

  private async run(scope: Scope): Promise<SyncReport> {
    const config = await this.loadConfig();
    const manifest = await this.loadManifest(config);
    const report: SyncReport = { written: [], removed: [], unchanged: 0, conflicts: [] };

    const candidates = scope.kind === "all" ? this.app.vault.getMarkdownFiles() : scope.files;
    const inScope = (source: string) =>
      scope.kind === "all" ||
      scope.files.some((f) => f.path === source) ||
      scope.removedSources.includes(source);

    const planned: PlannedNote[] = [];
    // Notes that fail planning or are skipped keep their previously synced files.
    const skippedSources = new Set<string>();
    for (const file of candidates) {
      try {
        const note = await this.planNote(file, config);
        if (note) planned.push(note);
      } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        report.conflicts.push(`${file.path}: ${error.message}`);
        skippedSources.add(file.path);
      }
    }

    const accepted = await this.acceptNotes(planned, this.ownerIndex(manifest), inScope, report);
    for (const note of planned) if (!accepted.includes(note)) skippedSources.add(note.source);

    const nextEntries: Record<string, ManifestEntry> = {};
    for (const [output, entry] of Object.entries(manifest.entries)) {
      if (!inScope(entry.source) || skippedSources.has(entry.source)) nextEntries[output] = entry;
    }

    for (const note of accepted) {
      for (const file of note.files) {
        if (await this.writeIfChanged(file)) report.written.push(file.repoPath);
        else report.unchanged++;
      }
      nextEntries[this.outputPath(note.entry, config)] = note.entry;
    }

    await this.removeStale(manifest, nextEntries, config, report);
    await this.writeManifest(config, { version: 1, entries: nextEntries });
    return report;
  }

  private collectionOf(file: TFile, config: SyncConfig): string | null {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[config.frontmatter.collection];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private outputPath(entry: ManifestEntry, config: SyncConfig): string {
    return `${trimSlashes(config.collections[entry.collection].dir)}/${entry.slug}.md`;
  }

  private async planNote(file: TFile, config: SyncConfig): Promise<PlannedNote | null> {
    const collection = this.collectionOf(file, config);
    if (!collection) return null;
    if (!config.collections[collection]) {
      throw new SyncError(
        `unknown ${config.frontmatter.collection} "${collection}" (expected one of: ${Object.keys(config.collections).join(", ")})`,
      );
    }
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const explicitSlug = frontmatter[config.frontmatter.slug];
    const slug = explicitSlug != null ? String(explicitSlug).trim() : slugify(file.basename);
    if (!SLUG_RE.test(slug)) {
      const source = explicitSlug != null ? `"${config.frontmatter.slug}: ${slug}"` : `slug "${slug}" derived from the file name`;
      throw new SyncError(`${source} is invalid (letters, digits, - and _ only); set "${config.frontmatter.slug}:" in the frontmatter`);
    }

    const content = await this.app.vault.read(file);
    const refs: Record<string, RefTarget> = {};
    const attachments: ManifestEntry["attachments"] = {};
    const files: PlannedFile[] = [];
    const attachmentDir = `${trimSlashes(config.attachments.dir)}/${collection}/${slug}`;
    const usedNames = new Map<string, string>();

    const cache = this.app.metadataCache.getFileCache(file);
    for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
      const { path: linkpath } = parseLinktext(ref.link);
      const dest = linkpath === "" ? file : this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (!dest) {
        refs[ref.original] = { kind: "missing" };
      } else if (dest.extension === "md") {
        refs[ref.original] = { kind: "note", source: dest.path };
      } else {
        const name = this.uniqueName(dest, usedNames);
        const repoPath = `${attachmentDir}/${name}`;
        if (!attachments[repoPath]) {
          const data = await this.app.vault.readBinary(dest);
          const hash = sha256(data);
          attachments[repoPath] = { source: dest.path, hash };
          files.push({ repoPath, hash, data });
        }
        refs[ref.original] = { kind: "file", path: repoPath };
      }
    }

    const hash = sha256(content);
    const entry: ManifestEntry = { source: file.path, collection, slug, title: file.basename, hash, refs, attachments };
    files.unshift({ repoPath: this.outputPath(entry, config), hash, data: content });
    return { source: file.path, entry, files };
  }

  private uniqueName(dest: TFile, used: Map<string, string>): string {
    let name = dest.name;
    const owner = used.get(name);
    if (owner !== undefined && owner !== dest.path) {
      name = `${dest.basename}-${sha256(dest.path).slice(0, 6)}.${dest.extension}`;
    }
    used.set(name, dest.path);
    return name;
  }

  /** Maps every repo path the manifest owns to its recorded hash. */
  private ownerIndex(manifest: SyncManifest): Map<string, { source: string; hash: string }> {
    const owners = new Map<string, { source: string; hash: string }>();
    for (const [output, entry] of Object.entries(manifest.entries)) {
      owners.set(output, { source: entry.source, hash: entry.hash });
      for (const [repoPath, a] of Object.entries(entry.attachments)) owners.set(repoPath, { source: entry.source, hash: a.hash });
    }
    return owners;
  }

  private async acceptNotes(
    planned: PlannedNote[],
    owners: Map<string, { source: string; hash: string }>,
    inScope: (source: string) => boolean,
    report: SyncReport,
  ): Promise<PlannedNote[]> {
    const claimants = new Map<string, Set<string>>();
    for (const note of planned) {
      for (const file of note.files) {
        claimants.set(file.repoPath, (claimants.get(file.repoPath) ?? new Set()).add(note.source));
      }
    }

    const accepted: PlannedNote[] = [];
    for (const note of planned) {
      const problems: string[] = [];
      for (const file of note.files) {
        const others = [...(claimants.get(file.repoPath) ?? [])].filter((s) => s !== note.source);
        if (others.length) {
          problems.push(`${file.repoPath} is also produced by ${others.join(", ")}`);
          continue;
        }
        const owner = owners.get(file.repoPath);
        if (owner && owner.source !== note.source && !inScope(owner.source)) {
          problems.push(`${file.repoPath} belongs to ${owner.source}`);
          continue;
        }
        const disk = await this.readHash(file.repoPath);
        if (disk === null) continue;
        if (!owner) problems.push(`${file.repoPath} exists but was not written by this plugin`);
        else if (disk !== owner.hash && disk !== file.hash) problems.push(`${file.repoPath} was edited in the repo`);
      }
      if (problems.length) report.conflicts.push(`${note.source}: skipped (${problems.join("; ")})`);
      else accepted.push(note);
    }
    return accepted;
  }

  private async removeStale(
    previous: SyncManifest,
    next: Record<string, ManifestEntry>,
    config: SyncConfig,
    report: SyncReport,
  ): Promise<void> {
    const keep = new Set<string>();
    for (const [output, entry] of Object.entries(next)) {
      keep.add(output);
      for (const repoPath of Object.keys(entry.attachments)) keep.add(repoPath);
    }
    for (const [output, entry] of Object.entries(previous.entries)) {
      const owned: [string, string][] = [
        [output, entry.hash],
        ...Object.entries(entry.attachments).map(([p, a]): [string, string] => [p, a.hash]),
      ];
      for (const [repoPath, hash] of owned) {
        if (keep.has(repoPath)) continue;
        const disk = await this.readHash(repoPath);
        if (disk === null) continue;
        if (disk !== hash) {
          report.conflicts.push(`${repoPath} is no longer synced but was edited in the repo; left in place`);
          continue;
        }
        await fs.unlink(this.resolve(repoPath));
        await this.pruneEmptyDirs(path.dirname(repoPath), trimSlashes(config.attachments.dir));
        report.removed.push(repoPath);
      }
    }
  }

  private async pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
    for (let current = toPosix(dir); current.startsWith(stopAt + "/"); current = path.posix.dirname(current)) {
      const abs = this.resolve(current);
      const entries = await fs.readdir(abs).catch(() => null);
      if (!entries || entries.some((e) => e !== ".DS_Store")) return;
      await fs.rm(abs, { recursive: true });
    }
  }

  private async writeIfChanged(file: PlannedFile): Promise<boolean> {
    if ((await this.readHash(file.repoPath)) === file.hash) return false;
    await this.writeAtomic(file.repoPath, typeof file.data === "string" ? file.data : new Uint8Array(file.data));
    return true;
  }

  private async writeAtomic(repoPath: string, data: string | Uint8Array): Promise<void> {
    const abs = this.resolve(repoPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, abs);
  }

  private async readHash(repoPath: string): Promise<string | null> {
    try {
      return sha256(await fs.readFile(this.resolve(repoPath)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private resolve(repoPath: string): string {
    const root = path.resolve(this.repoPath);
    const abs = path.resolve(root, repoPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new SyncError(`${repoPath} escapes the repo`);
    return abs;
  }

  async loadConfig(): Promise<SyncConfig> {
    if (!this.repoPath) throw new SyncError("set the portfolio repo path in the plugin settings");
    let raw: string;
    try {
      raw = await fs.readFile(this.resolve(CONFIG_FILE), "utf8");
    } catch {
      throw new SyncError(`cannot read ${path.join(this.repoPath, CONFIG_FILE)}`);
    }
    const config = JSON.parse(raw) as SyncConfig;
    if (!config.manifest || !config.frontmatter || !config.collections || !config.attachments) {
      throw new SyncError(`${CONFIG_FILE} is missing manifest, frontmatter, collections or attachments`);
    }
    return config;
  }

  private async loadManifest(config: SyncConfig): Promise<SyncManifest> {
    try {
      const manifest = JSON.parse(await fs.readFile(this.resolve(config.manifest), "utf8")) as SyncManifest;
      return { version: 1, entries: manifest.entries ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw new SyncError(`cannot parse ${config.manifest}: ${(error as Error).message}`);
    }
  }

  private async writeManifest(config: SyncConfig, manifest: SyncManifest): Promise<void> {
    const sorted: SyncManifest = { version: 1, entries: {} };
    for (const key of Object.keys(manifest.entries).sort()) sorted.entries[key] = manifest.entries[key];
    const text = JSON.stringify(sorted, null, 2) + "\n";
    if ((await this.readHash(config.manifest)) === sha256(text)) return;
    await this.writeAtomic(config.manifest, text);
  }
}
