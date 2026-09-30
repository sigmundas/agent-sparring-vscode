/**
 * A small, deliberately limited Markdown-to-HTML renderer for one thing: the
 * reviewer's own written report (`SparringOutcome.findings`, the `## Finding
 * / discussion` body of sparring.md) shown inline under "Read feedback".
 *
 * This is not a general Markdown engine. It covers exactly the shapes a
 * reviewer's freeform prose actually uses -- paragraphs, headings, bullet
 * and numbered lists, fenced code, and inline bold/italic/code -- the same
 * subset `brief.ts` and `planAssociation.ts` already assume elsewhere in
 * this codebase. Anything else renders as an escaped paragraph rather than
 * guessing at a construct it does not recognize.
 *
 * All text is HTML-escaped before any tag is added, so the report can never
 * inject markup into the page it is shown on.
 *
 * No dependency on the vscode API.
 */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

const FENCE_RE = /^\s*(```|~~~)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

/** Bold, italic and inline code within one already-escaped line. */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "<em>$1</em>");
}

/** The reviewer's report, rendered as HTML for inline display under "Read feedback". */
export function renderReportMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let fence: { lang: string; lines: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("")}</${list.tag}>`);
      list = undefined;
    }
  };

  for (const raw of lines) {
    if (fence) {
      if (FENCE_RE.test(raw)) {
        out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
        fence = undefined;
      } else {
        fence.lines.push(raw);
      }
      continue;
    }
    const fenceOpen = FENCE_RE.exec(raw);
    if (fenceOpen) {
      flushParagraph();
      flushList();
      fence = { lang: fenceOpen[2].trim(), lines: [] };
      continue;
    }
    if (!raw.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<p class="reportheading"><strong>${renderInline(escapeHtml(heading[2]))}</strong></p>`);
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (bullet) {
      flushParagraph();
      if (list && list.tag !== "ul") {
        flushList();
      }
      list = list ?? { tag: "ul", items: [] };
      list.items.push(bullet[1]);
      continue;
    }
    const numbered = NUMBERED_RE.exec(raw);
    if (numbered) {
      flushParagraph();
      if (list && list.tag !== "ol") {
        flushList();
      }
      list = list ?? { tag: "ol", items: [] };
      list.items.push(numbered[1]);
      continue;
    }
    flushList();
    paragraph.push(raw.trim());
  }
  if (fence) {
    // An unterminated fence still shows its content rather than swallowing it.
    out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}
