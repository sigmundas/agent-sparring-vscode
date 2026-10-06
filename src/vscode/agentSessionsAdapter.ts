/**
 * EXPERIMENTAL: list Agent Sparring runs as agent sessions through VS Code's
 * proposed `chatSessionsProvider` API.
 *
 * Off unless `agentSparring.experimental.agentSessions` is true, and inert
 * unless VS Code exposes the API, which a stable build does only for an
 * extension it was started with `--enable-proposed-api` for (or that
 * `~/.vscode/argv.json` names in `enable-proposed-api`). In VS Code 1.140
 * these sessions appear in the main window's Chat sessions list; the
 * dedicated Agents window lists only Copilot Cloud and Microsoft's own agent
 * hosts, so they do not appear there.
 *
 * Read-only and listing only: items come from the shared run index
 * (core/agentSessionItem.ts). Nothing here starts, resumes or changes a run;
 * the Runs view and the Overview remain where a run is followed.
 *
 * The proposed types are declared locally, for the few members used, so the
 * rest of the extension compiles against the stable API alone and this file
 * is the only place that changes when the proposal does.
 */

import * as vscode from "vscode";
import { agentSessionItem, type AgentSessionState } from "../core/agentSessionItem";
import { buildRunIndex } from "../core/runIndex";
import type { SparringController } from "./controller";

export const AGENT_SESSION_TYPE = "agent-sparring";
const SETTING = "experimental.agentSessions";

/** The subset of the proposed API this adapter uses (vscode.proposed.chatSessionsProvider.d.ts at 1.140). */
interface ProposedSessionItem {
  readonly resource: vscode.Uri;
  label: string;
  description?: string | vscode.MarkdownString;
  badge?: string | vscode.MarkdownString;
  status?: number;
  tooltip?: string | vscode.MarkdownString;
  timing?: { readonly created: number; readonly lastRequestEnded?: number };
}
interface ProposedSessionController extends vscode.Disposable {
  readonly items: { replace(items: readonly ProposedSessionItem[]): void };
  createChatSessionItem(resource: vscode.Uri, label: string): ProposedSessionItem;
}
type ProposedChat = {
  createChatSessionItemController?: (type: string, refresh: (token: vscode.CancellationToken) => Thenable<void>) => ProposedSessionController;
};

/** `ChatSessionStatus` values (Failed=0, Completed=1, InProgress=2, NeedsInput=3). */
const STATUS: Record<AgentSessionState, number> = { failed: 0, completed: 1, inProgress: 2, needsInput: 3 };

/** What the adapter last handed to VS Code; read by the integration test hook only. */
let published: { label: string; description: string; status: number; badge?: string }[] | undefined;

export function registerAgentSessionsAdapter(context: vscode.ExtensionContext, controller: SparringController): void {
  let adapter: vscode.Disposable | undefined;
  const apply = () => {
    const wanted = vscode.workspace.getConfiguration("agentSparring").get<boolean>(SETTING, false);
    if (!wanted) {
      adapter?.dispose();
      adapter = undefined;
      return;
    }
    if (adapter) {
      return;
    }
    const chat = (vscode as unknown as { chat?: ProposedChat }).chat;
    if (typeof chat?.createChatSessionItemController !== "function") {
      controller.log(
        "agent sessions (experimental) are enabled in settings, but this VS Code does not expose the proposed chatSessionsProvider API to Agent Sparring; start VS Code with --enable-proposed-api for this extension to try it. The Runs view is unaffected.",
      );
      return;
    }
    adapter = startAdapter(chat.createChatSessionItemController.bind(chat), controller);
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`agentSparring.${SETTING}`)) {
        apply();
      }
    }),
    { dispose: () => adapter?.dispose() },
    vscode.commands.registerCommand("agentSparring._test.agentSessions", () => ({ active: adapter !== undefined, items: published })),
  );
  apply();
}

function startAdapter(create: NonNullable<ProposedChat["createChatSessionItemController"]>, controller: SparringController): vscode.Disposable {
  // Assigned once the host has created the controller; a refresh it asks
  // for while still creating it finds nothing to fill yet.
  // `let`, not `const`: a synchronous refresh during `create` must read undefined, not throw.
  // eslint-disable-next-line prefer-const
  let sessions: ProposedSessionController | undefined;
  const publish = async (): Promise<void> => {
    const target = sessions;
    if (!target) {
      return;
    }
    const scope = controller.currentSelection.scope;
    const index = buildRunIndex(controller.currentDiscovery.runs, {
      followedRoot: scope?.repoRoot,
      familyOf: (root) => controller.familyOf(root),
      memberships: await controller.planMemberships(),
    });
    const now = Date.now();
    const entries = [...index.open, ...index.recent, ...index.other.flatMap((repository) => repository.entries)];
    target.items.replace(
      entries.map(({ summary }) => {
        const data = agentSessionItem(summary, now);
        const item = target.createChatSessionItem(vscode.Uri.from({ scheme: AGENT_SESSION_TYPE, path: `/${encodeURIComponent(data.id)}` }), data.label);
        item.description = data.description;
        item.badge = data.badge;
        item.status = STATUS[data.state];
        item.tooltip = new vscode.MarkdownString(data.tooltip);
        item.timing = data.timing;
        return item;
      }),
    );
    published = entries.map(({ summary }) => {
      const data = agentSessionItem(summary, now);
      return { label: data.label, description: data.description, status: STATUS[data.state], ...(data.badge ? { badge: data.badge } : {}) };
    });
  };
  sessions = create(AGENT_SESSION_TYPE, () => publish());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subscription = controller.onDidChange(() => {
    // The controller fires on every render; a session list needs at most a
    // refresh a second.
    timer ??= setTimeout(() => {
      timer = undefined;
      void publish();
    }, 1000);
  });
  void publish();
  controller.log("agent sessions (experimental): listing Agent Sparring runs through the proposed chat sessions API.");
  return {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      subscription.dispose();
      sessions?.dispose();
    },
  };
}
