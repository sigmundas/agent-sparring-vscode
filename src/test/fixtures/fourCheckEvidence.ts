import { renderHumanEvidence } from "../../core/humanChecks";

/** The four-check payload from the reported Add reference gate (no live files read by tests). */
export function fourCheckEvidence(): string {
  const checks = [
    ["baseline-no-selection", "Open Add reference for an observation with measured spores, with no source selected."],
    ["source-comparison-semantics", "Select a raw-data Library source, an ordinary published range, an explicit 5–95 source, and a source without mean/median. Inspect Summary and Raw spores for each."],
    ["fixed-axes-switching", "Repeatedly switch between those four source states and return to no selection within the same dialog session."],
    ["comparison-layout-readability", "Resize the dialog smaller and larger and scroll Summary. Check axis values and scientific captions in your usual theme."],
  ];
  return renderHumanEvidence(checks.map(([id, text]) => ({
    id, text, origin: "gate", gateInstanceId: "a7df224421b34e47bc77bfa2ca7ca294", record: { outcome: "pass" },
  })), new Date("2026-09-19"), "Add reference dialog redesign — continuation")!;
}
