# Portfolio Sync (Obsidian plugin)

One-way sync from an Obsidian vault into a portfolio repo. Desktop only.

The plugin does **no syntax conversion**. It only does what needs the vault:

- picks notes whose frontmatter has `site: <collection>`,
- copies the note verbatim to `<collection dir>/<slug>.md`, where the slug is the
  `slug:` property or else the file name normalized (lowercase, separators → `-`, CJK kept),
- copies every linked/embedded non-note file to `<attachments dir>/<collection>/<slug>/`,
- records each link's resolved target in the repo's manifest (keyed by the exact link text), so the repo-side converter doesn't need Obsidian's link resolution.

The repo is expected to live outside the vault. Set **Portfolio repo path** to an
absolute path, `~/…`, or a path relative to the vault root (e.g. `../portfolio`).

Paths and frontmatter keys come from `obsidian-sync.json` in the repo, so the
converter and the plugin can't drift. The converter and the syntax reference
live in the portfolio repo under `tools/obsidian-sync/`.

## Safety

The manifest stores a sha256 of every file the plugin wrote.

- It never overwrites or deletes a file it didn't write.
- It never overwrites or deletes a file that was edited in the repo since the last sync. It reports a conflict and skips that note instead.
- Unpublishing a note (removing `site:`), renaming its slug or deleting it removes its old output on the next sync.
- If a note fails to plan (e.g. invalid slug), its previously synced files are kept.
- It never runs git.

## Commands

- **Sync current note**
- **Sync all published notes**: also cleans up outputs of notes that are no longer published.

The **Sync on change** setting re-syncs a note about 1.5 s after it changes, is renamed or is deleted. Attachment edits alone aren't detected; run *Sync all*.

## Develop

```sh
pnpm install
pnpm dev     # watch build -> main.js
pnpm build   # typecheck + production build
```

The test vault loads this folder through a symlink:
`dev/.obsidian/plugins/portfolio-sync -> obsidian-portfolio-sync`.
