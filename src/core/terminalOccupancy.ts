/**
 * Which of the terminals this extension owns may be sent the next command.
 *
 * A lease says "Agent Sparring is running something here". It never said
 * anything about the shell itself, and the shell is what matters: a person
 * who starts an interactive CLI in `Agent Sparring — <project>` after a run
 * has finished owns that shell's foreground for as long as they keep it.
 * Handing such a terminal a command line does not run it — it is typed into
 * whatever is reading stdin (the reported defect: a `sparring run-plan …`
 * line inserted into a Claude prompt) — and `executeCommand` is documented
 * to send ^C first "as necessary to interrupt any running command", which
 * would take the person's work away from them.
 *
 * So availability is decided from everything known about the terminal, not
 * from the lease alone:
 *
 *  - `exited` — the shell is gone; the tab may linger, the terminal may not
 *    be reused;
 *  - `leased` — Agent Sparring is running a command there;
 *  - `activeExecutions` — shell executions running there right now, whoever
 *    started them; one is enough, because a shell runs one foreground
 *    command at a time;
 *  - `observable` — whether this window has watched this terminal's shell
 *    executions from the moment it created it. Without that history there is
 *    no way to tell an idle shell from an occupied one, and "the pool knows
 *    of no execution" must never be read as "the shell is idle": a terminal
 *    restored by VS Code after a window reload, or one whose shell never
 *    reported integration, is left alone and a fresh one is opened.
 *
 * Reuse is still the normal case — one idle terminal per project, so a plan's
 * long series of engine commands does not leave a row of dead tabs.
 */

export interface OwnedTerminalState {
  /** The project directory this terminal was opened for; projects never share one. */
  cwd: string;
  /** Its shell has exited. */
  exited: boolean;
  /** An Agent Sparring command holds it. */
  leased: boolean;
  /** Shell executions currently running in it, started by anyone. */
  activeExecutions: number;
  /** This window has watched its shell executions since it created it. */
  observable: boolean;
}

export type Unavailability = "exited" | "leased" | "occupied" | "unobservable";

/** Why this terminal may not be sent a command, or undefined when it may. */
export function unavailability(state: OwnedTerminalState): Unavailability | undefined {
  if (state.exited) {
    return "exited";
  }
  if (!state.observable) {
    return "unobservable";
  }
  if (state.leased) {
    return "leased";
  }
  if (state.activeExecutions > 0) {
    return "occupied";
  }
  return undefined;
}

export type TerminalChoice =
  /** Reuse `states[index]`: this project's terminal is genuinely idle. */
  | { kind: "reuse"; index: number }
  /** Open one: `because` names what stopped the existing one from being used, when there was one. */
  | { kind: "create"; because?: Unavailability };

/**
 * The terminal for the next command in `cwd`: this project's idle one, or a
 * new one. When more than one is unusable the most informative reason is
 * reported, so the log says *why* a second terminal was opened.
 */
export function chooseOwnedTerminal(states: readonly OwnedTerminalState[], cwd: string): TerminalChoice {
  const mine = states.map((state, index) => ({ state, index })).filter(({ state }) => state.cwd === cwd);
  const idle = mine.find(({ state }) => unavailability(state) === undefined);
  if (idle) {
    return { kind: "reuse", index: idle.index };
  }
  // "exited" is about a terminal that is already being dropped and explains
  // nothing about occupancy, so it is the least informative reason.
  const order: Unavailability[] = ["occupied", "unobservable", "leased", "exited"];
  const reasons = mine.map(({ state }) => unavailability(state) as Unavailability);
  const because = order.find((reason) => reasons.includes(reason));
  return { kind: "create", because };
}

/** What the log says about opening one rather than reusing this project's terminal. */
export function explainCreation(because: Unavailability | undefined, name: string, cwd: string): string {
  switch (because) {
    case "occupied":
      return `opened ${name}: this project's terminal is running another command, so nothing was written into it`;
    case "leased":
      return `opened ${name}: this project's terminal is busy with an Agent Sparring command`;
    case "unobservable":
      return `opened ${name}: whether this project's existing terminal is idle cannot be established, so it is left alone`;
    case "exited":
      return `opened ${name}: this project's previous terminal's shell had exited`;
    default:
      return `opened the terminal ${name} for ${cwd}`;
  }
}
