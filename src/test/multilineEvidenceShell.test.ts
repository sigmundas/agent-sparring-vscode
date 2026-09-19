import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { buildResumePlanArgs, planShellHandover, shellFamily } from "../core/cli";
import { fourCheckEvidence } from "./fixtures/fourCheckEvidence";

const run = promisify(execFile);

it("the real four-check evidence is one complete interactive zsh command, with no quote prompt", { skip: process.platform === "win32" }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sparring-four-checks-"));
  try {
    const reporter = path.join(cwd, "sparring");
    const argvFile = path.join(cwd, "argv.json");
    await fs.writeFile(reporter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const evidence = fourCheckEvidence();
    assert.ok(evidence.includes("\n") && evidence.includes("5–95") && evidence.includes("—"));
    assert.equal((evidence.match(/ · check `/g) ?? []).length, 4);
    assert.equal((evidence.match(/ · gate `/g) ?? []).length, 4);
    const args = buildResumePlanArgs({ source: "markdown", planPath: path.join(cwd, "docs/plans/active/2026-09-19-add-reference-dialog-redesign-continuation.md"), repoRoot: cwd, expectedBranch: "feature/add-reference-dialog-redesign", evidence });
    assert.equal(args.length, 8);
    const handover = planShellHandover(reporter, args, shellFamily("/bin/zsh", process.platform));
    assert.equal(handover.via, "command-line");
    if (handover.via !== "command-line") { throw new Error("expected a shell command"); }
    const requestFile = path.join(cwd, "request.json");
    await fs.writeFile(requestFile, JSON.stringify({ shell: "/bin/zsh", cwd, line: handover.commandLine }));
    const { stdout } = await run("python3", [path.join(__dirname, "../../src/test/fixtures/interactiveShell.py"), requestFile]);
    const result = JSON.parse(stdout) as { output: string; returnedToPrompt: boolean };
    assert.equal(result.returnedToPrompt, true, "zsh must finish parsing and return to its primary prompt");
    assert.deepEqual(JSON.parse(await fs.readFile(argvFile, "utf8")), args, "all eight arguments arrive byte for byte");
    assert.doesNotMatch(result.output, /SPARRING_SECONDARY|quote>/, "the transport must not enter quote-continuation mode");
    assert.doesNotMatch(handover.commandLine, /[\r\n]/, "there is exactly one physical command line");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
