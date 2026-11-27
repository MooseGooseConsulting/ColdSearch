import { parse, type DefaultTreeAdapterTypes as Dom } from "parse5";

/**
 * Reads one HTML document: its title, links, how much visible text it has,
 * and its content as markdown or plain text. Parsing is parse5's (the HTML
 * standard's algorithm, so unclosed and misnested tags come out as a browser
 * would see them); everything after the parse is here.
 *
 * Contract: markdown() and text() keep headings, paragraphs, links, lists,
 * code blocks, block quotes and data tables, and drop scripts, styles,
 * navigation, form controls and hidden elements. When the document has
 * exactly one <main> (or role="main"), only that element is converted.
 * `links` always covers the whole document, navigation included, because map
 * and crawl follow them.
 */
export interface HtmlPage {
  title: string;
  /** Absolute http(s) link targets in document order, fragment removed, no duplicates. */
  links: string[];
  /** Characters of visible text in the body, navigation included. */
  textChars: number;
  /** An application root element (#root, #__next, #app, #__nuxt) with nothing in it. */
  emptyAppRoot: boolean;
  /** A <noscript> block that mentions JavaScript. */
  noscriptAsksForJavascript: boolean;
  markdown(): string;
  text(): string;
}

type Element = Dom.Element;
type ParentNode = Dom.ParentNode;

const isElement = (node: Dom.Node): node is Element => "tagName" in node;
const isText = (node: Dom.Node): node is Dom.TextNode => node.nodeName === "#text";

/** Never content, whatever is inside. */
const DROPPED = new Set([
  "script", "style", "noscript", "template", "nav", "svg", "canvas", "iframe", "object", "embed",
  "select", "option", "datalist", "button", "input", "textarea", "dialog", "head",
]);
/** Elements whose text is not visible to a reader, for the visible-text count. */
const INVISIBLE = new Set(["script", "style", "noscript", "template", "svg", "head"]);
/** Elements that start a new block. Anything else is inline. */
const BLOCK = new Set([
  "html", "body", "main", "article", "section", "div", "header", "footer", "aside", "figure", "figcaption",
  "details", "summary", "address", "fieldset", "form", "center", "hgroup", "dl", "dt", "dd", "li", "menu",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "ul", "ol", "blockquote", "hr",
]);
const APP_ROOT_IDS = new Set(["root", "__next", "app", "__nuxt"]);
/** Nesting past this is flattened to text instead of recursed into. */
const MAX_DEPTH = 256;

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function dropped(element: Element): boolean {
  return (
    DROPPED.has(element.tagName) ||
    attr(element, "hidden") !== undefined ||
    attr(element, "aria-hidden") === "true" ||
    attr(element, "role") === "navigation"
  );
}

/** Every descendant element, document order, without recursion. `skip` prunes a subtree. */
function* descendants(root: ParentNode, skip?: (element: Element) => boolean): Generator<Element> {
  const stack: Dom.Node[] = [...root.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isElement(node) || skip?.(node)) continue;
    yield node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
}

/** Text of a subtree exactly as written, with <br> as a newline. */
function rawText(root: ParentNode, skip?: (element: Element) => boolean): string {
  let out = "";
  const stack: Dom.Node[] = [...root.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isText(node)) out += node.value;
    if (!isElement(node) || skip?.(node)) continue;
    if (node.tagName === "br") out += "\n";
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Tidy an assembled run of inline text: no spaces around line breaks, no runs of spaces. */
function tidyInline(run: string): string {
  return run.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/** Put markers around the non-blank core of `inner`, keeping its outer spaces outside them. */
function wrap(inner: string, around: (core: string) => string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return match[2] ? `${match[1]}${around(match[2])}${match[3]}` : inner;
}

function fence(code: string, language: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${code}\n${marks}`;
}

class Renderer {
  private depth = 0;

  constructor(
    private readonly base: URL,
    /** The document's own address without a fragment, to recognise links that stay on the page. */
    private readonly page: string,
    /** Plain text: the same blocks without markdown syntax. */
    private readonly plain: boolean
  ) {}

  private href(element: Element, name: string): string | undefined {
    const value = attr(element, name)?.trim();
    if (!value) return undefined;
    try {
      const url = new URL(value, this.base);
      return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : undefined;
    } catch {
      return undefined;
    }
  }

  private escape(text: string): string {
    const collapsed = text.replace(/\s+/g, " ");
    // Only what would change meaning: emphasis, code spans, escapes, and "<" that would open a tag.
    return this.plain ? collapsed : collapsed.replace(/[\\`*]/g, "\\$&").replace(/<(?=[a-zA-Z/!])/g, "\\<");
  }

  private inlineChildren(parent: ParentNode): string {
    if (this.depth >= MAX_DEPTH) return this.escape(rawText(parent, dropped));
    this.depth++;
    let out = "";
    for (const child of parent.childNodes) {
      if (isText(child)) out += this.escape(child.value);
      else if (isElement(child) && !dropped(child)) {
        // A block inside inline content (a card wrapped in a link) is flattened onto the line.
        out += BLOCK.has(child.tagName) ? ` ${this.inline(child)} ` : this.inline(child);
      }
    }
    this.depth--;
    return out;
  }

  private inline(element: Element): string {
    switch (element.tagName) {
      case "br":
        return "\n";
      case "a": {
        const inner = this.inlineChildren(element);
        const href = this.href(element, "href");
        if (this.plain || !href) return inner;
        // A link to another spot on this page leads nowhere new: keep its words, and
        // drop it entirely when it is only a heading's permalink mark.
        if (href.split("#")[0] === this.page) return /^[¶#§🔗]?$/u.test(inner.trim()) ? "" : inner;
        return wrap(inner, (core) => `[${core.replace(/\n/g, " ")}](${href})`);
      }
      case "strong":
      case "b":
        return this.plain ? this.inlineChildren(element) : wrap(this.inlineChildren(element), (core) => `**${core}**`);
      case "em":
      case "i":
        return this.plain ? this.inlineChildren(element) : wrap(this.inlineChildren(element), (core) => `*${core}*`);
      case "del":
      case "s":
      case "strike":
        return this.plain ? this.inlineChildren(element) : wrap(this.inlineChildren(element), (core) => `~~${core}~~`);
      case "code":
      case "kbd":
      case "samp":
      case "tt":
      case "pre": {
        const code = collapse(rawText(element));
        if (this.plain || !code) return code;
        const marks = code.includes("`") ? "``" : "`";
        return marks === "``" ? `${marks} ${code} ${marks}` : `${marks}${code}${marks}`;
      }
      case "img": {
        // Only a described image at a fetchable address is content; inline data and spacers are not.
        const alt = collapse(attr(element, "alt") ?? "");
        const src = this.href(element, "src");
        return !this.plain && alt && src?.startsWith("http") ? `![${this.escape(alt)}](${src})` : "";
      }
      default:
        return this.inlineChildren(element);
    }
  }

  /** The blocks a parent's children make: runs of inline content become paragraphs. */
  blocks(parent: ParentNode): string[] {
    if (this.depth >= MAX_DEPTH) {
      const flat = this.escape(rawText(parent, dropped)).trim();
      return flat ? [flat] : [];
    }
    this.depth++;
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const paragraph = tidyInline(run);
      run = "";
      if (!paragraph) return;
      // A paragraph that happens to start like a heading, list item or quote must not become one.
      out.push(this.plain ? paragraph : paragraph.replace(/^(#{1,6} |[-+>] |\d+[.)] )/, "\\$1"));
    };
    for (const child of parent.childNodes) {
      if (isText(child)) run += this.escape(child.value);
      else if (isElement(child) && !dropped(child)) {
        if (BLOCK.has(child.tagName)) {
          flush();
          out.push(...this.block(child));
        } else {
          run += this.inline(child);
        }
      }
    }
    flush();
    this.depth--;
    return out;
  }

  private block(element: Element): string[] {
    const tag = element.tagName;
    if (/^h[1-6]$/.test(tag)) {
      const heading = tidyInline(this.inlineChildren(element)).replace(/\n/g, " ");
      if (!heading) return [];
      return [this.plain ? heading : `${"#".repeat(Number(tag[1]))} ${heading}`];
    }
    switch (tag) {
      case "pre": {
        const code = rawText(element).replace(/^\n/, "").replace(/\s+$/, "");
        if (!code.trim()) return [];
        if (this.plain) return [code];
        const classes = [element, ...descendants(element)].map((node) => attr(node, "class") ?? "").join(" ");
        const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1] ?? "";
        return [fence(code, language)];
      }
      case "ul":
      case "menu":
      case "ol":
        return this.list(element, tag === "ol");
      case "blockquote": {
        const inner = this.blocks(element).join("\n\n");
        if (!inner) return [];
        return [this.plain ? inner : inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")];
      }
      case "table":
        return this.table(element);
      case "hr":
        return this.plain ? [] : ["---"];
      case "dt": {
        const term = tidyInline(this.inlineChildren(element)).replace(/\n/g, " ");
        if (!term) return [];
        return [this.plain ? term : `**${term}**`];
      }
      default:
        return this.blocks(element);
    }
  }

  private list(element: Element, ordered: boolean): string[] {
    let number = ordered ? Number.parseInt(attr(element, "start") ?? "1", 10) || 1 : 0;
    const items: string[] = [];
    for (const child of element.childNodes) {
      if (!isElement(child) || dropped(child)) continue;
      const blocks = child.tagName === "li" ? this.blocks(child) : this.block(child);
      if (blocks.length === 0) continue;
      if (child.tagName !== "li") {
        // A list nested directly inside a list, without its own <li>.
        items.push(blocks.join("\n").split("\n").map((line) => `  ${line}`).join("\n"));
        continue;
      }
      const marker = ordered ? `${number++}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const paragraphs = child.childNodes.filter((node) => isElement(node) && node.tagName === "p").length;
      const body = blocks.join(paragraphs > 1 ? "\n\n" : "\n");
      items.push(body.split("\n").map((line, index) => (index === 0 ? marker + line : line ? pad + line : "")).join("\n"));
    }
    return items.length > 0 ? [items.join("\n")] : [];
  }

  private table(element: Element): string[] {
    const isNested = (node: Element) => node.tagName === "table";
    const rows = [...descendants(element, isNested)].filter((node) => node.tagName === "tr");
    const grid = rows.map((row) => {
      const cells: string[] = [];
      for (const cell of row.childNodes) {
        if (!isElement(cell) || (cell.tagName !== "td" && cell.tagName !== "th")) continue;
        const text = tidyInline(this.inlineChildren(cell)).replace(/\n/g, " ");
        cells.push(this.plain ? text : text.replace(/\|/g, "\\|"));
        const span = Math.min(Number.parseInt(attr(cell, "colspan") ?? "1", 10) || 1, 50);
        for (let extra = 1; extra < span; extra++) cells.push("");
      }
      return cells;
    }).filter((cells) => cells.length > 0);
    const width = Math.max(0, ...grid.map((cells) => cells.length));
    const hasNestedTable = [...descendants(element)].some(isNested);
    // One column, or tables inside tables, is page layout: read the cells as ordinary content.
    if (width < 2 || hasNestedTable) return this.blocks(element);

    const caption = element.childNodes.find((node): node is Element => isElement(node) && node.tagName === "caption");
    const lead = caption ? this.blocks(caption) : [];
    const padded = grid.map((cells) => [...cells, ...Array<string>(width - cells.length).fill("")]);
    if (this.plain) return [...lead, padded.map((cells) => cells.join("\t")).join("\n")];
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const [header, ...body] = padded;
    return [...lead, [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n")];
  }
}

function findFirst(root: ParentNode, tag: string): Element | undefined {
  for (const element of descendants(root)) if (element.tagName === tag) return element;
  return undefined;
}

/**
 * Parse `html` as the document found at `pageUrl`. Relative links are
 * resolved against the document's <base href> when it has one, otherwise
 * against `pageUrl`. Never throws on malformed markup.
 */
export function readHtml(html: string, pageUrl: string): HtmlPage {
  const document = parse(html);
  const body = findFirst(document, "body") ?? document;

  let base = new URL(pageUrl);
  const baseHref = [...descendants(document)].find((element) => element.tagName === "base" && attr(element, "href"));
  if (baseHref) {
    try {
      const candidate = new URL(attr(baseHref, "href")!, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") base = candidate;
    } catch {
      // An unusable <base> is ignored, as a browser would.
    }
  }

  const links: string[] = [];
  const seen = new Set<string>();
  let emptyAppRoot = false;
  let noscriptAsksForJavascript = false;
  let ogTitle = "";
  for (const element of descendants(document)) {
    if (element.tagName === "a") {
      const href = attr(element, "href")?.trim();
      if (!href) continue;
      try {
        const url = new URL(href, base);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        url.hash = "";
        if (!seen.has(url.href)) {
          seen.add(url.href);
          links.push(url.href);
        }
      } catch {
        // Not a URL; not a link.
      }
    } else if (element.tagName === "noscript") {
      if (/javascript/i.test(rawText(element))) noscriptAsksForJavascript = true;
    } else if (element.tagName === "meta" && attr(element, "property") === "og:title") {
      ogTitle ||= collapse(attr(element, "content") ?? "");
    } else if (APP_ROOT_IDS.has(attr(element, "id") ?? "") && !collapse(rawText(element)) && !element.childNodes.some(isElement)) {
      emptyAppRoot = true;
    }
  }

  const titleElement = findFirst(document, "title");
  const heading = findFirst(body, "h1");
  const title =
    (titleElement && collapse(rawText(titleElement))) || ogTitle || (heading ? collapse(rawText(heading, dropped)) : "");

  const mains = [...descendants(body, dropped)].filter(
    (element) => element.tagName === "main" || attr(element, "role") === "main"
  );
  const root: ParentNode = mains.length === 1 ? mains[0] : body;
  const page = new URL(pageUrl);
  page.hash = "";
  const render = (plain: boolean) => new Renderer(base, page.href, plain).blocks(root).join("\n\n");

  return {
    title,
    links,
    textChars: collapse(rawText(body, (element) => INVISIBLE.has(element.tagName))).length,
    emptyAppRoot,
    noscriptAsksForJavascript,
    markdown: () => render(false),
    text: () => render(true),
  };
}
