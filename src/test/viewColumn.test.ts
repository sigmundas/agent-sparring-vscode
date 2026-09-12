import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIRST_COLUMN, documentViewColumn } from "../core/viewColumn";

describe("document actions open in the Overview's editor group", () => {
  it("uses the panel's current group when it is visible", () => {
    assert.equal(documentViewColumn(2, 1, 3), 2);
  });

  it("follows the panel after it moved: the last known group wins when the panel is hidden", () => {
    assert.equal(documentViewColumn(undefined, 3, 1), 3);
  });

  it("falls back to the active editor's group, then the first group; never Beside (-2) or Active (-1)", () => {
    assert.equal(documentViewColumn(undefined, undefined, 2), 2);
    assert.equal(documentViewColumn(undefined, undefined, undefined), FIRST_COLUMN);
    assert.equal(documentViewColumn(-2, -1, undefined), FIRST_COLUMN);
    assert.equal(documentViewColumn(0, undefined, undefined), FIRST_COLUMN);
  });
});
