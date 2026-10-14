/**
 * JSONL-aware diff view.
 *
 * Provides the "Diff with Git HEAD" and "Compare with JSONL File..." commands
 * and renders the result in a webview panel that understands JSONL structure:
 * rows are aligned, edits of the same record are shown as field-level changes
 * instead of a wall of raw JSON text.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { computeJsonlDiff } from './jsonl/diff';
import { getDiffViewHtml } from './webview/diffView';

const GIT_MAX_BUFFER = 100 * 1024 * 1024; // 100 MB

const SUPPORTED_EXTENSIONS = ['.jsonl', '.ndjson'];

function isSupportedFile(fsPath: string): boolean {
    return SUPPORTED_EXTENSIONS.includes(path.extname(fsPath).toLowerCase());
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

    let current: string | undefined;
    try {
        current = await readWorkingCopy(uri);
    } catch (error: any) {
        vscode.window.showErrorMessage(`JSONL Gazelle: ${error.message}`);
        return;
    }
    const fileName = path.basename(uri.fsPath);
    showDiffPanel(
        `${fileName} (HEAD ↔ Working Tree)`,
        { label: `${fileName} @ HEAD`, content: head.content },
        { label: `${fileName} (working tree)`, content: current ?? '' },
        current === undefined ? 'File is deleted in the working tree — showing all lines as removed.' : head.note
    );
}

/**
 * The working-tree side of "Diff with Git HEAD": the open document or the
 * file, or undefined when the file is gone. Source Control offers the
 * command on deleted files too, and VS Code cannot open those.
 */
async function readWorkingCopy(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return await readCurrentContent(uri);
    } catch (error) {
        if (!(await pathExists(uri.fsPath))) {
            return undefined;
        }
        throw error;
    }
}

async function pathExists(fsPath: string): Promise<boolean> {
    try {
        await fs.promises.stat(fsPath);
        return true;
    } catch {
        return false;
    }
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
        rows: diff.rows,
        lineEndingChanges: diff.lineEndingChanges || null
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
export async function getGitHeadContent(filePath: string): Promise<{ content: string; note?: string }> {
    const fileName = path.basename(filePath);
    const { cwd, relativePath, realPath } = await locateForGit(filePath);

    if ((await runGit(['rev-parse', '--show-toplevel'], cwd)).exitCode !== 0) {
        throw new Error(realPath === path.resolve(filePath)
            ? `'${fileName}' is not inside a Git repository.`
            : `'${fileName}' links to '${realPath}', which is not inside a Git repository.`);
    }

    // The path is given relative to the directory git runs in ("./name"):
    // working it out from the repository root broke for files reached
    // through a symlinked folder, where the two disagree.
    const spec = `HEAD:./${relativePath}`;

    // Whether the file is in HEAD at all is told by the exit status: with
    // --quiet, rev-parse exits 1 without a word for a path HEAD lacks and for
    // a repository with no commit yet. git's messages are translated, so no
    // decision may rest on their wording.
    const lookup = await runGit(['rev-parse', '--verify', '--quiet', spec], cwd);
    if (lookup.exitCode === 1) {
        return { content: '', note: 'File is not in HEAD yet — showing all lines as added.' };
    }
    if (lookup.exitCode !== 0) {
        throw new Error(`Could not read HEAD version: ${firstLine(lookup.stderr)}`);
    }

    // --filters runs the checkout filters, so a Git LFS file is compared by
    // its content, not by its pointer, and line endings match the working copy.
    const blob = await runGit(['cat-file', '--filters', spec], cwd);
    if (blob.exitCode !== 0) {
        throw new Error(`Could not read HEAD version: ${firstLine(blob.stderr)}`);
    }
    // VS Code drops a UTF-8 byte order mark from the editor's text; git
    // keeps it, which showed line 1 as changed
    const content = blob.stdout;
    return { content: content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content };
}

/**
 * Where to run git for a file, and the file's path from there. An existing
 * file is resolved through symlinks first: for a symlinked file git tracks
 * the link, whose blob is just the target's path, while the working copy
 * shows the target's content. A file deleted from the working tree (Source
 * Control offers the diff there too) is reached from its nearest folder that
 * still exists, as git cannot start in a missing one.
 */
async function locateForGit(filePath: string): Promise<{ cwd: string; relativePath: string; realPath: string }> {
    try {
        const realPath = await fs.promises.realpath(filePath);
        return { cwd: path.dirname(realPath), relativePath: path.basename(realPath), realPath };
    } catch {
        const resolved = path.resolve(filePath);
        let cwd = path.dirname(resolved);
        let relativePath = path.basename(resolved);
        while (!(await pathExists(cwd)) && path.dirname(cwd) !== cwd) {
            relativePath = `${path.basename(cwd)}/${relativePath}`;
            cwd = path.dirname(cwd);
        }
        return { cwd, relativePath, realPath: resolved };
    }
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0];
}

interface GitOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Run git and resolve with its output and exit status, whatever the status.
 * Rejects only when git produced no status: it could not be started at all,
 * or its output outgrew GIT_MAX_BUFFER.
 */
function runGit(args: string[], cwd: string): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (error: any, stdout, stderr) => {
            if (error && typeof error.code !== 'number') {
                // A failed start names the spawn call, unlike an overflow or a
                // kill. ENOENT there means no git on the PATH: cwd always
                // exists (see locateForGit).
                reject(new Error(String(error.syscall || '').startsWith('spawn')
                    ? `Could not run git (${error.message}). Make sure Git is installed and on the PATH.`
                    : `Could not read HEAD version: ${error.message}`));
                return;
            }
            resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: error ? error.code : 0 });
        });
    });
}
