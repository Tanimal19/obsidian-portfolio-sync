import { Notice, Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { EMBED_LANGUAGE, renderEmbedCard } from "./embed-preview";
import { DEFAULT_SETTINGS, PortfolioSyncSettingTab, PortfolioSyncSettings, resolveRepoPath } from "./settings";
import { PortfolioSyncer, SyncError } from "./sync";
import { SyncReport } from "./types";

const AUTO_SYNC_DELAY_MS = 1500;

export default class PortfolioSyncPlugin extends Plugin {
  settings: PortfolioSyncSettings = { ...DEFAULT_SETTINGS };
  /** Serialises runs so two syncs never race on the manifest. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, () => void>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PortfolioSyncSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor(EMBED_LANGUAGE, (source, el) => renderEmbedCard(source, el));

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.enqueue((s) => s.syncFiles([file]), true);
        return true;
      },
    });
    this.addCommand({
      id: "sync-all",
      name: "Sync all published notes",
      callback: () => void this.enqueue((s) => s.syncAll(), true),
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.settings.autoSync) this.scheduleAutoSync(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.settings.autoSync && isMarkdown(file)) {
          void this.enqueue((s) => s.syncFiles([file as TFile], [oldPath]), false);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.settings.autoSync && isMarkdown(file)) {
          void this.enqueue((s) => s.syncFiles([], [file.path]), false);
        }
      }),
    );
  }

  onunload() {
    this.pending.clear();
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<PortfolioSyncSettings> | null) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private scheduleAutoSync(file: TFile) {
    let run = this.pending.get(file.path);
    if (!run) {
      run = debounce(
        () => {
          this.pending.delete(file.path);
          void this.enqueue(async (syncer) => ((await syncer.isRelevant(file)) ? syncer.syncFiles([file]) : null), false);
        },
        AUTO_SYNC_DELAY_MS,
        true,
      );
      this.pending.set(file.path, run);
    }
    run();
  }

  /** `verbose` reports even when nothing changed (manual commands). */
  private enqueue(task: (syncer: PortfolioSyncer) => Promise<SyncReport | null>, verbose: boolean) {
    const next = this.queue.then(async () => {
      try {
        const repoPath = resolveRepoPath(this.app, this.settings.repoPath);
        if (!repoPath) throw new SyncError("set the portfolio repo path in the plugin settings");
        const report = await task(new PortfolioSyncer(this.app, repoPath));
        if (report) this.notify(report, verbose);
      } catch (error) {
        const message = error instanceof SyncError ? error.message : String(error);
        if (!(error instanceof SyncError)) console.error("[portfolio-sync]", error);
        new Notice(`Portfolio sync failed: ${message}`, 8000);
      }
    });
    this.queue = next;
    return next;
  }

  private notify(report: SyncReport, verbose: boolean) {
    const { written, removed, unchanged, conflicts } = report;
    if (!verbose && written.length === 0 && removed.length === 0 && conflicts.length === 0) return;
    const summary = `Portfolio sync: ${written.length} written, ${removed.length} removed, ${unchanged} unchanged`;
    if (written.length || removed.length) console.info("[portfolio-sync]", { written, removed });
    if (conflicts.length === 0) {
      new Notice(summary);
      return;
    }
    console.warn("[portfolio-sync] conflicts", conflicts);
    const shown = conflicts.slice(0, 5).map((c) => `• ${c}`);
    if (conflicts.length > 5) shown.push(`…and ${conflicts.length - 5} more (see developer console)`);
    new Notice(`${summary}, ${conflicts.length} conflict(s):\n${shown.join("\n")}`, 15000);
  }
}

const isMarkdown = (file: TAbstractFile) => file instanceof TFile && file.extension === "md";
