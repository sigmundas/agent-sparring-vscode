import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderReportMarkdown } from "../core/reportMarkdown";

describe("rendering a reviewer's report for Read feedback", () => {
  it("renders paragraphs, a heading and inline emphasis", () => {
    const html = renderReportMarkdown(["## Findings", "", "The **boundary check** is `off by one` and *must* be fixed."].join("\n"));
    assert.equal(html, '<p class="reportheading"><strong>Findings</strong></p>\n<p>The <strong>boundary check</strong> is <code>off by one</code> and <em>must</em> be fixed.</p>');
  });

  it("renders bullet and numbered lists, each their own list", () => {
    const html = renderReportMarkdown(["- First point", "- Second point", "", "1. Step one", "2. Step two"].join("\n"));
    assert.equal(html, "<ul><li>First point</li><li>Second point</li></ul>\n<ol><li>Step one</li><li>Step two</li></ol>");
  });

  it("renders a fenced code block verbatim, without inline formatting inside it", () => {
    const html = renderReportMarkdown(["Before.", "", "```", "if (*x) { return; }", "```", "", "After."].join("\n"));
    assert.equal(html, "<p>Before.</p>\n<pre><code>if (*x) { return; }</code></pre>\n<p>After.</p>");
  });

  it("escapes HTML in the source text so a report can never inject markup", () => {
    const html = renderReportMarkdown("A finding: <script>alert(1)</script> in the handler.");
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
  });

  it("joins wrapped lines of one paragraph with a single space", () => {
    const html = renderReportMarkdown(["This finding spans", "two source lines as one paragraph."].join("\n"));
    assert.equal(html, "<p>This finding spans two source lines as one paragraph.</p>");
  });
});
