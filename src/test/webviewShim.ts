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

/** The document as the shipped script uses it: delegated listeners on one root. */
export class FakeDocument {
  private readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
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
export function runWebviewScript(html: string, nonce = "n"): { document: FakeDocument; posted: Posted[] } {
  const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*?)</script>`).exec(html)?.[1];
  assert.ok(script, "the document ships a script");
  const document = new FakeDocument();
  const posted: Posted[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = new Function("document", "acquireVsCodeApi", "Element", "HTMLTextAreaElement", "setTimeout", "clearTimeout", script);
  run(
    document,
    () => ({ postMessage: (message: Posted) => posted.push(message) }),
    FakeElement,
    FakeTextArea,
    (fn: () => void) => {
      const timer = setTimeout(fn, 0);
      timers.push(timer);
      return timer;
    },
    (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  );
  return { document, posted };
}

/**
 * An element built from the markup the renderer emitted for it, so a click
 * carries the attributes the shipped page really has — not attributes a test
 * chose. `pattern` must match the element's opening tag.
 */
export function elementFrom(html: string, tag: string, pattern: RegExp, what: string): FakeElement {
  const markup = pattern.exec(html)?.[0];
  assert.ok(markup, `the document has ${what}`);
  const attributes: Record<string, string> = {};
  for (const [, name, value] of markup.matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attributes[name] = value;
  }
  return tag === "textarea" ? new FakeTextArea(tag, attributes) : new FakeElement(tag, attributes);
}
