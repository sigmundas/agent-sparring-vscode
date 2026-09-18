/**
 * A `vscode` module for tests that need the extension-host code itself
 * rather than a core function.
 *
 * Admission is a concurrency property of `executionTracker.ts` and
 * `commandRunner.ts`, and the interleaving that used to break it is measured
 * in microtasks: the second invocation has to arrive at an exact point in the
 * first one's asynchronous preparation. The integration suite (which runs in
 * a real extension host with real terminals) cannot place it there, because
 * nothing there decides when shell integration appears or when a shell
 * reports a start.
 *
 * So the API those two modules actually use is provided here instead, with
 * every event under the test's control: shell integration appears when the
 * test says so, an execution starts when the test says so. Nothing is
 * simulated beyond that — the code under test is the production code, and
 * what it does with a terminal is recorded rather than faked away.
 *
 * `install()` must be called before the module under test is required, which
 * is why those tests import it with `await import(...)`.
 */

import Module from "node:module";

export interface Disposable {
  dispose(): void;
}

class Emitter<T> {
  private listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((item) => item !== listener)) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  /** How many listeners are waiting — how a test knows the code has reached its await. */
  get waiting(): number {
    return this.listeners.length;
  }
  dispose(): void {
    this.listeners = [];
  }
}

/** One command handed to a shell, as the code under test sees it. */
export class FakeExecution {
  readonly commandLine: { value: string; confidence: number; isTrusted: boolean };
  constructor(commandLine: string, readonly terminal: FakeTerminal) {
    this.commandLine = { value: commandLine, confidence: 2, isTrusted: true };
  }
  read(): AsyncIterable<string> {
    return {
      async *[Symbol.asyncIterator]() {
        // A shell that exposes no output stream; collectOutput handles it.
      },
    };
  }
}

export class FakeShellIntegration {
  /** Every command line this shell was given, in order. The duplicate detector. */
  readonly executed: string[] = [];
  readonly cwd = undefined;
  constructor(private readonly terminal: FakeTerminal) {}
  executeCommand(word: string, args?: string[]): FakeExecution {
    const commandLine = args ? [word, ...args].join(" ") : word;
    this.executed.push(commandLine);
    const execution = new FakeExecution(commandLine, this.terminal);
    this.terminal.executions.push(execution);
    return execution;
  }
}

export class FakeTerminal {
  shellIntegration: FakeShellIntegration | undefined;
  exitStatus: { code: number | undefined } | undefined;
  readonly executions: FakeExecution[] = [];
  shown = 0;
  constructor(readonly name: string, readonly pid = 4242) {}
  get processId(): Promise<number> {
    return Promise.resolve(this.pid);
  }
  show(): void {
    this.shown += 1;
  }
  sendText(): void {
    throw new Error("a test terminal is never written to as text");
  }
  dispose(): void {
    this.exitStatus = { code: 0 };
    stub.window.closeEmitter.fire(this);
  }
  /**
   * The terminal goes away without the pty host reporting an exit code —
   * what `terminal.dispose()` on a terminal whose process ignores or
   * survives the hangup looks like, and what a person closing the tab looks
   * like. Deliberately distinct from `dispose()`, which reports code 0 and
   * is therefore evidence that the process exited.
   */
  close(): void {
    this.exitStatus = { code: undefined };
    stub.window.closeEmitter.fire(this);
  }
  /** Shell integration appears, which is what a held launch is waiting for. */
  integrate(): FakeShellIntegration {
    const integration = new FakeShellIntegration(this);
    this.shellIntegration = integration;
    stub.window.integrationEmitter.fire({ terminal: this, shellIntegration: integration });
    return integration;
  }
}

const startEmitter = new Emitter<{ terminal: FakeTerminal; shellIntegration: FakeShellIntegration; execution: FakeExecution }>();
const endEmitter = new Emitter<{ terminal: FakeTerminal; shellIntegration: FakeShellIntegration; execution: FakeExecution; exitCode: number | undefined }>();
const closeEmitter = new Emitter<FakeTerminal>();
const openEmitter = new Emitter<FakeTerminal>();
const integrationEmitter = new Emitter<{ terminal: FakeTerminal; shellIntegration: FakeShellIntegration }>();

const stub = {
  EventEmitter: Emitter,
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
  env: { shell: "/bin/zsh" },
  window: {
    startEmitter,
    endEmitter,
    closeEmitter,
    openEmitter,
    integrationEmitter,
    terminals: [] as FakeTerminal[],
    onDidStartTerminalShellExecution: startEmitter.event,
    onDidEndTerminalShellExecution: endEmitter.event,
    onDidCloseTerminal: closeEmitter.event,
    onDidOpenTerminal: openEmitter.event,
    onDidChangeTerminalShellIntegration: integrationEmitter.event,
    /** Dedicated terminals the code under test created, in order. */
    created: [] as { name: string; shellPath?: string; shellArgs?: string[] }[],
    /**
     * The process id the next created terminal reports. A dedicated
     * terminal's process *is* the engine, so a test that wants a real process
     * behind one sets its real pid here.
     */
    nextTerminalPid: undefined as number | undefined,
    createTerminal(options: { name: string; shellPath?: string; shellArgs?: string[] }): FakeTerminal {
      stub.window.created.push(options);
      const terminal = new FakeTerminal(options.name, stub.window.nextTerminalPid);
      stub.window.nextTerminalPid = undefined;
      stub.window.terminals.push(terminal);
      openEmitter.fire(terminal);
      return terminal;
    },
  },
};

export type VscodeStub = typeof stub;

let installed = false;

/** Make `require("vscode")` resolve to the stub, for the rest of this process. */
export function install(): VscodeStub {
  if (!installed) {
    type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
    const host = Module as unknown as { _load: Loader };
    const original = host._load;
    host._load = (request, parent, isMain) => (request === "vscode" ? stub : original.call(Module, request, parent, isMain));
    installed = true;
  }
  return stub;
}

/** Forget everything the previous test recorded, without reinstalling the module. */
export function reset(): void {
  stub.window.terminals.length = 0;
  stub.window.created.length = 0;
  stub.window.nextTerminalPid = undefined;
}

/** Let queued microtasks and timers run, so the code under test reaches its next await. */
export function settle(turns = 4): Promise<void> {
  return new Promise((resolve) => {
    let left = turns;
    const tick = () => (left-- <= 0 ? resolve() : setTimeout(tick, 0));
    tick();
  });
}

/**
 * Wait until `condition` holds. Everything inside the extension host is
 * driven by the test, so this is only ever waiting for microtasks — except
 * where a real child process is involved, hence the generous budget.
 */
export async function until<T>(condition: () => T | undefined | Promise<T | undefined>, what: string, budgetMs = 10_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await condition();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await settle(1);
  }
}
