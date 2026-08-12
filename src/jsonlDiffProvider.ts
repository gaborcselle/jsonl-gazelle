/**
 * JSONL-aware diff view.
 *
 * Provides the "Diff with Git HEAD" and "Compare with JSONL File..." commands
 * and renders the result in a webview panel that understands JSONL structure:
 * rows are aligned, edits of the same record are shown as field-level changes
 * instead of a wall of raw JSON text.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { computeJsonlDiff } from './jsonl/diff';
import { getDiffViewHtml } from './webview/diffView';

const GIT_MAX_BUFFER = 100 * 1024 * 1024; // 100 MB

function isSupportedFile(fsPath: string): boolean {
    return vscode.workspace.getConfiguration('jsonl-gazelle')
        .get<string[]>('files.extensions')
        ?.includes(path.extname(fsPath).toLowerCase()) ?? false;
}

interface DiffSource {
    label: string;
    content: string;
}

export function registerDiffCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('jsonl-gazelle.diffWithHead', async (arg?: unknown) => {
            const uri = resolveJsonlUri(arg);
            if (!uri) {
                vscode.window.showErrorMessage('Open or select a .jsonl file to diff against Git HEAD.');
                return;
            }
            await diffAgainstHead(uri);
        }),
        vscode.commands.registerCommand('jsonl-gazelle.compareFiles', async (arg?: unknown, multiSelection?: unknown) => {
            await compareFiles(arg, multiSelection);
        })
    );
}

/**
 * Extract a .jsonl file URI from a command argument, which may be a Uri
 * (explorer/editor title menus), a SourceControlResourceState (SCM menu),
 * or undefined (command palette).
 */
function resolveJsonlUri(arg: unknown): vscode.Uri | undefined {
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) {
        uri = arg;
    } else if (arg && typeof arg === 'object' && 'resourceUri' in arg && (arg as any).resourceUri instanceof vscode.Uri) {
        uri = (arg as any).resourceUri;
    } else if (vscode.window.activeTextEditor) {
        uri = vscode.window.activeTextEditor.document.uri;
    } else {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input = activeTab?.input;
        if (input && typeof input === 'object' && 'uri' in input && (input as any).uri instanceof vscode.Uri) {
            uri = (input as any).uri;
        }
    }
    if (!uri || uri.scheme !== 'file' || !isSupportedFile(uri.fsPath)) {
        return undefined;
    }
    return uri;
}

async function diffAgainstHead(uri: vscode.Uri): Promise<void> {
    let head: { content: string; note?: string };
    try {
        head = await getGitHeadContent(uri.fsPath);
    } catch (error: any) {
        vscode.window.showErrorMessage(`JSONL Gazelle: ${error.message}`);
        return;
    }

    const current = await readCurrentContent(uri);
    const fileName = path.basename(uri.fsPath);
    showDiffPanel(
        `${fileName} (HEAD ↔ Working Tree)`,
        { label: `${fileName} @ HEAD`, content: head.content },
        { label: `${fileName} (working tree)`, content: current },
        head.note
    );
}

async function compareFiles(arg: unknown, multiSelection: unknown): Promise<void> {
    let left: vscode.Uri | undefined;
    let right: vscode.Uri | undefined;

    // Explorer multi-select passes (clickedUri, allSelectedUris)
    if (Array.isArray(multiSelection)) {
        const jsonlUris = multiSelection.filter(
            (u): u is vscode.Uri => u instanceof vscode.Uri && isSupportedFile(u.fsPath)
        );
        if (jsonlUris.length >= 2) {
            [left, right] = jsonlUris;
        }
    }

    if (!left || !right) {
        left = resolveJsonlUri(arg);
        if (!left) {
            vscode.window.showErrorMessage('Open or select a .jsonl file to compare.');
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Compare',
            filters: { 'JSONL / NDJSON files': ['jsonl', 'ndjson'] },
            title: `Compare ${path.basename(left.fsPath)} with...`
        });
        if (!picked || picked.length === 0) {
            return;
        }
        right = picked[0];
    }

    const leftContent = await readCurrentContent(left);
    const rightContent = await readCurrentContent(right);
    const leftName = path.basename(left.fsPath);
    const rightName = path.basename(right.fsPath);
    showDiffPanel(
        `${leftName} ↔ ${rightName}`,
        { label: leftName, content: leftContent },
        { label: rightName, content: rightContent }
    );
}

/**
 * Prefer the (possibly dirty) open document over the file on disk.
 */
async function readCurrentContent(uri: vscode.Uri): Promise<string> {
    const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (openDoc) {
        return openDoc.getText();
    }
    const document = await vscode.workspace.openTextDocument(uri);
    return document.getText();
}

function showDiffPanel(title: string, left: DiffSource, right: DiffSource, note?: string): void {
    const panel = vscode.window.createWebviewPanel(
        'jsonl-gazelle.diffView',
        title,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        }
    );

    const diff = computeJsonlDiff(left.content, right.content);
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = getDiffViewHtml(nonce);

    const payload = {
        leftLabel: left.label,
        rightLabel: right.label,
        note: note || '',
        summary: diff.summary,
        rows: diff.rows
    };

    const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
        if (message && message.type === 'ready') {
            panel.webview.postMessage({ type: 'diffData', payload });
        }
    });
    panel.onDidDispose(() => messageDisposable.dispose());
}

/**
 * Read the committed (HEAD) version of a file via the git CLI.
 * Returns empty content with a note when the file is not tracked in HEAD.
 */
async function getGitHeadContent(filePath: string): Promise<{ content: string; note?: string }> {
    const fileDir = path.dirname(filePath);

    let repoRoot: string;
    try {
        repoRoot = (await execGit(['rev-parse', '--show-toplevel'], fileDir)).trim();
    } catch {
        throw new Error(`'${path.basename(filePath)}' is not inside a Git repository.`);
    }

    const relPath = path.relative(repoRoot, filePath).split(path.sep).join('/');
    try {
        const content = await execGit(['show', `HEAD:${relPath}`], repoRoot);
        return { content };
    } catch (error: any) {
        const message = String(error?.message || '');
        if (message.includes('does not exist') || message.includes('exists on disk, but not in') ||
            message.includes('unknown revision') || message.includes('invalid object name')) {
            return { content: '', note: 'File is not in HEAD yet — showing all lines as added.' };
        }
        throw new Error(`Could not read HEAD version: ${message.split('\n')[0]}`);
    }
}

function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr ? stderr.toString() : error.message));
            } else {
                resolve(stdout.toString());
            }
        });
    });
}
