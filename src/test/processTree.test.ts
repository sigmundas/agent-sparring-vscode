import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { descendantsOf, findDescendant, parsePsOutput } from "../core/processTree";

const PS = `
    1     0 /sbin/launchd
  500     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  600   500 /bin/zsh -l
  601   600 /Users/me/.venv/bin/python /Users/me/.venv/bin/sparring run-loop stage-x --repo-root /code/app --expected-branch main
  602   601 claude -p --output-format stream-json
  700   500 /bin/zsh -l
  701   700 vim notes.md
malformed line here
`;

describe("process tree", () => {
  it("parses ps output and walks descendants", () => {
    const rows = parsePsOutput(PS);
    assert.equal(rows.length, 7);
    assert.deepEqual(
      descendantsOf(rows, 600).map((row) => row.pid),
      [601, 602],
    );
    assert.deepEqual(descendantsOf(rows, 700).map((row) => row.pid), [701]);
    assert.deepEqual(descendantsOf(rows, 9999), []);
  });

  it("finds the runner under the right shell only", () => {
    const rows = parsePsOutput(PS);
    const isRunner = (command: string) => command.includes("run-loop stage-x");
    assert.equal(findDescendant(rows, 600, isRunner)?.pid, 601);
    assert.equal(findDescendant(rows, 700, isRunner), undefined);
    assert.equal(findDescendant(rows, 601, isRunner), undefined, "the root itself is not a descendant");
  });
});
