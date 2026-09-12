import * as vscode from "vscode";
import { registerCommands } from "./vscode/commands";
import { SparringController } from "./vscode/controller";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new SparringController(context);
  context.subscriptions.push(controller);
  registerCommands(context, controller);
  await controller.start();
}

export function deactivate(): void {
  // Nothing to stop: engine processes live in terminals and are never owned here.
}
