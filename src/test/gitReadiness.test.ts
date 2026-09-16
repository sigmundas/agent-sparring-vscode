/**
 * Readiness of the built-in Git extension's repository list.
 *
 * The reproduced failure: `ready()` resolved while the Git API's own state was
 * still `uninitialized` and its `repositories` array was empty, because the
 * only thing being waited for was the API *object*. `Run plan…` then offered
 * the `.sparring` locations discovery had found and nothing else — missing
 * exactly the first-run repositories that exist nowhere but the Git
 * extension's answer — and only during the first seconds of a window.
 *
 * Every branch here is a real ordering the window can produce, and each is
 * driven directly rather than waited for, so nothing in this file depends on
 * timing:
 *
 *  - attached while still scanning, then discovery finishes;
 *  - attached *after* discovery already finished (no event will ever fire);
 *  - the extension disabled, missing, or offering no API version 1;
 *  - the window disposed with a caller still waiting;
 *  - discovery going back to `uninitialized` (the extension rescans).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitReadinessFold, describeReadiness, isSettled, repositoriesAreKnown } from "../core/gitReadiness";

/** Whether a waiter registered now would be resolved now. */
function settlesImmediately(fold: GitReadinessFold): boolean {
  let resolved = false;
  const cancel = fold.onSettled(() => {
    resolved = true;
  });
  cancel();
  return resolved;
}

describe("git readiness", () => {
  it("starts out having been told nothing, and is neither ready nor empty", () => {
    const fold = new GitReadinessFold();
    assert.equal(fold.readiness, "attaching");
    assert.equal(fold.settled, false, "nothing may stop waiting yet");
    assert.equal(fold.repositoriesKnown, false, "and no repository list may be believed");
  });

  it("is still not ready once the API is attached but its state is uninitialized", () => {
    const fold = new GitReadinessFold();
    assert.equal(fold.attached("uninitialized"), "uninitialized");
    assert.equal(fold.settled, false, "the API object existing is not repository discovery being done");
    assert.equal(fold.repositoriesKnown, false, "an empty repositories array here means 'not yet', not 'none'");
  });

  it("becomes ready when discovery finishes, and releases whoever was waiting", () => {
    const fold = new GitReadinessFold();
    fold.attached("uninitialized");
    let released = 0;
    fold.onSettled(() => {
      released++;
    });
    fold.onSettled(() => {
      released++;
    });
    assert.equal(released, 0, "not before");
    assert.equal(fold.stateChanged("initialized"), "initialized");
    assert.equal(released, 2, "every waiter, exactly once");
    assert.equal(fold.repositoriesKnown, true);
  });

  it("is ready the instant it attaches to an API that had already finished", () => {
    // The ordinary case in a window that activated late: `onDidChangeState`
    // has already fired and will not fire again, so reading `API.state` at
    // attach time is the only thing that can settle this.
    const fold = new GitReadinessFold();
    assert.equal(fold.attached("initialized"), "initialized");
    assert.equal(fold.settled, true);
    assert.equal(settlesImmediately(fold), true, "a waiter registered afterwards resolves at once");
  });

  it("settles rather than hangs when the Git extension is unavailable", () => {
    // Not installed, disabled, activation failed, or no API version 1. The
    // question has been answered — it cannot be answered — and a caller that
    // waited for a state event here would wait for ever.
    const fold = new GitReadinessFold();
    assert.equal(fold.unavailable(), "unavailable");
    assert.equal(fold.settled, true, "waiting longer cannot help, so nothing waits");
    assert.equal(fold.repositoriesKnown, false, "but nothing is claimed either");
    assert.equal(settlesImmediately(fold), true);
  });

  it("lets an extension that becomes available afterwards take over", () => {
    // Installing or enabling the Git extension fires
    // `vscode.extensions.onDidChange`, attaching is retried, and the earlier
    // failure must not be sticky.
    const fold = new GitReadinessFold();
    fold.unavailable();
    assert.equal(fold.attached("uninitialized"), "uninitialized");
    assert.equal(fold.repositoriesKnown, false);
    assert.equal(fold.stateChanged("initialized"), "initialized");
    assert.equal(fold.repositoriesKnown, true);
  });

  it("stops believing the list if discovery starts again", () => {
    const fold = new GitReadinessFold();
    fold.attached("initialized");
    assert.equal(fold.repositoriesKnown, true);
    assert.equal(fold.stateChanged("uninitialized"), "uninitialized");
    assert.equal(fold.repositoriesKnown, false, "a rescan means the list is not final again");
  });

  it("releases every waiter on disposal and accepts nothing afterwards", () => {
    const fold = new GitReadinessFold();
    fold.attached("uninitialized");
    let released = 0;
    fold.onSettled(() => {
      released++;
    });
    fold.dispose();
    assert.equal(released, 1, "a closing window must not leave a promise nothing will settle");
    assert.equal(fold.settled, true);
    assert.equal(fold.repositoriesKnown, false, "a disposed tracker claims nothing");
    assert.equal(fold.stateChanged("initialized"), "uninitialized", "and does not move on afterwards");
    assert.equal(fold.repositoriesKnown, false);
    assert.equal(settlesImmediately(fold), true, "a late waiter is resolved rather than stranded");
  });

  it("cancels a waiter without releasing it, so a bounded wait leaks nothing", () => {
    const fold = new GitReadinessFold();
    fold.attached("uninitialized");
    let released = 0;
    const cancel = fold.onSettled(() => {
      released++;
    });
    cancel();
    fold.stateChanged("initialized");
    assert.equal(released, 0, "a cancelled waiter is gone");
  });

  it("says what state it is in without claiming more", () => {
    for (const readiness of ["attaching", "uninitialized", "initialized", "unavailable"] as const) {
      const said = describeReadiness(readiness);
      assert.ok(said.length > 0);
      assert.equal(isSettled(readiness), readiness === "initialized" || readiness === "unavailable");
      assert.equal(repositoriesAreKnown(readiness), readiness === "initialized");
      if (readiness !== "initialized") {
        assert.doesNotMatch(said, /\bno repositories are open\b/i, "never a claim that the workspace has none");
      }
    }
  });
});
