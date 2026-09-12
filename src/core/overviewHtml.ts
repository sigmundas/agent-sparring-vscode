/**
 * Pure HTML renderer for the Run Overview webview. Every dynamic string is
 * escaped; no filesystem paths, session ids beyond their shortened form, or
 * secrets are placed in the document. The only script is a nonce'd
 * click-to-postMessage shim for the action buttons.
 *
 * Icons are small inline SVGs (the CSP allows no remote images or fonts) and
 * every colour is a VS Code theme variable, so the page follows the user's
 * theme. No provider logos: providers get a lettered avatar.
 *
 * Layout: header with status pills; plan journey; the current-stage card
 * (Goal + latest sparring result on the left, current activity + last
 * meaningful event on the right); provider cards; recent events; metadata.
 */

import { TIMELINE_STATE_WORD, type ActorCard, type HistoryEntry, type OverviewModel, type TimelineItem, type WhatsNext } from "./overviewModel";
import type { MatchSource } from "./planAssociation";
import type { StageRunAction } from "./runner";

export type OverviewAction =
  | "openHandoff"
  | "openSparring"
  | "openBrief"
  | "openPlan"
  | "openNextStage"
  | "openDiff"
  | "showLog"
  | "selectRun"
  | "runPlan"
  | "resumePlan"
  | "runStage"
  | "acceptStage"
  | "associatePlan"
  | "matchStage"
  | "clearMatch"
  | "startNextStage"
  | "stopRunner";

export const OVERVIEW_ACTIONS: readonly OverviewAction[] = [
  "openHandoff",
  "openSparring",
  "openBrief",
  "openPlan",
  "openNextStage",
  "openDiff",
  "showLog",
  "selectRun",
  "runPlan",
  "resumePlan",
  "runStage",
  "acceptStage",
  "associatePlan",
  "matchStage",
  "clearMatch",
  "startNextStage",
  "stopRunner",
];

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

// ---------------------------------------------------------------- icons

const ICON: Record<string, string> = {
  check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  target:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1" fill="currentColor"/>',
  pulse: '<path d="M1 8h3l2-5 3 10 2-5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  doc: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  warn: '<path d="M8 2l6.5 11.5H1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.9" fill="currentColor"/>',
  chat: '<path d="M2.5 3h11v7.5H8L4.5 13.5v-3h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  history: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  dot: '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
  arrow: '<path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  pause: '<path d="M5.5 4.5v7M10.5 4.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  lock: '<rect x="3.5" y="7" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
};

function icon(name: keyof typeof ICON, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICON[name]}</svg>`;
}

// ---------------------------------------------------------------- body

function renderBody(model: OverviewModel): string {
  if (model.kind === "empty") {
    return `<header class="top"><h1>Agent Sparring</h1></header>
<p class="muted">No recorded plan run or stage in this workspace.</p>
<div class="actions">${button("runPlan", "Run plan…")}${button("showLog", "Show log")}</div>`;
  }
  if (model.kind === "ambiguous") {
    return `<header class="top"><h1>Agent Sparring</h1></header>
<p>${escapeHtml(model.title)}:</p>
<ul>${(model.choices ?? []).map((choice) => `<li>${escapeHtml(choice)}</li>`).join("")}</ul>
<div class="actions">${button("selectRun", "Select run…")}${button("showLog", "Show log")}</div>`;
  }

  const parts: string[] = [];
  parts.push(renderHeader(model));
  if (model.banner) {
    parts.push(`<div class="banner ${model.banner.kind}">${escapeHtml(model.banner.text)}</div>`);
  }
  if (model.timeline && model.timeline.length > 0) {
    parts.push(renderJourney(model.timeline));
  } else if (model.timelineNote) {
    parts.push(`<p class="muted note">${escapeHtml(model.timelineNote)}</p>`);
  }
  parts.push(renderStageCard(model));
  if (model.stageAgent && model.sparrer) {
    parts.push(`<section class="actors">${renderActor(model.stageAgent)}${renderActor(model.sparrer)}</section>`);
  }
  if (model.history && model.history.length > 0) {
    const rows = model.history
      .map((entry) => `<li><span class="time">${escapeHtml(entry.time)}</span><span class="who ${whoClass(entry.who)}">${escapeHtml(entry.who)}</span><span>${escapeHtml(entry.description)}</span></li>`)
      .join("");
    parts.push(`<section class="history"><h3>${icon("history")}Recent events</h3><ol>${rows}</ol></section>`);
  }
  if (model.facts && model.facts.length > 0) {
    parts.push(`<dl class="facts">${model.facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`).join("")}</dl>`);
  }
  return parts.join("\n");
}

function renderHeader(model: OverviewModel): string {
  const pills: string[] = [];
  if (model.runKind) {
    pills.push(`<span class="hpill" title="${escapeHtml(model.title)}">${escapeHtml(model.runKind)}</span>`);
  }
  if (model.position) {
    pills.push(`<span class="hpill">${escapeHtml(model.position.replace(/^Stage (\d+) of (\d+)$/, "Stage $1 / $2"))}</span>`);
  }
  if (model.status) {
    pills.push(`<span class="hpill ${model.status.tone}">${icon("dot", "dot")}${escapeHtml(model.status.label)}</span>`);
  }
  return `<header class="top">
<div><h1>Agent Sparring</h1><div class="run muted" title="${escapeHtml(model.stageId ?? "")}">${escapeHtml(model.title)}</div></div>
<div class="pills">${pills.join("")}</div>
</header>`;
}

const JOURNEY_ICON: Record<TimelineItem["state"], keyof typeof ICON | undefined> = {
  accepted: "check",
  finalizing: "lock",
  active: undefined,
  paused: "pause",
  working: undefined,
  future: undefined,
};

/** Filled nodes joined by connectors; the connector after an accepted node is coloured. */
function renderJourney(items: TimelineItem[]): string {
  const cells = items.map((item) => {
    const cls = `step ${item.state}${item.current ? " current" : ""}`;
    const word = TIMELINE_STATE_WORD[item.state];
    const label = `Stage ${item.number} — ${item.title} (${word})`;
    const glyphIcon = JOURNEY_ICON[item.state];
    const node = glyphIcon ? icon(glyphIcon) : String(item.number);
    const state = item.state === "accepted" ? `<span class="state">${icon("check")}${escapeHtml(word)}</span>` : `<span class="state">${escapeHtml(word)}</span>`;
    return `<li class="${cls}" title="${escapeHtml(label)}"><span class="node">${node}</span><span class="num">${item.number}</span><span class="name">${escapeHtml(item.title)}</span>${state}</li>`;
  });
  return `<ol class="journey">${cells.join("")}</ol>`;
}

/** The stage action a button triggers: Accept stage is the two-step acceptance, everything else launches the loop. */
function stageActionButton(action: StageRunAction, stageId: string | undefined, cls = action.primary ? "primary" : ""): string {
  if (action.kind === "accept") {
    const title = `sparring freeze-candidate ${stageId ?? ""} …, then sparring accept-candidate ${stageId ?? ""} … (--repo-root <project> --expected-branch <current branch>)`;
    return button("acceptStage", action.label, true, title, cls);
  }
  const title = `sparring run-loop ${stageId ?? ""} --repo-root <project> --expected-branch <current branch>`;
  return button("runStage", action.label, true, title, cls);
}

function renderStageCard(model: OverviewModel): string {
  const accepted = model.whatsNext !== undefined;
  // Once accepted, the header pill already says Accepted: the card line
  // says "Stage complete." once and nothing repeats it.
  const statusWord =
    model.stageStatus && !accepted
      ? `<span class="status ${escapeHtml(model.stageStatusKind ?? "")}" title="${escapeHtml(model.stageRaw ? `Engine state: ${model.stageRaw}` : "")}">${escapeHtml(model.stageStatus)}</span><span class="sep">·</span>`
      : "";
  const cycle = model.cycle !== undefined ? `<span class="muted" title="loop cycle from telemetry">cycle ${model.cycle}</span><span class="sep">·</span>` : "";
  const buttons: string[] = [];
  if (model.stageAction) {
    buttons.push(stageActionButton(model.stageAction, model.stageId));
  }
  if (model.planAction && !accepted) {
    // For an accepted stage the plan action is the primary button of What's next instead.
    buttons.push(button("resumePlan", model.planAction.label, true, model.planAction.detail, model.planAction.primary ? "primary" : ""));
  }
  if (model.accepting) {
    buttons.push(`<span class="busy accepting" title="${escapeHtml(model.accepting.detail)}">${icon("dot", "dot")}${escapeHtml(model.accepting.label)}</span>`);
  }
  if (model.busyState) {
    const cls = model.busyState.state === "running" ? "busy" : "busy unknown";
    buttons.push(`<span class="${cls}" title="${escapeHtml(model.busyState.detail)}">${icon(model.busyState.state === "running" ? "dot" : "warn", "dot")}${escapeHtml(model.busyState.label)}</span>`);
  }
  if (model.runner?.alive) {
    buttons.push(button("stopRunner", model.runner.label, true, "Send Ctrl-C to the terminal running this stage", "danger"));
  }
  const actions = model.actions;
  if (actions) {
    buttons.push(button("openBrief", "Brief", actions.brief, "Open brief.md"));
    buttons.push(button("openHandoff", "Handoff", actions.handoff, "Open handoff.md"));
    buttons.push(button("openSparring", "Sparring report", actions.sparring, "Open sparring.md"));
    if (actions.diff) {
      buttons.push(button("openDiff", actions.diff.label, true, actions.diff.detail));
    }
    if (actions.plan) {
      buttons.push(button("openPlan", "Plan", true, model.plan ? `${model.plan.name} — ${model.plan.note}` : "Open the plan document"));
    } else if (actions.choosePlan && !accepted) {
      buttons.push(button("associatePlan", "Choose plan…", true, CHOOSE_PLAN_TITLE));
    }
    if (actions.changePlan && !(accepted && !actions.plan)) {
      buttons.push(button("associatePlan", "Change plan…", true, actions.plan ? "Choose another plan file or remove the association" : "The associated plan file is missing: choose another or remove the association", "quiet"));
    }
    buttons.push(button("showLog", "Log", true, "Show the Agent Sparring output channel"));
  }
  if (model.secondaryAction) {
    buttons.push(stageActionButton(model.secondaryAction, model.stageId, "quiet"));
  }

  const goal = model.goal
    ? `<div class="block"><h3>${icon("target", "accent")}Goal</h3><p class="goal">${escapeHtml(model.goal)}</p></div>`
    : `<div class="block"><h3>${icon("target", "accent")}Goal</h3><p class="muted">${model.actions?.brief ? "brief.md has no ## Goal paragraph." : "No brief.md for this stage yet."}</p></div>`;
  let sparring = `<div class="block"><h3>${icon("chat")}Latest sparring result</h3><p class="muted">No routing outcome recorded yet.</p></div>`;
  if (model.lastSparring) {
    const action = model.lastSparring.action;
    const reason = model.lastSparring.reason ? ` <span class="muted">(${escapeHtml(model.lastSparring.reason)})</span>` : "";
    const iconName = action === "READY" ? "check" : "warn";
    sparring = `<div class="block"><h3>${icon(iconName, action.toLowerCase())}Latest sparring result</h3>
<p><span class="verdict ${escapeHtml(action.toLowerCase())}" title="${escapeHtml(`Routing action: ${action}`)}">${escapeHtml(model.lastSparring.word)}</span>${reason}</p>
<p>${escapeHtml(model.lastSparring.summary || "(no summary recorded)")}</p></div>`;
  }
  const planPlace = renderPlanPlace(model);

  let current = `<p class="muted">No provider turn in progress.</p>`;
  if (model.activity?.kind === "stopped") {
    current = `<p class="stopped">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.activity?.kind === "stale") {
    current = `<p class="stale">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.activity?.kind === "inferred") {
    current = `<p class="inferred" title="${escapeHtml(model.liveness?.detail ?? "")}">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.runner?.alive && model.activity?.kind !== "active") {
    current = `<p class="muted">Runner started; waiting for the first turn.</p>`;
  } else if (model.activity?.kind === "active") {
    // "Sparring for 12s · Codex" → "Codex sparring for 12s"
    const match = /^(Working|Sparring) for (.+) · (.+)$/.exec(model.activity.text);
    current = match
      ? `<p class="now"><span class="who ${whoClass(match[3])}">${escapeHtml(match[3])}</span> ${match[1].toLowerCase()} for <span class="dur">${escapeHtml(match[2])}</span></p>`
      : `<p class="now">${escapeHtml(model.activity.text)}</p>`;
  }
  const last = model.lastEvent
    ? `<p><span class="time">${escapeHtml(model.lastEvent.time)}</span><span class="sep">·</span><span class="who ${whoClass(model.lastEvent.who)}">${escapeHtml(model.lastEvent.who)}</span> ${escapeHtml(model.lastEvent.description)}</p>`
    : `<p class="muted">No activity telemetry for this stage.</p>`;

  // An accepted stage has no current activity to watch; the right column
  // answers "what should I do now?" instead. The last event stays in Recent events.
  const right = model.whatsNext
    ? renderWhatsNext(model, model.whatsNext)
    : `<div class="block"><h3>${icon("pulse", "accent")}Current activity</h3>${current}</div>
<div class="block"><h3>${icon("doc")}Last meaningful event</h3>${last}</div>`;

  return `<section class="card stage">
<div class="stagehead">
<div><h2 title="${escapeHtml(model.stageId ?? "")}">${icon("dot", `accent ${escapeHtml(model.stageStatusKind ?? "")}`)}${escapeHtml(model.stageHeading ?? "")}</h2>
<div class="substatus">${statusWord}${cycle}<span class="${accepted ? "complete" : "muted"}">${escapeHtml(model.stageLine ?? "")}</span></div></div>
<div class="actions">${buttons.join("")}</div>
</div>
<div class="columns">
<div class="col">${goal}${sparring}${planPlace}</div>
<div class="col right">
${right}
</div>
</div>
</section>`;
}

const CHOOSE_PLAN_TITLE = "Pick the Markdown plan this stage belongs to (kept in VS Code only; the engine is not told)";
const MATCH_TITLE = "Pick which section of the linked plan this stage is (kept in VS Code only; the engine is not told)";

/**
 * Where this stage sits in an associated plan, for a stage that is still
 * running: the matched heading with Change match…, or the fact that it is
 * not matched with Match this stage…. Accepted stages carry this in What's
 * next instead; managed runs show the journey.
 */
function renderPlanPlace(model: OverviewModel): string {
  const plan = model.plan;
  if (!plan || plan.source !== "associated" || model.whatsNext) {
    return "";
  }
  if (plan.current) {
    return `<div class="block"><h3>${icon("doc")}Current plan stage</h3>${renderCurrentPlanStage(plan.current, plan.matched)}</div>`;
  }
  if (!model.actions?.matchStage) {
    return "";
  }
  return `<div class="block"><h3>${icon("doc")}Current plan stage</h3><p class="muted">Agent Sparring doesn't yet know where this stage belongs in ${escapeHtml(plan.name)}. ${button("matchStage", "Match this stage…", true, MATCH_TITLE, "quiet")}</p></div>`;
}

/** `Stage 3B — title` with how it was decided and the two ways to change it. */
function renderCurrentPlanStage(current: string, matched: MatchSource | undefined): string {
  const how = matched === "manual" ? "Matched manually" : "Matched automatically";
  return `<p class="nextstage">${escapeHtml(current)}</p><p class="muted matched">${how} ${button("matchStage", "Change match…", true, MATCH_TITLE, "quiet")}${matched === "manual" ? button("clearMatch", "Remove match", true, "Forget the section you picked and match automatically again", "quiet") : ""}</p>`;
}

/**
 * The accepted screen's answer to "what should I do now?". Buttons are
 * real operations only: Continue plan is the engine's resume-plan for a
 * managed run; everything for an associated file opens or matches a
 * document and never claims to start a stage.
 */
function renderWhatsNext(model: OverviewModel, next: WhatsNext): string {
  const plan = model.plan;
  const heading = next.heading ? `<p class="nextstage">${escapeHtml(next.heading)}</p>` : "";
  const summary = next.summary ? `<p class="muted summary">${escapeHtml(next.summary)}</p>` : "";
  const text = `<p class="${next.heading ? "muted" : ""}">${escapeHtml(next.text)}</p>`;
  const hints = next.hints && next.hints.length > 0 ? `<p class="muted">The brief lists later work that is in this plan: ${next.hints.map((hint) => `<span class="next">${escapeHtml(hint)}</span>`).join(", ")}.</p>` : "";
  const buttons: string[] = [];
  const planName = plan?.name ?? "the plan";
  const openNext = (label: string, cls = "") => button(plan?.next?.line ? "openNextStage" : "openPlan", label, true, plan?.next?.line ? `Open ${planName} at ${plan.next.display}` : `Open ${planName}`, cls);
  switch (next.kind) {
    case "continue":
    case "last-managed":
      if (model.planAction) {
        buttons.push(button("resumePlan", model.planAction.label, true, model.planAction.detail, "primary"));
      }
      if (model.actions?.plan) {
        buttons.push(openNext("Open in plan"));
      }
      break;
    case "next-stage":
      buttons.push(button("startNextStage", "Start next stage", true, `sparring new-stage ${next.start?.stageId ?? ""} — creates the stage; you fill in brief.md from the plan section, then Run stage`, "primary"));
      buttons.push(openNext("Open in plan"));
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "next-unclear":
      buttons.push(openNext("Open in plan", "primary"));
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "last-stage":
    case "no-labels":
      buttons.push(button("openPlan", "Open plan", true, `Open ${planName}`));
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "match":
      if (model.actions?.matchStage) {
        buttons.push(button("matchStage", "Match this stage…", true, MATCH_TITLE, "primary"));
      }
      buttons.push(button("openPlan", "Open plan", true, `Open ${planName}`));
      buttons.push(button("associatePlan", "Change plan…", true, "Choose another plan file or remove the association", "quiet"));
      break;
    case "missing-plan":
    case "choose":
      buttons.push(button("associatePlan", "Choose plan…", true, CHOOSE_PLAN_TITLE, "primary"));
      break;
  }
  const matchedKinds: WhatsNext["kind"][] = ["next-stage", "next-unclear", "last-stage", "no-labels"];
  const current =
    matchedKinds.includes(next.kind) && plan?.current
      ? `<div class="block currentstage"><h3>${icon("doc")}Current plan stage</h3><p class="nextstage">${escapeHtml(plan.current)}</p><p class="muted matched">${plan.matched === "manual" ? "Matched manually" : "Matched automatically"}${plan.matched === "manual" ? ` ${button("clearMatch", "Remove match", true, "Forget the section you picked and match automatically again", "quiet")}` : ""}${button("associatePlan", "Remove plan association", true, "Unlink this plan from the stage (kept in VS Code only)", "quiet")}</p></div>`
      : "";
  return `<div class="block whatsnext"><h3>${icon("arrow", "accent")}What's next</h3>${heading}${summary}${text}${hints}<div class="actions">${buttons.join("")}</div></div>${current}`;
}

function renderActor(card: ActorCard): string {
  const busy = card.activity === "Working" || card.activity === "Sparring";
  const duration = card.duration ? ` for ${escapeHtml(card.duration)}` : "";
  const quiet = card.quietFor ? ` <span class="muted">· no meaningful activity for ${escapeHtml(card.quietFor)}</span>` : "";
  const uncertain = busy && card.uncertain ? ` <span class="muted">· runner status unknown</span>` : "";
  const session = card.sessionLabel ? `${capitalize(card.sessionKind)}: ${escapeHtml(card.sessionLabel)}` : `No ${card.sessionKind} yet`;
  const who = whoClass(card.provider);
  // A telemetry-only turn reads "Working? (turn observed 3m ago)": the duration is
  // time since the observed start, not a claim that work is happening now.
  const word = busy && card.uncertain ? `${card.activity}?` : card.activity;
  const span = busy && card.uncertain ? (card.duration ? ` <span class="muted">(turn observed ${escapeHtml(card.duration)} ago)</span>` : "") : duration;
  return `<div class="card actor">
<span class="avatar ${who}">${escapeHtml(card.provider.charAt(0).toUpperCase())}</span>
<div>
<div><span class="provider ${who}">${escapeHtml(card.provider)}</span> <span class="muted">(${escapeHtml(card.role)})</span></div>
<div class="activity ${card.activity.toLowerCase()}${busy && card.uncertain ? " uncertain" : ""}">${icon("dot", "dot")}${escapeHtml(word)}${busy ? span : ""}${uncertain}${quiet}</div>
<div class="session muted">${session}</div>
</div>
</div>`;
}

function whoClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("claude")) {
    return "claude";
  }
  if (lower.startsWith("codex")) {
    return "codex";
  }
  return "other";
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function button(action: OverviewAction, label: string, enabled = true, title?: string, cls = ""): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const classAttr = cls ? ` class="${cls}"` : "";
  return `<button type="button"${classAttr} data-action="${action}"${titleAttr}${enabled ? "" : " disabled"}>${escapeHtml(label)}</button>`;
}

export type { HistoryEntry };

// ---------------------------------------------------------------- style

const STYLE = `
:root {
  color-scheme: light dark;
  --good: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  --info: var(--vscode-charts-blue, var(--vscode-focusBorder));
  --warn: var(--vscode-charts-orange, var(--vscode-editorWarning-foreground));
  --bad: var(--vscode-charts-red, var(--vscode-editorError-foreground));
  --claude: var(--vscode-charts-blue, var(--vscode-focusBorder));
  --codex: var(--vscode-charts-purple, var(--vscode-textLink-foreground));
  --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  --card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
}
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
main { max-width: 880px; margin: 0 auto; padding: 14px 18px 20px; }
.muted { color: var(--vscode-descriptionForeground); }
.sep { color: var(--vscode-descriptionForeground); margin: 0 6px; }
.icon { width: 14px; height: 14px; vertical-align: -2px; margin-right: 6px; flex: none; }
.icon.accent { color: var(--info); }
.icon.ready, .icon.accepted { color: var(--good); }
.icon.send_back, .icon.needs_you { color: var(--warn); }
.icon.escalate { color: var(--bad); }
.icon.dot { width: 9px; height: 9px; margin-right: 5px; }

header.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
h1 { font-size: 1.35em; font-weight: 600; margin: 0; }
.run { font-family: var(--vscode-editor-font-family); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.hpill { display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 0.9em; background: var(--card); }
.hpill.good { color: var(--good); border-color: var(--good); }
.hpill.info { color: var(--info); border-color: var(--info); }
.hpill.warn { color: var(--warn); border-color: var(--warn); }

.banner { margin: 8px 0 10px; padding: 6px 10px; border-left: 3px solid var(--info); background: var(--vscode-textBlockQuote-background); font-weight: 600; }
.banner.stop, .banner.warn { border-left-color: var(--warn); }
.banner.done { border-left-color: var(--good); }
.note { margin: 6px 0 10px; }

.journey { list-style: none; display: flex; align-items: flex-start; margin: 14px 0 16px; padding: 0; overflow-x: auto; }
.step { position: relative; display: flex; flex-direction: column; align-items: center; flex: 1 1 0; min-width: 72px; text-align: center; }
.step:not(:last-child)::after { content: ""; position: absolute; top: 13px; left: 50%; width: 100%; border-top: 2px solid var(--line); z-index: 0; }
.step.accepted:not(:last-child)::after { border-top-color: var(--good); }
.node { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--line); color: var(--vscode-foreground); font-weight: 600; font-size: 0.85em; }
.node .icon { margin: 0; width: 14px; height: 14px; }
.step.accepted .node { background: var(--good); color: var(--vscode-editor-background); }
.step.active .node { background: var(--info); color: var(--vscode-editor-background); }
.step.paused .node { background: var(--warn); color: var(--vscode-editor-background); }
.step.finalizing .node { background: var(--info); color: var(--vscode-editor-background); }
.step.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px currentColor; }
.step.active.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px var(--info); }
.step.paused.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px var(--warn); }
.num { margin-top: 6px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.name { display: block; max-width: 100%; padding: 0 4px; font-size: 0.9em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { display: inline-flex; align-items: center; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.state .icon { width: 11px; height: 11px; margin-right: 3px; }
.step.accepted .state { color: var(--good); }
.step.active .state { color: var(--info); }
.step.paused .state { color: var(--warn); }
.step.finalizing .state { color: var(--info); }

.card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.stage { padding: 12px 14px 10px; margin: 0 0 10px; }
.stagehead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
h2 { display: flex; align-items: center; font-size: 1.3em; font-weight: 600; margin: 0 0 2px; line-height: 1.3; }
h2 .icon { width: 16px; height: 16px; margin-right: 8px; }
h2 .icon.ready, h2 .icon.accepted { color: var(--good); }
h2 .icon.send_back, h2 .icon.needs_you { color: var(--warn); }
h2 .icon.escalate { color: var(--bad); }
.substatus { font-size: 0.95em; }
.status { font-weight: 600; color: var(--info); }
.status.ready, .status.accepted { color: var(--good); }
.status.send_back, .status.needs_you { color: var(--warn); }
.status.escalate { color: var(--bad); }
.status.finalizing { color: var(--info); }
.status.stopped { color: var(--warn); }
.next { font-weight: 600; }
.complete { color: var(--good); font-weight: 600; }
.whatsnext .nextstage { font-size: 1.15em; font-weight: 600; margin: 2px 0 2px; }
.whatsnext .summary { margin-bottom: 6px; }
.whatsnext .actions { margin: 8px 0 6px; }
.whatsnext .matched { font-size: 0.9em; }
.columns { display: grid; grid-template-columns: 3fr 2fr; gap: 0 18px; margin-top: 12px; }
.col.right { border-left: 1px solid var(--line); padding-left: 18px; }
.block { padding: 6px 0 10px; }
.col .block + .block { border-top: 1px solid var(--line); padding-top: 10px; }
.col.right .block + .block { border-top: none; }
h3 { display: flex; align-items: center; font-size: 0.95em; font-weight: 600; margin: 0 0 4px; color: var(--vscode-foreground); }
h3 .icon { width: 15px; height: 15px; }
p { margin: 0 0 4px; line-height: 1.45; }
.goal { color: var(--vscode-foreground); }
.verdict { font-weight: 700; letter-spacing: 0.02em; color: var(--info); }
.verdict.ready { color: var(--good); }
.verdict.send_back, .verdict.needs_you { color: var(--warn); }
.verdict.escalate { color: var(--bad); }
.now { font-size: 1.05em; }
.dur { font-weight: 600; }
.who.claude { color: var(--claude); font-weight: 600; }
.who.codex { color: var(--codex); font-weight: 600; }
.who.other { font-weight: 600; }
.time { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }

.actors { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 10px; }
.actor { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; line-height: 1.45; }
.avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; font-weight: 700; font-size: 1.05em; color: var(--vscode-editor-background); background: var(--line); }
.avatar.claude { background: var(--claude); }
.avatar.codex { background: var(--codex); }
.provider { font-weight: 600; font-size: 1.05em; }
.provider.claude { color: var(--claude); }
.provider.codex { color: var(--codex); }
.activity { display: flex; align-items: center; }
.activity .icon.dot { color: var(--vscode-descriptionForeground); }
.activity.working, .activity.sparring { color: var(--good); font-weight: 600; }
.activity.working .icon.dot, .activity.sparring .icon.dot { color: var(--good); }
.session { font-family: var(--vscode-editor-font-family); font-size: 0.85em; }

.history { margin: 0 0 10px; }
.history ol { list-style: none; margin: 0; padding: 0; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
.history li { display: grid; grid-template-columns: max-content max-content 1fr; gap: 0 10px; line-height: 1.55; }
.history li:last-child { color: var(--vscode-foreground); }

.actions { display: flex; flex-wrap: wrap; gap: 6px; }
button { font-family: inherit; font-size: 0.92em; padding: 4px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.danger { color: var(--warn); border-color: var(--warn); }
button.quiet { background: transparent; color: var(--vscode-descriptionForeground); }
.busy { display: inline-flex; align-items: center; padding: 4px 11px; border: 1px solid var(--good); border-radius: 6px; font-size: 0.92em; color: var(--good); font-weight: 600; cursor: help; }
.busy.unknown { border-color: var(--warn); color: var(--warn); }
.busy.accepting { border-color: var(--info); color: var(--info); }
.stopped, .stale, .inferred { display: flex; align-items: center; color: var(--warn); }
.activity.uncertain { color: var(--warn); }
.activity.uncertain .icon.dot { color: var(--warn); }

.facts { display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; margin: 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.facts dt { color: var(--vscode-descriptionForeground); }
.facts dd { margin: 0; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 640px) {
  .columns { grid-template-columns: 1fr; }
  .col.right { border-left: none; padding-left: 0; border-top: 1px solid var(--line); padding-top: 8px; }
  .actors { grid-template-columns: 1fr; }
}
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
