import { parseYaml } from "obsidian";

export const EMBED_LANGUAGE = "svelte-embed";

/**
 * Obsidian can't run the Svelte component, so a `svelte-embed` block renders
 * as a card showing what the site will insert. Validation against the
 * component registry happens in the portfolio build, not here.
 */
export function renderEmbedCard(source: string, el: HTMLElement): void {
  const card = el.createDiv({ cls: "portfolio-sync-embed" });
  let spec: unknown;
  try {
    spec = parseYaml(source);
  } catch (error) {
    renderError(card, `Invalid YAML: ${(error as Error).message}`);
    return;
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    renderError(card, 'Expected a mapping with at least "id".');
    return;
  }
  const { id, props, fallback } = spec as Record<string, unknown>;
  if (typeof id !== "string") {
    renderError(card, '"id" must be a string.');
    return;
  }

  const header = card.createDiv({ cls: "portfolio-sync-embed-header" });
  header.createSpan({ cls: "portfolio-sync-embed-label", text: "Svelte embed" });
  header.createEl("code", { text: id });

  if (props && typeof props === "object" && !Array.isArray(props)) {
    const list = card.createEl("dl", { cls: "portfolio-sync-embed-props" });
    for (const [key, value] of Object.entries(props)) {
      list.createEl("dt", { text: key });
      list.createEl("dd", { text: typeof value === "string" ? value : JSON.stringify(value) });
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    card.createEl("p", { cls: "portfolio-sync-embed-fallback", text: fallback });
  }
}

function renderError(card: HTMLElement, message: string): void {
  card.addClass("is-error");
  card.createDiv({ cls: "portfolio-sync-embed-header" }).createSpan({ text: "Svelte embed" });
  card.createEl("p", { text: message });
}
