/**
 * A confirmation dialog must stay answerable.
 *
 * A VS Code modal has no scroll of its own: it grows to fit its detail, and
 * its buttons sit underneath that detail. So a long enough detail pushes the
 * button that accepts the dialog below the bottom of the screen, where it
 * cannot be clicked and cannot be scrolled to — the dialog becomes an
 * unanswerable question about work that is therefore unsubmittable.
 *
 * Every confirmation that quotes a person's own text back to them can reach
 * that state in ordinary use, because a person answering a manual
 * verification check pastes what they saw, and what they saw is a sync log
 * or a stack trace. The quotation is bounded; the text is not. What goes to
 * the engine, to the ledger and to notes.md is always the whole thing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIALOG_QUOTE_MAX_CHARS, DIALOG_QUOTE_MAX_LINES, dialogQuote } from "../core/presentation";

describe("dialogQuote", () => {
  it("leaves an ordinary answer exactly as it is", () => {
    const short = "Fail — mosaic-live-sync-917-604: still no mosaic images on sporely.no";
    assert.equal(dialogQuote(short), short);
  });

  it("leaves a multi-line answer alone while it fits", () => {
    const entry = ["Pass — resize-readability: legible at 700px", "Fail — android-smoke: crashed on launch"].join("\n");
    assert.equal(dialogQuote(entry), entry);
  });

  it("bounds a pasted log by characters and says what it left out", () => {
    const log = `Sync failed: ${"image 3258 ImageIdentityConflictError; ".repeat(200)}`;
    const quoted = dialogQuote(log);
    assert.ok(quoted.length < log.length / 4, `quoted ${quoted.length} of ${log.length}`);
    assert.match(quoted, /^Sync failed: image 3258/, "the beginning is what a reader needs");
    assert.match(quoted, /… \d+ more characters, submitted in full but not shown here\.$/);
  });

  it("bounds a tall answer by lines even when every line is short", () => {
    // The failure mode is dialog *height*, so a thousand one-word lines is
    // as bad as one very long line and a character budget alone misses it.
    const tall = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const quoted = dialogQuote(tall);
    const lines = quoted.split("\n");
    assert.equal(lines.length, DIALOG_QUOTE_MAX_LINES + 1, "the kept lines plus the note");
    assert.equal(lines[0], "line 0");
    assert.match(lines[lines.length - 1], /more characters, submitted in full/);
  });

  it("counts the characters it did not show, not the characters it did", () => {
    const body = "x".repeat(DIALOG_QUOTE_MAX_CHARS + 50);
    const quoted = dialogQuote(body);
    const hidden = Number(/… (\d+) more/.exec(quoted)![1]);
    assert.equal(hidden, 50);
  });

  it("does not claim an elision it did not make", () => {
    // Exactly at the budget is not over it, and a note saying "0 more
    // characters" would be a false statement about a complete quotation.
    const exact = "y".repeat(DIALOG_QUOTE_MAX_CHARS);
    assert.equal(dialogQuote(exact), exact);
  });
});
