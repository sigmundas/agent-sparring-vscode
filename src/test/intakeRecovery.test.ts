/**
 * Recovering an intake whose source plan was edited after intake read it.
 *
 * Held here:
 *  - the plan unchanged: no recovery, the ordinary approve action;
 *  - the plan changed: the one action is "Prepare updated intake", never an
 *    approval, and the digest is compared as approve-plan compares it
 *    (Python's newline translation included);
 *  - an intake already prepared from the plan as it is now is followed
 *    rather than prepared again;
 *  - prepare-plan is re-run from the same project, in the same mode, with
 *    every context repository the previous intake was given — not only the
 *    active one — and a person's resolution replaces only the stale one;
 *  - a recorded mapping is reused only while it is still the root of the
 *    same git repository;
 *  - a failed prepare is shown on the intake that is still selected;
 *  - approve-plan gets each sibling repository a slice declares, proposed from
 *    what intake inspected and confirmed by the person.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, type DiscoveredIntake, type SparringLocation } from "../core/discovery";
import { intakeSourceChanged, sourcePlanDigest } from "../core/intake";
import { approveInvocation, preparedFromCurrentPlan, prepareInvocation, proposeSiblingMappings, staleContextRepositories } from "../core/intakeActions";
import { isIntakeActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, intakeView } from "../core/overviewModel";
import { checkedOutBranch, checkRepositoryMapping } from "../core/repositoryMapping";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");
const INTAKE_ID = "plan-61bf2008-20260927T204930Z-faithful-fb55";

async function copyTree(from: string, to: string, base: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyTree(source, target, base);
    } else {
      await fs.writeFile(target, (await fs.readFile(source, "utf8")).split("__ROOT__").join(base));
    }
  }
}

/** A prepared (unapproved) fixture intake in `<base>/app`, with `<base>/web` as its context repository. */
async function prepared(): Promise<{ base: string; root: string; location: SparringLocation; intake: DiscoveredIntake; planPath: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-intake-recovery-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, "approved"), root, base);
  const intakeDir = path.join(root, ".sparring", "intake", INTAKE_ID);
  await fs.rm(path.join(intakeDir, "runs"), { recursive: true });
  await fs.rm(path.join(root, ".sparring", "intake", "registry"), { recursive: true });
  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: "app" };
  const intake = await only(location);
  return { base, root, location, intake, planPath: path.join(root, "docs", "plan.md") };
}

async function only(location: SparringLocation): Promise<DiscoveredIntake> {
  const discovery = await discoverRuns([location]);
  assert.equal(discovery.intakes?.length, 1, JSON.stringify(discovery.problems));
  return discovery.intakes![0];
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

describe("whether the source plan changed", () => {
  it("unchanged: nothing to recover, and the screen offers approval as before", async () => {
    const { intake } = await prepared();
    assert.equal(await intakeSourceChanged(intake.record), false);
    const view = intakeView(intake, undefined);
    assert.equal(view.action?.kind, "approve");
    assert.equal(view.recovery, undefined);
  });

  it("compares the text as approve-plan reads it: CRLF line endings alone are not a change", async () => {
    const { intake, planPath } = await prepared();
    const text = await fs.readFile(planPath, "utf8");
    await fs.writeFile(planPath, text.replace(/\n/g, "\r\n"));
    assert.equal(await intakeSourceChanged(intake.record), false);
    await fs.writeFile(planPath, text + "\nAmended.\n");
    assert.equal(await intakeSourceChanged(intake.record), true);
    assert.equal(await sourcePlanDigest(planPath), createHash("sha256").update(text + "\nAmended.\n").digest("hex"));
  });

  it("an unreadable plan is not reported as changed", async () => {
    const { intake, planPath } = await prepared();
    await fs.rm(planPath);
    assert.equal(await intakeSourceChanged(intake.record), undefined);
  });
});

describe("the recovery action", () => {
  it("changed, no newer intake: Prepare updated intake replaces Approve, and it is a valid intake message", async () => {
    const { intake } = await prepared();
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined, { handoff: false, sparring: false, brief: false, plan: false, intakeRecovery: {} });
    assert.equal(model.kind, "intake");
    const action = model.intake!.action!;
    assert.equal(action.kind, "prepare");
    assert.equal(action.label, "Prepare updated intake");
    assert.equal(action.runId, INTAKE_ID, "the click names the exact intake it was drawn for");
    assert.ok(isIntakeActionMessage({ type: "intake", action: "prepare", intakeDir: action.intakeDir, runId: action.runId }));
    assert.doesNotMatch(renderOverviewHtml(model, "nonce", "csp"), /data-intake="approve"/, "no approval is offered while the plan differs");
  });

  it("changed, newer intake of the current plan exists: it is followed, not prepared again", async () => {
    const { intake, planPath, location } = await prepared();
    await fs.appendFile(planPath, "\nAmended.\n");
    const digest = (await sourcePlanDigest(planPath))!;
    const newer = { ...intake, record: { ...intake.record, intakeId: "newer", createdAtMs: (intake.record.createdAtMs ?? 0) + 1000, sourceDigest: digest } };
    const olderOfOldText = { ...intake, record: { ...intake.record, intakeId: "later-but-old-text", createdAtMs: (intake.record.createdAtMs ?? 0) + 2000 } };
    assert.equal(preparedFromCurrentPlan(intake, [intake, olderOfOldText, newer], digest)?.record.intakeId, "newer");
    assert.equal(preparedFromCurrentPlan(intake, [intake, olderOfOldText], digest), undefined);
    const elsewhere = { ...newer, location: { ...location, projectDir: "/other" } };
    assert.equal(preparedFromCurrentPlan(intake, [intake, elsewhere], digest), undefined, "another project's intake is not this plan's");
    const view = intakeView(intake, undefined, undefined, undefined, undefined, { newerIntakeId: "newer" });
    assert.equal(view.action?.label, "Open updated intake");
  });

  it("a failed prepare is shown on the intake still selected, with the action offered again", async () => {
    const { intake } = await prepared();
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined, { handoff: false, sparring: false, brief: false, plan: false, intakeRecovery: { failure: "could not prepare plan: codex exited 1" } });
    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.match(html, /Preparing the updated intake failed\. This intake is unchanged and still selected\./);
    assert.match(html, /could not prepare plan: codex exited 1/);
    assert.equal(model.intake?.action?.kind, "prepare");
    assert.equal(model.intake?.action?.enabled, true);
  });

  it("while preparing, the action is disabled", async () => {
    const { intake } = await prepared();
    const view = intakeView(intake, undefined, undefined, undefined, undefined, { preparing: true });
    assert.equal(view.action?.label, "Preparing…");
    assert.equal(view.action?.enabled, false);
  });
});

describe("prepare-plan again", () => {
  it("runs from the preparing project, in its mode, with the context repositories intake was given", async () => {
    const { base, root, intake } = await prepared();
    const invocation = prepareInvocation(intake);
    assert.ok(invocation.ok);
    assert.equal(invocation.cwd, root);
    assert.deepEqual(invocation.args, ["prepare-plan", path.join(root, "docs", "plan.md"), "--mode", "faithful", "--context-repository", `web=${path.join(base, "web")}`, "--repo-root", root, "--repository-name", "app"]);
    assert.ok(!invocation.args.includes("approve-plan") && !invocation.args.includes("run-plan"));
  });

  it("multi-repository: every recorded context repository is carried forward, a person's choice replaces only the stale one", async () => {
    const { intake } = await prepared();
    const multi = { ...intake, record: { ...intake.record, contextRepositories: { web: "/code/web", landing: "/code/landing", api: "/code/api" } } };
    const invocation = prepareInvocation(multi, { landing: "/elsewhere/landing", api: null });
    assert.ok(invocation.ok);
    assert.deepEqual(invocation.contextRepositories, { web: "/code/web", landing: "/elsewhere/landing" });
    const pairs = invocation.args.filter((_, index) => invocation.args[index - 1] === "--context-repository");
    assert.deepEqual(pairs, ["landing=/elsewhere/landing", "web=/code/web"]);
  });

  it("an intake that did not record context_repositories falls back to every inspected repository but its own", async () => {
    const { intake } = await prepared();
    const legacy = { ...intake, record: { ...intake.record, contextRepositories: undefined } };
    const invocation = prepareInvocation(legacy);
    assert.ok(invocation.ok);
    assert.deepEqual(Object.keys(invocation.contextRepositories), ["web"]);
  });
});

describe("reusing a recorded repository mapping", () => {
  it("still the root of the same repository: inherited without asking", async () => {
    const { base, intake } = await prepared();
    const web = path.join(base, "web");
    gitInit(web);
    assert.deepEqual(await staleContextRepositories(intake, checkRepositoryMapping), []);
  });

  it("gone, not a repository root, or a different repository: only that mapping is put to the person", async () => {
    const { base, intake } = await prepared();
    const web = path.join(base, "web");
    assert.match((await staleContextRepositories(intake, checkRepositoryMapping))[0]?.reason ?? "", /no longer exists/);
    await fs.mkdir(web, { recursive: true });
    assert.match((await staleContextRepositories(intake, checkRepositoryMapping))[0]?.reason ?? "", /not a git repository/);
    // A different repository at the same path: its git directory is not the one intake recorded.
    const other = path.join(base, "other");
    gitInit(other);
    const moved = { ...intake, record: { ...intake.record, repositoryGitDirs: { web: path.join(other, ".git") } } };
    gitInit(web);
    const stale = await staleContextRepositories(moved, checkRepositoryMapping);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].name, "web");
    assert.match(stale[0].reason, /different git repository/);
  });

  it("a subdirectory of a repository is not its root", async () => {
    const { base } = await prepared();
    const repo = path.join(base, "repo");
    gitInit(repo);
    await fs.mkdir(path.join(repo, "sub"));
    assert.deepEqual(await checkRepositoryMapping("x", path.join(repo, "sub"), undefined), { valid: false, reason: "it is not the root of a git repository" });
  });
});

describe("approve-plan's sibling repositories", () => {
  it("each declared sibling is proposed at the path intake inspected and the branch checked out there now", async () => {
    const { base, intake } = await prepared();
    const web = path.join(base, "web");
    gitInit(web);
    execFileSync("git", ["-C", web, "checkout", "-q", "-b", "feature/web-3w"]);
    const slice = { ...intake.slices[0], requirements: { ...intake.slices[0].requirements!, siblings: ["web"] } };
    assert.deepEqual(await proposeSiblingMappings(intake, slice, checkRepositoryMapping, checkedOutBranch), [{ name: "web", path: web, branch: "feature/web-3w" }]);
  });

  it("a stale or uninspected sibling is proposed with its problem, so only it is asked for", async () => {
    const { intake } = await prepared();
    const slice = { ...intake.slices[0], requirements: { ...intake.slices[0].requirements!, siblings: ["landing", "web"] } };
    const proposals = await proposeSiblingMappings(intake, slice, checkRepositoryMapping, async () => "main");
    assert.equal(proposals.length, 2);
    assert.match(proposals[0].problem ?? "", /did not inspect/);
    assert.match(proposals[1].problem ?? "", /no longer exists/);
  });

  it("confirmed siblings reach approve-plan as --repository / --repository-branch pairs, for every one", async () => {
    const { intake } = await prepared();
    const slice = intake.slices[0];
    const invocation = approveInvocation(intake, slice, [], { web: { path: "/code/web", branch: "feature/w" }, api: { path: "/code/api", branch: "main" } });
    assert.ok(invocation.ok);
    const tail = invocation.args.slice(invocation.args.indexOf("--repository-name") + 2);
    assert.deepEqual(tail, ["--repository", "api=/code/api", "--repository-branch", "api=main", "--repository", "web=/code/web", "--repository-branch", "web=feature/w"]);
  });

  it("a slice with no siblings proposes none", async () => {
    const { intake } = await prepared();
    const slice = { ...intake.slices[0], requirements: { ...intake.slices[0].requirements!, siblings: [] } };
    assert.deepEqual(await proposeSiblingMappings(intake, slice, checkRepositoryMapping, async () => "main"), []);
  });
});
