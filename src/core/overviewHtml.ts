/**
 * Pure HTML renderer for the Run Overview webview. Every dynamic string is
 * escaped; no filesystem paths, session ids beyond their shortened form, or
 * secrets are placed in the document. The only script is a nonce'd
 * click-to-postMessage shim for the action buttons.
 *
 * Layout, top to bottom: where we have been and are going (plan journey),
 * where we are (current stage: heading, status, goal, activity, last
 * sparring), the actors as small secondary cards, actions, quiet metadata.
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
  parts.push(`<header><h1>Agent Sparring</h1><span class="run muted" title="${escapeHtml(model.stageId ?? model.title)}">${escapeHtml(model.title)}</span></header>`);
  if (model.banner) {
    parts.push(`<div class="banner ${model.banner.kind}">${escapeHtml(model.banner.text)}</div>`);
  }
  if (model.timeline && model.timeline.length > 0) {
    parts.push(renderJourney(model.timeline));
  } else if (model.timelineNote) {
    parts.push(`<p class="muted note">${escapeHtml(model.timelineNote)}</p>`);
  }
  parts.push(renderStage(model));
  if (model.lastSparring) {
    const reason = model.lastSparring.reason ? ` <span class="muted">(${escapeHtml(model.lastSparring.reason)})</span>` : "";
    parts.push(`<section class="sparring">
<h3>Last sparring <span class="pill ${escapeHtml(model.lastSparring.action.toLowerCase())}">${escapeHtml(model.lastSparring.action)}</span>${reason}</h3>
<p>${escapeHtml(model.lastSparring.summary || "(no summary recorded)")}</p>
</section>`);
  }
  if (model.stageAgent && model.sparrer) {
    parts.push(`<section class="actors">${renderActor(model.stageAgent)}${renderActor(model.sparrer)}</section>`);
  }
  const actions = model.actions;
  if (actions) {
    const buttons: string[] = [];
    if (actions.diff) {
      buttons.push(button("openDiff", actions.diff.label, true, actions.diff.detail));
    }
    buttons.push(button("openHandoff", "Handoff", actions.handoff, "Open handoff.md"));
    buttons.push(button("openSparring", "Sparring report", actions.sparring, "Open sparring.md"));
    buttons.push(button("openBrief", "Brief", actions.brief, "Open brief.md"));
    if (actions.plan) {
      buttons.push(button("openPlan", "Plan", true, "Open the plan document"));
    }
    buttons.push(button("showLog", "Log", true, "Show the Agent Sparring output channel"));
    parts.push(`<div class="actions">${buttons.join("")}</div>`);
  }
  if (model.facts && model.facts.length > 0) {
    parts.push(`<dl class="facts">${model.facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`).join("")}</dl>`);
  }
  return parts.join("\n");
}

function renderStage(model: OverviewModel): string {
  const pill = model.stageStatus
    ? ` <span class="pill ${escapeHtml(model.stageStatusKind ?? "")}" title="${escapeHtml(model.stageId ? `stage id: ${model.stageId}` : "")}">${escapeHtml(model.stageStatus)}</span>`
    : "";
  const cycle = model.cycle !== undefined ? ` <span class="pill quiet" title="loop cycle from telemetry">cycle ${model.cycle}</span>` : "";
  const position = model.position ? `<div class="position muted">${escapeHtml(model.position)}</div>` : "";
  const goal = model.goal ? `<p class="goal"><span class="label">Goal</span> ${escapeHtml(model.goal)}</p>` : "";
  let activity = "";
  if (model.activity) {
    const time = model.activity.time ? `<span class="time">${escapeHtml(model.activity.time)}</span> ` : "";
    const label = model.activity.kind === "last" ? "Last" : model.activity.kind === "active" ? "Now" : "";
    activity = `<p class="activity ${model.activity.kind}">${label ? `<span class="label">${label}</span> ` : ""}${time}${escapeHtml(model.activity.text)}</p>`;
  }
  return `<section class="stage">
${position}
<h2 title="${escapeHtml(model.stageId ?? "")}">${escapeHtml(model.stageHeading ?? "")}${pill}${cycle}</h2>
<p class="line">${escapeHtml(model.stageLine ?? "")}</p>
${goal}
${activity}
</section>`;
}

const GLYPH: Record<TimelineItem["state"], string> = {
  accepted: "✓",
  frozen: "◆",
  active: "●",
  paused: "❚❚",
  working: "◐",
  future: "○",
};

/** One compact row: a glyph per stage, the current stage's title spelled out. */
function renderJourney(items: TimelineItem[]): string {
  const cells = items.map((item) => {
    const cls = `step ${item.state}${item.current ? " current" : ""}`;
    const label = `Stage ${item.number} — ${item.title} (${item.state})`;
    return `<li class="${cls}" title="${escapeHtml(label)}"><span class="glyph">${GLYPH[item.state]}</span><span class="num">${item.number}</span></li>`;
  });
  return `<ol class="journey">${cells.join("")}</ol>`;
}

function renderActor(card: ActorCard): string {
  const busy = card.activity === "Working" || card.activity === "Sparring";
  const dot = busy ? "●" : "○";
  const duration = card.duration ? ` <span class="muted">${escapeHtml(card.duration)}</span>` : "";
  const quiet = card.quietFor ? ` <span class="muted">· quiet ${escapeHtml(card.quietFor)}</span>` : "";
  const session = card.sessionLabel ? `${card.sessionKind} ${escapeHtml(card.sessionLabel)}` : `no ${card.sessionKind} yet`;
  return `<div class="actor">
<span class="role">${escapeHtml(card.role)}</span>
<span class="provider">${escapeHtml(card.provider)}</span>
<span class="activity ${card.activity.toLowerCase()}"><span class="dot">${dot}</span> ${escapeHtml(card.activity)}${duration}${quiet}</span>
<span class="session muted">${session}</span>
</div>`;
}

function button(action: OverviewAction, label: string, enabled = true, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<button type="button" data-action="${action}"${titleAttr}${enabled ? "" : " disabled"}>${escapeHtml(label)}</button>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
main { max-width: 760px; margin: 0 auto; padding: 12px 18px 20px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 1.05em; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 1.25em; font-weight: 600; margin: 0 0 4px; line-height: 1.3; }
h3 { font-size: 0.8em; font-weight: 600; margin: 0 0 3px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
p { margin: 0 0 4px; }
.muted { color: var(--vscode-descriptionForeground); }
.run { font-family: var(--vscode-editor-font-family); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.banner { margin: 6px 0 10px; padding: 6px 10px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); font-weight: 600; }
.banner.stop { border-left-color: var(--vscode-editorWarning-foreground); }
.banner.warn { border-left-color: var(--vscode-editorWarning-foreground); }
.banner.done { border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.note { margin: 6px 0 10px; }
.journey { list-style: none; display: flex; align-items: center; gap: 0; margin: 6px 0 12px; padding: 0; }
.step { position: relative; display: flex; flex-direction: column; align-items: center; width: 36px; }
.step:not(:last-child)::after { content: ""; position: absolute; top: 9px; left: 50%; width: 100%; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); z-index: 0; }
.glyph { position: relative; z-index: 1; display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font-size: 10px; }
.num { font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-top: 1px; }
.step.accepted .glyph { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); border-color: currentColor; }
.step.frozen .glyph { color: var(--vscode-charts-blue); border-color: currentColor; }
.step.active .glyph { color: var(--vscode-focusBorder); border-color: currentColor; }
.step.paused .glyph { color: var(--vscode-editorWarning-foreground); border-color: currentColor; font-size: 7px; }
.step.working .glyph, .step.future .glyph { color: var(--vscode-descriptionForeground); }
.step.current .glyph { box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 3px currentColor; }
.step.current .num { color: var(--vscode-foreground); font-weight: 600; }
.stage { margin: 0 0 12px; }
.position { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; }
.line { font-size: 1em; }
.goal { margin-top: 6px; line-height: 1.4; }
.label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-right: 4px; }
.activity.active, .activity.last, .activity.none { margin-top: 4px; color: var(--vscode-descriptionForeground); }
.activity.active { color: var(--vscode-foreground); }
.time { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
.sparring { margin: 0 0 12px; }
.actors { display: flex; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 10px; }
.actor { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 8px; font-size: 0.9em; line-height: 1.35; flex: 1 1 240px; }
.role { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.provider { font-weight: 600; }
.actor .activity { margin: 0; color: inherit; }
.actor .dot { color: var(--vscode-descriptionForeground); }
.actor .activity.working .dot, .actor .activity.sparring .dot { color: var(--vscode-focusBorder); }
.session { font-family: var(--vscode-editor-font-family); font-size: 0.8em; opacity: 0.8; }
.pill { display: inline-block; font-size: 0.7em; font-weight: 500; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: middle; text-transform: none; letter-spacing: 0; }
.pill.ready, .pill.accepted { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); color: var(--vscode-editor-background); }
.pill.needs_you, .pill.escalate { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.pill.quiet { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
button { font-family: inherit; font-size: inherit; padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.5; cursor: default; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; margin: 0; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.facts dt { color: var(--vscode-descriptionForeground); }
.facts dd { margin: 0; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
