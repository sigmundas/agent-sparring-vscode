/**
 * One `--evidence` payload containing everything a person or a model can put
 * in an answer, deliberately larger than the submission that failed in the
 * field.
 *
 * It is not a tidy sample. Each element is here because a shell, a terminal
 * line editor or a quoting encoder treats it as something other than text:
 *
 *  - literal newlines            — a second command, or zsh's `quote>` reader
 *  - an apostrophe               — opens a quote VS Code never closes
 *  - "double quotes"             — stop VS Code quoting the argument at all
 *  - backticks                   — command substitution
 *  - `$HOME`, `${x}`, `$(cmd)`   — expansion
 *  - a backslash                 — an escape, or a line continuation
 *  - `øæå`, en dash, em dash     — multi-byte UTF-8 the encoder must not split
 *  - real gate and check ids     — the shape the engine actually receives
 *  - a very long single line     — past any input buffer a terminal may have
 *
 * The transport is only allowed one answer to all of it: the engine's argv
 * holds this string, byte for byte, as one argument.
 */

const GATE_INSTANCE = "human-gate-2026-09-20T09-31-44-a41f9c";

const CHECKS = [
  { id: "pre-activation-desktop-v2-feed", what: "the pre-activation placeholder is shown, and doesn't flash" },
  { id: "reference-dialog-redesign--empty-state", what: "the empty state reads `no references yet` and isn't clipped at 5–95 % zoom" },
  { id: "snapshot-version-2-row-details", what: 'a snapshot_version 2 row keeps its details under "Reported statistics"' },
  { id: "norwegian-locale-sort-order", what: "sorting in nb-NO puts æ, ø and å after z" },
];

/** One long line, so the payload is past any terminal input buffer on its own. */
function longLine(): string {
  return (
    "Repeatedly opened and closed the dialog while the feed refreshed in the background, " +
    "watching for the placeholder to flash — it never did, on any of the runs. " +
    "Notes from the run: the `--expected-branch` guard fired once when I was on the wrong branch, which is correct; " +
    "`$HOME/Library/Application Support/Code` was untouched; the backslash in C:\\Users\\x was shown verbatim; " +
    "nothing was expanded, substituted or split. "
  ).repeat(6);
}

/** The full payload: well over 4 kB, in the shape `renderHumanEvidence` produces. */
export function hostileEvidence(): string {
  const lines = [
    "## Human evidence",
    "",
    "_Recorded 2026-09-20 09:49 — Reported statistics_",
    "",
  ];
  for (const check of CHECKS) {
    lines.push(
      `- Pass — \`${check.id}\` · gate \`${GATE_INSTANCE}\``,
      `  - Checked that ${check.what}.`,
      `  - It's done: I ran it as \`$(which sparring) resume-plan\` would, with $HOME and \${PATH} unset,`,
      "    and the output was \"exactly what was expected\" — no more, no less.",
      `  - ${longLine()}`,
      "",
    );
  }
  lines.push(
    "Til slutt: på norsk — «ø, æ og å» sorteres sist, og en–dash og em—dash beholdes.",
    "",
    "    indented\tand\ttabbed",
  );
  // `buildResumePlanArgs` trims the entry, so the fixture is already trimmed:
  // what it returns is exactly what the engine must receive.
  return lines.join("\n").trim();
}
