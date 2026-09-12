/**
 * Pure HTML renderer for the Run Overview webview. Every dynamic string is
 * escaped; no filesystem paths, session ids beyond their shortened form, or
 * secrets are placed in the document. The only script is a nonce'd
 * click-to-postMessage shim for the action buttons.
 */

import type { ActorCard, OverviewModel, TimelineItem } from "./overviewModel";

export type OverviewAction = "openHandoff" | "openSparring" | "openBrief" | "openPlan" | "openDiff" | "showLog" | "selectRun" | "runPlan";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export function renderOverviewHtml(model: OverviewModel, nonce: string, cspSource: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Sparring</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${renderBody(model)}
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function renderBody(model: OverviewModel): string {
  if (model.kind === "empty") {
    return `<h1>Agent Sparring</h1>
<p class="muted">No recorded plan run or stage in this workspace.</p>
<div class="actions">${button("runPlan", "Run plan…")}${button("showLog", "Show log")}</div>`;
  }
  if (model.kind === "ambiguous") {
    return `<h1>Agent Sparring</h1>
<p>${escapeHtml(model.title)}:</p>
<ul>${(model.choices ?? []).map((choice) => `<li>${escapeHtml(choice)}</li>`).join("")}</ul>
<div class="actions">${button("selectRun", "Select run…")}${button("showLog", "Show log")}</div>`;
  }

  const parts: string[] = [];
  parts.push(`<header><h1>Agent Sparring</h1><span class="run muted" title="${escapeHtml(model.title)}">${escapeHtml(model.title)}</span></header>`);
  if (model.banner) {
    parts.push(`<div class="banner ${model.banner.kind}">${escapeHtml(model.banner.text)}</div>`);
  }
  if (model.timeline && model.timeline.length > 0) {
    parts.push(renderTimeline(model.timeline));
  } else if (model.timelineNote) {
    parts.push(`<p class="muted note">${escapeHtml(model.timelineNote)}</p>`);
  }
  if (model.stageAgent && model.sparrer) {
    parts.push(`<section class="actors">${renderActor(model.stageAgent)}${renderActor(model.sparrer)}</section>`);
  }
  parts.push(`<section class="stage">
<h2>${escapeHtml(model.stageHeading ?? "")}${model.stageStatus ? ` <span class="pill">${escapeHtml(model.stageStatus)}</span>` : ""}</h2>
<p>${escapeHtml(model.stageLine ?? "")}</p>
</section>`);
  if (model.lastSparring) {
    const reason = model.lastSparring.reason ? ` <span class="muted">(${escapeHtml(model.lastSparring.reason)})</span>` : "";
    parts.push(`<section class="sparring">
<h3>Last sparring <span class="pill">${escapeHtml(model.lastSparring.action)}</span>${reason}</h3>
<p>${escapeHtml(model.lastSparring.summary || "(no summary recorded)")}</p>
</section>`);
  }
  const actions = model.actions;
  if (actions) {
    const buttons: string[] = [];
    if (actions.diff) {
      buttons.push(button("openDiff", actions.diff.label));
    }
    buttons.push(button("openHandoff", "Open handoff", actions.handoff));
    buttons.push(button("openSparring", "Open sparring report", actions.sparring));
    buttons.push(button("openBrief", "Open brief", actions.brief));
    if (actions.plan) {
      buttons.push(button("openPlan", "Open plan"));
    }
    buttons.push(button("showLog", "Show log"));
    parts.push(`<div class="actions">${buttons.join("")}</div>`);
  }
  if (model.facts && model.facts.length > 0) {
    parts.push(`<dl class="facts">${model.facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`).join("")}</dl>`);
  }
  return parts.join("\n");
}

const GLYPH: Record<TimelineItem["state"], string> = {
  accepted: "✓",
  frozen: "◆",
  active: "●",
  paused: "❚❚",
  working: "◐",
  future: "○",
};

function renderTimeline(items: TimelineItem[]): string {
  const cells = items.map((item) => {
    const cls = `step ${item.state}${item.current ? " current" : ""}`;
    const label = `Stage ${item.number} — ${item.title} (${item.state})`;
    return `<li class="${cls}" title="${escapeHtml(label)}"><span class="glyph">${GLYPH[item.state]}</span><span class="name">${escapeHtml(item.title)}</span></li>`;
  });
  return `<ol class="timeline">${cells.join("")}</ol>`;
}

function renderActor(card: ActorCard): string {
  const dot = card.activity === "Working" || card.activity === "Sparring" ? "●" : "○";
  const quiet = card.quietFor ? ` <span class="muted">· quiet ${escapeHtml(card.quietFor)}</span>` : "";
  const session = card.sessionLabel ? `${card.sessionKind} ${escapeHtml(card.sessionLabel)}` : `no ${card.sessionKind} yet`;
  return `<div class="actor">
<div class="role">${escapeHtml(card.role)}</div>
<div class="provider">${escapeHtml(card.provider)}</div>
<div class="activity ${card.activity.toLowerCase()}"><span class="dot">${dot}</span> ${escapeHtml(card.activity)}${quiet}</div>
<div class="session muted">${session}</div>
</div>`;
}

function button(action: OverviewAction, label: string, enabled = true): string {
  return `<button type="button" data-action="${action}"${enabled ? "" : " disabled"}>${escapeHtml(label)}</button>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
main { max-width: 760px; margin: 0 auto; padding: 12px 18px 20px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 1.05em; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 1em; font-weight: 600; margin: 0 0 4px; }
h3 { font-size: 0.9em; font-weight: 600; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
p { margin: 0 0 4px; }
.muted { color: var(--vscode-descriptionForeground); }
.run { font-family: var(--vscode-editor-font-family); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.banner { margin: 6px 0 10px; padding: 6px 10px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); font-weight: 600; }
.banner.stop { border-left-color: var(--vscode-editorWarning-foreground); }
.banner.warn { border-left-color: var(--vscode-editorWarning-foreground); }
.banner.done { border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.note { margin: 6px 0 10px; }
.timeline { list-style: none; display: flex; align-items: flex-start; gap: 0; margin: 8px 0 14px; padding: 0; height: 60px; overflow-x: auto; }
.step { position: relative; flex: 1 1 0; min-width: 72px; text-align: center; padding-top: 4px; }
.step:not(:last-child)::after { content: ""; position: absolute; top: 15px; left: 50%; width: 100%; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); z-index: 0; }
.glyph { position: relative; z-index: 1; display: inline-block; width: 22px; height: 22px; line-height: 22px; border-radius: 50%; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font-size: 12px; }
.step.accepted .glyph { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); border-color: currentColor; }
.step.frozen .glyph { color: var(--vscode-charts-blue); border-color: currentColor; }
.step.active .glyph { color: var(--vscode-focusBorder); border-color: currentColor; }
.step.paused .glyph { color: var(--vscode-editorWarning-foreground); border-color: currentColor; font-size: 9px; }
.step.working .glyph { color: var(--vscode-descriptionForeground); }
.step.future .glyph { color: var(--vscode-descriptionForeground); }
.name { display: block; margin-top: 4px; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; color: var(--vscode-descriptionForeground); }
.step.current .name { color: var(--vscode-foreground); font-weight: 600; }
.actors { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 14px; }
.actor { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 8px 10px; }
.role { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.provider { font-weight: 600; margin: 2px 0; }
.activity .dot { color: var(--vscode-descriptionForeground); }
.activity.working .dot, .activity.sparring .dot { color: var(--vscode-focusBorder); }
.session { font-family: var(--vscode-editor-font-family); font-size: 0.85em; margin-top: 2px; }
.stage, .sparring { margin: 0 0 12px; }
.pill { display: inline-block; font-size: 0.75em; font-weight: 500; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: middle; text-transform: none; letter-spacing: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 12px; }
button { font-family: inherit; font-size: inherit; padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.5; cursor: default; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 0.9em; }
.facts dt { color: var(--vscode-descriptionForeground); }
.facts dd { margin: 0; font-family: var(--vscode-editor-font-family); }
@media (max-width: 480px) { .actors { grid-template-columns: 1fr; } }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!target || target.disabled) { return; }
    vscode.postMessage({ type: 'action', action: target.getAttribute('data-action') });
  });
})();
`;
