/**
 * Which editor group the Overview's document actions (Brief, Handoff,
 * Sparring report, Plan) open into: the group the Overview panel lives in,
 * so the documents appear beside the panel's tab and follow it when the
 * panel is moved. Plain numbers, mirroring vscode.ViewColumn (1-based
 * groups; the negative sentinels Active/Beside are never returned).
 *
 * No dependency on the vscode API.
 */

export const FIRST_COLUMN = 1;

/**
 * `panelColumn` is the panel's current group when it is visible, else the
 * group it was last seen in (tracked by the caller); `activeColumn` is the
 * active editor's group. Falls back to the first group.
 */
export function documentViewColumn(panelColumn: number | undefined, lastKnownPanelColumn: number | undefined, activeColumn: number | undefined): number {
  for (const candidate of [panelColumn, lastKnownPanelColumn, activeColumn]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= FIRST_COLUMN) {
      return candidate;
    }
  }
  return FIRST_COLUMN;
}
