/**
 * Just enough of a DOM to run the script the Overview actually ships.
 *
 * The regression this exists for was invisible in every rendered snapshot: the
 * markup was right, the model was right, and the buttons did nothing, because
 * the message the shipped listener posted was refused on arrival. So the tests
 * that matter here drive the shipped `<script>` string itself — attributes,
 * `closest`, delegated listeners, debounce timers and all — and cross the
 * webview↔host boundary by calling the host's own exported parser.
 *
 * What it cannot do is be a browser: `closest` and event dispatch are emulated
 * below, and there is no extension host. Everything either side of that one
 * call is the shipped code. The integration suite runs the same document in a
 * real Chromium webview inside a real VS Code for the cases where that matters.
 */

import assert from "node:assert/strict";

export interface Posted {
  type: string;
  [field: string]: unknown;
}

/** Just enough of an element for the shipped listener: attributes, `closest`, `disabled`, and a value. */
export class FakeElement {
  readonly attributes: Record<string, string>;
  disabled = false;
  value = "";
  /** The shipped disclosure script branches on this to tell a panel from a `<details>`. */
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  /** The toggle's label, which the shipped script rewrites as the panel opens and closes. */
  textContent = "";
  constructor(
    readonly tag: string,
    attributes: Record<string, string>,
    readonly parent?: FakeElement,
  ) {
    this.attributes = attributes;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  /** The shipped script stamps the value it sent onto the control itself. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  /** `button[data-check][data-outcome]` and friends: a tag plus required attributes, walked up the parents. */
  closest(selector: string): FakeElement | null {
    const [, tag, rest] = /^([a-z]+)((?:\[[^\]]+\])*)$/.exec(selector) ?? [];
    const wanted = [...(rest ?? "").matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    const matches = (node: FakeElement): boolean => node.tag === tag && wanted.every((attribute) => node.hasAttribute(attribute));
    if (matches(this)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

export class FakeTextArea extends FakeElement {}

/**
 * The two inline configuration controls, as the shipped script tests for
 * them: it branches on `instanceof HTMLSelectElement` / `HTMLInputElement`,
 * so a shim that does not provide them cannot run a change at all.
 */
export class FakeSelect extends FakeElement {}
export class FakeInput extends FakeElement {
  /** The script only acts on `type === 'text'`; the autopush box is a checkbox. */
  type = "text";
  checked = false;
}

/**
 * A `<details>` as the disclosure script sees it: an element with an `open`
 * property whose change fires a `toggle` event, which is what a real
 * browser does and what the shipped script listens for.
 */
export class FakeDetails extends FakeElement {
  constructor(
    tag: string,
    attributes: Record<string, string>,
    private readonly document: FakeDocument,
    open = false,
  ) {
    super(tag, attributes);
    this.openState = open;
  }
  private openState: boolean;
  get open(): boolean {
    return this.openState;
  }
  set open(value: boolean) {
    this.openState = value;
  }
  /** What a person clicking the summary does: toggle, then the event. */
  click(): void {
    this.openState = !this.openState;
    this.document.dispatch("toggle", this);
  }
}

/**
 * A disclosure whose control is somewhere else on the page: the instructions
 * panel, which sits after both actor cards and is opened by a button inside
 * one of them. The shipped script shows and hides it through `hidden`, so
 * that is what the shim models; `open` is the same fact read the way the
 * tests and the `<details>` above both read it.
 */
export class FakePanel extends FakeElement {
  constructor(
    tag: string,
    attributes: Record<string, string>,
    private readonly document: FakeDocument,
    hidden = true,
  ) {
    super(tag, attributes);
    this.hiddenState = hidden;
  }
  private hiddenState: boolean;
  get hidden(): boolean {
    return this.hiddenState;
  }
  set hidden(value: boolean) {
    this.hiddenState = value;
  }
  get open(): boolean {
    return !this.hiddenState;
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  /**
   * What a person does: click the card's button, not the panel. The shipped
   * click listener is what decides the panel's state, so the shim never sets
   * it directly.
   */
  click(): void {
    const toggle = this.document.toggleFor(this.id);
    assert.ok(toggle, `a card carries the toggle for ${this.id}`);
    this.document.dispatch("click", toggle);
  }
}

/** The document as the shipped script uses it: delegated listeners on one root. */
export class FakeDocument {
  private readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  /** Every `[data-disclose]` this document contains: `<details>` and panels alike. */
  readonly disclosures: (FakeDetails | FakePanel)[] = [];
  /** The `button[data-instr]` toggles, which live in the cards and point at the panels. */
  readonly toggles: FakeElement[] = [];
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /**
   * Only the one selector the shipped script uses. Anything else would be a
   * re-implementation of a query engine, and the integration suite runs the
   * same document in a real Chromium webview.
   */
  querySelectorAll(selector: string): (FakeDetails | FakePanel)[] {
    if (selector === "[data-instrpanel]") {
      return this.disclosures.filter((node): node is FakePanel => node instanceof FakePanel);
    }
    assert.equal(selector, "[data-disclose]", "the shim only answers the selectors the shipped script uses");
    return this.disclosures;
  }
  /** `document.getElementById(toggle.getAttribute('aria-controls'))`, as the script calls it. */
  getElementById(id: string): FakePanel | null {
    return this.disclosures.find((node): node is FakePanel => node instanceof FakePanel && node.id === id) ?? null;
  }
  /** `document.querySelector('[aria-controls="..."]')`, which is how the script finds a panel's toggle. */
  querySelector(selector: string): FakeElement | null {
    const id = /^\[aria-controls="([^"]*)"\]$/.exec(selector)?.[1];
    assert.ok(id !== undefined, `the shim only answers the selector the shipped script uses, not ${selector}`);
    return this.toggleFor(id);
  }
  toggleFor(id: string): FakeElement | null {
    return this.toggles.find((node) => node.getAttribute("aria-controls") === id) ?? null;
  }
  /**
   * Dispatch to the delegated listeners, and report whether any of them
   * called `preventDefault`. A control inside a `<summary>` has to prevent
   * the default toggle or the click opens the section instead of doing what
   * the control says, and that is only observable here.
   */
  dispatch(type: string, target: unknown): { defaultPrevented: boolean } {
    const event: FakeEvent = {
      target,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return { defaultPrevented: event.defaultPrevented };
  }
}

export interface FakeEvent {
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * Run the script the document actually ships, and return the DOM it bound
 * itself to plus everything it posts. Nothing here is a re-implementation: the
 * listener under test is the string inside the rendered `<script>`.
 */
/**
 * The webview's own persistent state, which is what survives the host
 * replacing `webview.html`. Passing one of these into two successive runs
 * of the script is exactly what a rerender is, from the page's point of
 * view, so a test can drive the real regression without a browser.
 */
export interface WebviewState {
  value: unknown;
}

export interface ScriptRun {
  document: FakeDocument;
  posted: Posted[];
  /** The persistent state the page kept; pass it into the next run to rerender. */
  state: WebviewState;
  /** Where the page scrolled itself to on load, if it did. */
  scrolledTo?: number;
  /** Scroll the page and let its throttled listener record the position. */
  scroll(to: number): Promise<void>;
}

/**
 * Run the script the document actually ships against a DOM built from that
 * same document's `<details data-disclose>` elements.
 *
 * `state` carries the webview's `setState` store between runs. A second run
 * with the same store is a host rerender: a fresh document, the same page
 * state — which is the only way to observe whether an opened disclosure
 * comes back.
 */
export function runWebviewScript(html: string, nonce = "n", state: WebviewState = { value: undefined }): ScriptRun {
  const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*?)</script>`).exec(html)?.[1];
  assert.ok(script, "the document ships a script");
  const document = new FakeDocument();
  for (const [markup, key] of html.matchAll(/<details[^>]*\sdata-disclose="([^"]*)"[^>]*>/g)) {
    document.disclosures.push(new FakeDetails("details", { "data-disclose": key }, document, / open[ >]/.test(markup)));
  }
  // The instructions panels and the buttons in the cards that open them.
  for (const [markup] of html.matchAll(/<button[^>]*\sdata-instr="[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const toggle = new FakeElement("button", attributesOf(markup));
    toggle.textContent = /<button[^>]*>([\s\S]*?)<\/button>/.exec(markup)?.[1] ?? "";
    document.toggles.push(toggle);
  }
  for (const [markup] of html.matchAll(/<div[^>]*\sdata-instrpanel="[^"]*"[^>]*>/g)) {
    document.disclosures.push(new FakePanel("div", attributesOf(markup), document, /\shidden[\s>]/.test(markup)));
  }
  const posted: Posted[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = new Function("document", "window", "acquireVsCodeApi", "Element", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLInputElement", "setTimeout", "clearTimeout", script);
  const result: ScriptRun = {
    document,
    posted,
    state,
    scroll: async (to: number) => {
      window.scrollY = to;
      for (const listener of window.listeners.get("scroll") ?? []) {
        listener();
      }
      // The listener throttles; let its timer fire.
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };
  const window = {
    scrollY: 0,
    listeners: new Map<string, (() => void)[]>(),
    addEventListener(type: string, listener: () => void) {
      window.listeners.set(type, [...(window.listeners.get(type) ?? []), listener]);
    },
    scrollTo(_x: number, y: number) {
      result.scrolledTo = y;
    },
  };
  run(
    document,
    window,
    () => ({
      postMessage: (message: Posted) => posted.push(message),
      // The real webview API: a store of the page's own, kept across a
      // document replacement and never visible to the host.
      getState: () => state.value,
      setState: (next: unknown) => {
        state.value = next;
      },
    }),
    FakeElement,
    FakeTextArea,
    FakeSelect,
    FakeInput,
    (fn: () => void, ms = 0) => {
      const timer = setTimeout(fn, ms === 0 ? 0 : ms);
      timers.push(timer);
      return timer;
    },
    (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  );
  return result;
}

/**
 * An element built from the markup the renderer emitted for it, so a click
 * carries the attributes the shipped page really has — not attributes a test
 * chose. `pattern` must match the element's opening tag.
 */
function attributesOf(markup: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of markup.matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attributes[name] = value;
  }
  return attributes;
}

export function elementFrom(html: string, tag: string, pattern: RegExp, what: string): FakeElement {
  const markup = pattern.exec(html)?.[0];
  assert.ok(markup, `the document has ${what}`);
  const attributes: Record<string, string> = {};
  for (const [, name, value] of markup.matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attributes[name] = value;
  }
  if (tag === "textarea") {
    return new FakeTextArea(tag, attributes);
  }
  if (tag === "select") {
    return new FakeSelect(tag, attributes);
  }
  if (tag === "input") {
    const input = new FakeInput(tag, attributes);
    input.type = attributes["type"] ?? "text";
    input.value = attributes["value"] ?? "";
    return input;
  }
  return new FakeElement(tag, attributes);
}
