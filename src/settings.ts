import { App, FileSystemAdapter, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { existsSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import type PortfolioSyncPlugin from "./main";
import { CONFIG_FILE } from "./types";

export interface PortfolioSyncSettings {
  /** Portfolio repo (the folder containing obsidian-sync.json): absolute, `~/…`, or relative to the vault root. */
  repoPath: string;
  autoSync: boolean;
  /** Vault folders whose notes are never synced. */
  ignoredFolders: string[];
}

export const DEFAULT_SETTINGS: PortfolioSyncSettings = {
  repoPath: "",
  autoSync: false,
  ignoredFolders: [],
};

export function parseFolderList(raw: string): string[] {
  const folders = raw
    .split("\n")
    .map((line) => normalizePath(line.trim()).replace(/^\/+|\/+$/g, ""))
    .filter((folder) => folder && folder !== ".");
  return [...new Set(folders)];
}

export const isInFolders = (filePath: string, folders: string[]) =>
  folders.some((folder) => filePath === folder || filePath.startsWith(folder + "/"));

/** Returns null when the setting is empty. */
export function resolveRepoPath(app: App, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value === "~" || value.startsWith("~/")) return path.join(homedir(), value.slice(1));
  if (path.isAbsolute(value)) return path.normalize(value);
  const adapter = app.vault.adapter;
  const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : process.cwd();
  return path.resolve(vaultRoot, value);
}

export class PortfolioSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PortfolioSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const status = () => {
      const resolved = resolveRepoPath(this.app, this.plugin.settings.repoPath);
      if (!resolved) {
        return "The repo can live anywhere on disk. Enter an absolute path, ~/…, or a path relative to this vault (e.g. ../portfolio).";
      }
      return existsSync(path.join(resolved, CONFIG_FILE))
        ? `✓ ${path.join(resolved, CONFIG_FILE)}`
        : `✗ no ${CONFIG_FILE} in ${resolved}`;
    };

    const repo = new Setting(containerEl)
      .setName("Portfolio repo path")
      .setDesc(status())
      .addText((text) =>
        text
          .setPlaceholder("~/code/portfolio")
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value.trim();
            await this.plugin.saveSettings();
            repo.setDesc(status());
          }),
      );

    new Setting(containerEl)
      .setName("Sync on change")
      .setDesc("Re-sync a published note shortly after it changes, is renamed or is deleted.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Ignored folders")
      .setDesc(
        "One vault folder per line (e.g. Template). Notes inside them are never synced, even with a site: property. Run \"Sync all published notes\" after changing this to remove their previous output.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Template")
          .setValue(this.plugin.settings.ignoredFolders.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignoredFolders = parseFolderList(value);
            await this.plugin.saveSettings();
          }),
      );
  }
}
