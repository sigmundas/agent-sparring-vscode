/**
 * When the built-in Git extension can be *believed* about which repositories
 * exist — which is not the same moment as when its API object exists.
 *
 * ### The two moments, and why conflating them was wrong
 *
 * `vscode.extensions.getExtension("vscode.git").activate()` resolves with the
 * extension's exports, and `getAPI(1)` hands back an `API` immediately. None
 * of that means the repositories have been found: the Git extension scans the
 * workspace asynchronously and publishes its progress as
 *
 * ```
 *   API.state: "uninitialized" | "initialized"
 *   API.onDidChangeState: Event<APIState>
 * ```
 *
 * both of which are part of API version 1 (verified against the shipped
 * extension, version 10.0.0: the API object exposes `state` and
 * `onDidChangeState` as public getters onto its model). While the state is
 * `uninitialized`, `API.repositories` is legitimately empty and means
 * *nothing found yet*.
 *
 * Treating "the API exists" as readiness therefore produced a wrong answer at
 * exactly the wrong time. `Run plan…` offers repositories that have no
 * `.sparring` at all, and those exist *only* in the Git extension's answer —
 * so during the first seconds of a window it offered nothing but the
 * `.sparring` locations discovery had found, and a first-run repository was
 * simply missing from the list. Worse, an empty `repositories` array was
 * read as "an active extension with no repository open", which is a positive
 * claim; it must be `undefined`, the honest "told us nothing yet", so callers
 * degrade instead of concluding.
 *
 * ### The fold
 *
 * {@link GitReadinessFold} is the whole rule as data, so every branch can be
 * tested without a VS Code window:
 *
 *  - `attaching` — nothing has answered yet. Not ready; `repositories` is
 *    unknown.
 *  - `uninitialized` — the API is attached and is still scanning. Not ready;
 *    `repositories` is still unknown, because an empty list here is not an
 *    empty workspace.
 *  - `initialized` — ready, and `repositories` may be believed.
 *  - `unavailable` — the extension is not installed, is disabled, failed to
 *    activate, or offers no API version 1. **Ready**, in the only sense that
 *    matters to a caller: waiting longer cannot help, so nothing waits. The
 *    answer is "unknown", and a caller that needed repository knowledge says
 *    so rather than hanging or pretending.
 *
 * `unavailable` is deliberately not terminal — installing or enabling the
 * extension fires `vscode.extensions.onDidChange` and attaching is retried —
 * but a *waiter* is never left holding a promise for that, because it may
 * never happen.
 *
 * No dependency on the vscode API.
 */

/** How much the Git extension has told us, in one word. */
export type GitReadiness = "attaching" | "uninitialized" | "initialized" | "unavailable";

/** The Git extension's own `APIState`, as API version 1 publishes it. */
export type GitApiState = "uninitialized" | "initialized";

/**
 * Whether a caller waiting for repository discovery may stop waiting.
 *
 * `unavailable` counts: the question has been answered, and the answer is
 * that it cannot be answered. That distinction is what keeps `ready()` from
 * being an unbounded wait in a window with no Git extension.
 */
export function isSettled(readiness: GitReadiness): boolean {
  return readiness === "initialized" || readiness === "unavailable";
}

/** Whether `API.repositories` may be read as the truth about what is open. */
export function repositoriesAreKnown(readiness: GitReadiness): boolean {
  return readiness === "initialized";
}

/** One sentence for the Output Channel and the diagnostic; never a claim beyond the state. */
export function describeReadiness(readiness: GitReadiness): string {
  switch (readiness) {
    case "attaching":
      return "the built-in Git extension has not answered yet; no repository is known";
    case "uninitialized":
      return "the built-in Git extension is attached and still finding repositories; its list is not final yet";
    case "initialized":
      return "the built-in Git extension has finished finding repositories";
    case "unavailable":
      return "the built-in Git extension is unavailable (not installed, disabled, or offering no API version 1); no repository can be known through it";
  }
}

/**
 * The readiness state and the waiters on it, with the transitions kept
 * explicit so the awkward orderings are testable: attach before the first
 * state event, a state event before attach completes, a window disposed with
 * someone still waiting.
 *
 * Every waiter is resolved exactly once, and disposal resolves all of them —
 * a window closing must not leave a promise that nothing will ever settle.
 */
export class GitReadinessFold {
  private current: GitReadiness = "attaching";
  private disposed = false;
  private readonly waiters = new Set<() => void>();

  get readiness(): GitReadiness {
    return this.current;
  }

  /** Whether a caller may stop waiting: settled, or the window is going away. */
  get settled(): boolean {
    return this.disposed || isSettled(this.current);
  }

  /** Whether `API.repositories` may be believed right now. */
  get repositoriesKnown(): boolean {
    return !this.disposed && repositoriesAreKnown(this.current);
  }

  /**
   * The API attached and reported a state. Called with the state read from
   * `API.state` at the moment of attaching, so a window that attaches after
   * discovery has already finished is ready immediately and never waits for
   * an `onDidChangeState` that has already fired.
   */
  attached(state: GitApiState): GitReadiness {
    return this.moveTo(state);
  }

  /** `API.onDidChangeState`. */
  stateChanged(state: GitApiState): GitReadiness {
    // A state event that arrives while we believe the extension is
    // unavailable is news, not noise: it can only come from an API we are
    // subscribed to, so it supersedes the earlier failure.
    return this.moveTo(state);
  }

  /**
   * Attaching cannot succeed for now: not installed, disabled, activation
   * failed, or no API version 1. Settled rather than pending, so nothing
   * waits on an event that may never come; a later `onDidChange` can still
   * move it on.
   */
  unavailable(): GitReadiness {
    return this.moveTo("unavailable");
  }

  /** The window is going away. Every waiter is released; none is left pending. */
  dispose(): void {
    this.disposed = true;
    this.release();
  }

  /**
   * Resolve once readiness is settled or the fold is disposed, whichever
   * happens first. `register` hands back a cancel function so the caller can
   * attach its own bound (a timeout) without leaking a waiter.
   */
  onSettled(resolve: () => void): () => void {
    if (this.settled) {
      resolve();
      return () => {};
    }
    this.waiters.add(resolve);
    return () => this.waiters.delete(resolve);
  }

  private moveTo(next: GitReadiness): GitReadiness {
    if (this.disposed) {
      return this.current;
    }
    this.current = next;
    if (isSettled(next)) {
      this.release();
    }
    return this.current;
  }

  private release(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter();
    }
  }
}
