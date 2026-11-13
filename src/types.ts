// Mirrors portfolio/tools/obsidian-sync/config.js; both sides read the same JSON files.

export const CONFIG_FILE = "obsidian-sync.json";

export interface SyncConfig {
  manifest: string;
  frontmatter: { collection: string; slug: string };
  collections: Record<string, { dir: string; url: string }>;
  attachments: { dir: string; url: string };
  embeds: { registry: string };
}

export type RefTarget = { kind: "note"; source: string } | { kind: "file"; path: string } | { kind: "missing" };

export interface ManifestEntry {
  /** Vault path of the note. */
  source: string;
  collection: string;
  slug: string;
  /** Vault basename, used by the converter when frontmatter has no title. */
  title: string;
  /** sha256 of the file as written; a mismatch on disk means it was edited in the repo. */
  hash: string;
  /** Keyed by the exact source text of the link/embed (`Reference.original`). */
  refs: Record<string, RefTarget>;
  /** Keyed by repo-relative path. */
  attachments: Record<string, { source: string; hash: string }>;
}

export interface SyncManifest {
  version: 1;
  /** Keyed by repo-relative output path. */
  entries: Record<string, ManifestEntry>;
}

export interface SyncReport {
  written: string[];
  removed: string[];
  unchanged: number;
  /** Problems that skipped a note or left a file in place. */
  conflicts: string[];
}
