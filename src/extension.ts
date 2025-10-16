import * as vscode from 'vscode';
import { JsonlViewerProvider } from './jsonlViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    // Register the custom editor provider
    const provider = new JsonlViewerProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider('jsonl-gazelle.jsonlViewer', provider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
    });

    // Register commands
    const openSettingsCommand = vscode.commands.registerCommand('jsonl-gazelle.openSettings', () => {
        provider.openSettings();
    });

    const exportCSVCommand = vscode.commands.registerCommand('jsonl-gazelle.exportCSV', () => {
        // This will be handled by the webview message
    });

    context.subscriptions.push(providerRegistration, openSettingsCommand, exportCSVCommand);
}

export function deactivate() {}
