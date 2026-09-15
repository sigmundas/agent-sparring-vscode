/**
 * The NEEDS_YOU review as self-contained Markdown, for pasting into a chat
 * assistant.
 *
 * A reviewer's manual check is written for precision, and it assumes the
 * reader has the stage, the plan and the candidate in front of them. Someone
 * who wants to ask "what does this actually mean?" or "how would I perform
 * this?" therefore has to reassemble the context by hand out of four files
 * before they can ask the question at all. These two functions do that
 * assembly: everything the panel knows about the stage and the gate, laid out
 * as ordinary Markdown that pastes cleanly into ChatGPT, Claude, GitHub or
 * Slack.
 *
 * Two rules decide the content, and both are the same rule the Overview
 * itself follows.
 *
 * **Only what was recorded.** Every line here is copied from the engine's own
 * artifacts — the plan-run state, sparring.md, handoff.md, notes.md and the
 * plan document — and the reviewer's own words are quoted verbatim, never
 * paraphrased or shortened into a different test. Where a fact is not
 * recorded, the section is simply absent; nothing is guessed to fill a gap.
 *
 * **Nothing that is not the review.** Provider prompts, model reasoning,
 * command transcripts, test output and the activity log are all deliberately
 * left out. They are the workflow's internals, they are the bulk of its bytes,
 * and none of them help a person understand what a check asks for.
 *
 * Pure: no vscode API, no filesystem access. The caller supplies the texts.
 */

import { parseHandoffClaims, parseSparringOutcome } from "./engineFormats";
import { HUMAN_FEEDBACK_HEADING, parseHumanFeedback, type CheckItem } from "./humanChecks";
import { categoryWord, checkName, humanTask } from "./humanTask";
import { extractPlanSection } from "./nextStage";
import type { ActionRequired, OverviewArtifacts, OverviewModel } from "./overviewModel";

/** Everything the copy is built from: the panel's own model, plus the texts it was built from. */
export interface ReviewCopySource {
  model: OverviewModel;
  artifacts: OverviewArtifacts;
  /** sparring.md, when readable; only its `## Finding / discussion` body is used. */
  sparringText?: string;
  /** The repository folder the run belongs to. */
  repository?: string;
}

/**
 * A concrete name the review refers to, with the short sentence that says what
 * it is. This is the answer to a reviewer (or a UI) saying "both rollout
 * switches" when `stage-3d-reader-gate` and `stage-3d-writer-gate` are what
 * they mean: the names exist, they are stable, and they are what a person
 * needs in order to look either one up.
 */
export interface NamedValue {
  name: string;
  description: string;
}

/** A quoted block is never allowed to grow past this; the file it came from is named instead. */
export const COPY_SECTION_MAX = 4000;

/**
 * The whole review, as Markdown.
 *
 * Undefined when this stage is not waiting for a human — there is no review to
 * describe then, and an empty document would be worse than no button.
 */
export function reviewCopyText(source: ReviewCopySource): string | undefined {
  const panel = source.model.actionRequired;
  if (!panel) {
    return undefined;
  }
  const model = source.model;
  const checks = allChecks(panel);
  const out: string[] = [];
  out.push(`# ${panel.kind === "escalate" ? "An automated code review escalated to a human" : "Manual check requested before an automated code review can continue"}`);
  out.push(
    "I am the human this review is waiting on. Everything below is copied from what the Agent Sparring workflow recorded; the reviewer's own wording is verbatim.",
  );
  out.push(section("Context", contextList(source).map(bullet).join("\n")));
  if (model.goal) {
    out.push(section("Stage goal", model.goal));
  }
  if (panel.summary) {
    out.push(section("Reviewer's summary", quote(panel.summary)));
  }
  if (panel.reviewerNote) {
    out.push(section("Reviewer's note", quote(panel.reviewerNote)));
  }
  if (panel.gate) {
    out.push(section("What must be true before this stage can continue", `${panel.gate.category} — ${panel.gate.title}`));
  }
  if (checks.length === 0) {
    out.push(section("Checks", panel.noChecks ?? "The workflow recorded no specific check for this stage."));
  } else {
    out.push(section(`Checks (${checks.length})`, checks.map((check, index) => checkBlock(check, index + 1, checks.length, { title: 3, sub: 4 })).join("\n\n")));
  }
  // Freeform human feedback, and the workflow state it is in. A reader who
  // cannot tell "the reviewer has seen this" from "this is still sitting in a
  // text box" is being handed a different situation than the real one, so the
  // two never share a heading.
  const sent = parseHumanFeedback(source.artifacts.notesText);
  if (sent.length > 0) {
    out.push(
      section(
        "Additional human feedback",
        [
          `What the human reported outside the requested checks and sent to the reviewer (notes.md, \`${HUMAN_FEEDBACK_HEADING}\`, verbatim${sent.length > 1 ? "; oldest first" : ""}):`,
          "",
          sent.map((entry) => quote(clip(entry, "notes.md"))).join("\n>\n"),
        ].join("\n"),
      ),
    );
  }
  if (panel.feedback.draft) {
    out.push(
      section(
        "Draft human feedback — not yet submitted",
        ["Typed in the Overview and not sent: the reviewer has not seen this and has not ruled on it.", "", quote(clip(panel.feedback.draft, "the Overview's own field"))].join("\n"),
      ),
    );
  }
  const named = namedValues(panel);
  if (named.length > 0) {
    out.push(section("Named values", named.map((value) => bullet(`\`${value.name}\` — ${value.description}`)).join("\n")));
  }
  const claims = source.artifacts.handoffText ? parseHandoffClaims(source.artifacts.handoffText) : undefined;
  if (claims) {
    out.push(section("Latest handoff claims", ["What the implementing agent recorded about this candidate (handoff.md, `## Claims`, verbatim):", "", quote(clip(claims, "handoff.md"))].join("\n")));
  }
  const findings = source.sparringText ? parseSparringOutcome(source.sparringText)?.findings : undefined;
  if (findings) {
    out.push(section("Reviewer's findings", ["sparring.md, `## Finding / discussion`, verbatim:", "", quote(clip(findings, "sparring.md"))].join("\n")));
  }
  const plan = planSection(source);
  if (plan) {
    out.push(section("Plan section", [`${plan.where}:`, "", quote(clip(plan.text, "the plan document"))].join("\n")));
  }
  out.push(FOOTER);
  return join(out);
}

/**
 * One check, as Markdown: enough of the stage around it that the check still
 * means something outside the extension, then the reviewer's instruction and
 * pass criteria verbatim. Undefined when no check of this review has that key.
 *
 * Freeform human feedback is *not* part of it. This copy answers "what does
 * this one check mean, and how would I perform it", and a crash report filed
 * against a different part of the feature does not help with that; if such
 * feedback has already changed what the reviewer asks of this check, then the
 * reviewer's own reworded check is what is quoted here anyway.
 */
export function checkCopyText(source: ReviewCopySource, key: string): string | undefined {
  const panel = source.model.actionRequired;
  if (!panel) {
    return undefined;
  }
  const checks = allChecks(panel);
  const at = checks.findIndex((check) => check.key === key);
  if (at < 0) {
    return undefined;
  }
  const check = checks[at];
  const name = checkName(check, at + 1);
  const out: string[] = [];
  out.push(`# Manual check: ${name.named ? `\`${name.name}\`` : name.name}`);
  out.push("One check of an Agent Sparring review that is waiting on a human. The reviewer's wording is verbatim.");
  const context = contextList(source);
  if (source.model.goal) {
    context.push(`Stage goal: ${source.model.goal}`);
  }
  if (panel.gate) {
    context.push(`Gate: ${panel.gate.category} — ${panel.gate.title}`);
  }
  if (checks.length > 1) {
    context.push(`This is check ${at + 1} of ${checks.length} in that gate.`);
  }
  out.push(section("Context", context.map(bullet).join("\n")));
  out.push(checkBlock(check, at + 1, checks.length, { sub: 2 }));
  const named = namedValues(panel, [check]);
  if (named.length > 0) {
    out.push(section("Named values", named.map((value) => bullet(`\`${value.name}\` — ${value.description}`)).join("\n")));
  }
  const plan = planSection(source);
  if (plan) {
    out.push(section("Plan section", [`${plan.where}:`, "", quote(clip(plan.text, "the plan document"))].join("\n")));
  }
  out.push(FOOTER);
  return join(out);
}

/**
 * The concrete names this review refers to. Every one of them is a value the
 * engine recorded: the gate's own category, each check's stable id, and the
 * place the reviewer said the full test is defined. Nothing is extracted from
 * prose — a name mined out of a sentence is a guess, and a wrong identifier is
 * worse than none.
 */
export function namedValues(panel: ActionRequired, only?: CheckItem[]): NamedValue[] {
  const checks = allChecks(panel);
  const wanted = only ?? checks;
  const out: NamedValue[] = [];
  if (panel.gate) {
    out.push({ name: panel.gate.category, description: `the reviewer's own category for this gate (${categoryWord(panel.gate.category).toLowerCase()})` });
  }
  for (const check of wanted) {
    const at = checks.indexOf(check);
    const name = checkName(check, at + 1);
    const position = checks.length > 1 ? `check ${at + 1}` : "this check";
    if (name.named) {
      out.push({ name: name.name, description: `the reviewer's stable id for ${position}: ${name.description}` });
    }
    if (check.source) {
      out.push({ name: check.source, description: `where the full test for ${position} is defined, as the reviewer named it` });
    }
  }
  return out;
}

/** Recorded evidence first would bury the outstanding work; the panel's own order is kept. */
function allChecks(panel: ActionRequired): CheckItem[] {
  return [...panel.required, ...panel.recorded];
}

// ---------------------------------------------------------------- pieces

function contextList(source: ReviewCopySource): string[] {
  const model = source.model;
  const panel = model.actionRequired;
  const out: string[] = [];
  if (source.repository) {
    out.push(`Repository: ${source.repository}`);
  }
  if (model.planName) {
    out.push(`Plan: ${model.planName}`);
  }
  const stage = model.plan?.current ?? model.stageHeading;
  if (stage) {
    out.push(`Stage: ${stage}`);
  }
  if (model.stageId) {
    out.push(`Stage id: \`${model.stageId}\``);
  }
  const branch = source.artifacts.git?.branch;
  if (branch) {
    out.push(`Branch: \`${branch}\``);
  }
  if (panel) {
    // The engine's own routing word, and the human word for it, said once each.
    out.push(`Routing state: ${panel.technical.find((detail) => detail.label === "Routing action")?.value ?? panel.kind.toUpperCase()} (${panel.word})`);
    if (panel.progress) {
      out.push(`Evidence recorded so far: ${panel.progress}`);
    }
  }
  return out;
}

/**
 * One check: its name, the instruction as the reviewer wrote it, the pass
 * criteria as the reviewer wrote it, where the test is defined, and what has
 * been recorded for it. The instruction is quoted whole — a check is a test,
 * and a test loses its meaning one clause at a time — and only its own
 * sentence split is used to make it readable.
 */
function checkBlock(check: CheckItem, position: number, total: number, levels: { title?: number; sub: number }): string {
  const name = checkName(check, position);
  const task = humanTask(check);
  const out: string[] = [];
  if (levels.title !== undefined) {
    out.push(`${"#".repeat(levels.title)} ${total > 1 ? `${position}. ` : ""}${name.named ? `\`${name.name}\`` : name.name}`);
  }
  const hashes = "#".repeat(levels.sub);
  out.push(`${hashes} Instruction, verbatim`);
  out.push(task.steps.length > 1 ? task.steps.map((step, index) => `${index + 1}. ${step}`).join("\n") : quote(check.text));
  if (check.passCriteria) {
    out.push(`${hashes} Pass criteria, verbatim`);
    out.push(quote(check.passCriteria));
  }
  const notes: string[] = [];
  if (check.source) {
    notes.push(`Where the full test is defined, as the reviewer named it: ${check.source}`);
  }
  if (check.line !== undefined) {
    notes.push(`From the plan document, line ${check.line}`);
  }
  if (check.origin === "reviewer") {
    notes.push("Derived from the sparring report's own wording, not from a structured gate");
  }
  if (check.evidence) {
    notes.push(`Already recorded in notes.md: ${check.evidence.excerpt}`);
  } else if (check.record?.outcome) {
    notes.push(`Drafted result, not yet submitted: ${check.record.outcome}${check.record.note ? ` — ${check.record.note}` : ""}`);
  } else {
    notes.push("No result recorded for it yet");
  }
  out.push(notes.map(bullet).join("\n"));
  return out.join("\n\n");
}

/** The stage's own section of the plan document, when the stage was located in one. */
function planSection(source: ReviewCopySource): { where: string; text: string } | undefined {
  const plan = source.model.plan;
  const text = plan?.source === "managed" ? source.artifacts.planText : source.artifacts.associatedPlan?.text;
  if (!plan?.currentLine || !text) {
    return undefined;
  }
  const body = extractPlanSection(text, plan.currentLine);
  return body?.trim() ? { where: `From ${plan.name}, line ${plan.currentLine}`, text: body.trim() } : undefined;
}

const FOOTER = [
  "---",
  "",
  "Copied from the Agent Sparring VS Code extension. Every line above comes from the workflow's own recorded files — the plan document, the stage's brief, handoff.md, sparring.md and notes.md. It contains no provider prompts, no model reasoning, no command output and no activity log.",
].join("\n");

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`;
}

function bullet(text: string): string {
  return `- ${text}`;
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * A long quoted block, cut at a line boundary rather than mid-sentence, with
 * the file it came from named so the reader knows what was left out. The point
 * of the copy is to fit in a chat message; a 200 KB handoff does not.
 */
function clip(text: string, what: string, max = COPY_SECTION_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const head = trimmed.slice(0, max);
  const cut = head.lastIndexOf("\n");
  const kept = (cut > max / 2 ? head.slice(0, cut) : head).trimEnd();
  return `${kept}\n\n[… truncated here; the rest is in ${what}.]`;
}

function join(parts: string[]): string {
  return `${parts.filter((part) => part.trim()).join("\n\n")}\n`;
}
