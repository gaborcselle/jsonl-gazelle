import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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

    context.subscriptions.push(providerRegistration);

    // Initialize rating prompt manager
    const ratingManager = new RatingPromptManager(context);
    provider.setRatingPromptCallback(() => ratingManager.checkAndShowRatingPrompt());

    // Register command for opening large files (>100MB)
    const openLargeFileCommand = vscode.commands.registerCommand('jsonl-gazelle.openLargeFile', async (uri?: vscode.Uri) => {
        // If uri is not provided, try to get it from active editor
        if (!uri && vscode.window.activeTextEditor) {
            uri = vscode.window.activeTextEditor.document.uri;
        }
        
        if (!uri) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        
        // Check file size - only allow files >100MB
        try {
            const stats = await fs.promises.stat(uri.fsPath);
            const sizeMB = stats.size / (1024 * 1024);
            
            if (sizeMB < 100) {
                vscode.window.showInformationMessage(
                    `File splitting is only available for files larger than 100 MB`
                );
                return;
            }
        } catch (error) {
            vscode.window.showErrorMessage('Could not check file size');
            return;
        }
        
        await splitLargeFileDirectly(uri);
    });

    context.subscriptions.push(openLargeFileCommand);

    // Register file decoration provider for large files
    const fileDecorationProvider = new LargeFileDecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));
}

// File decoration provider to show icons for large JSONL files
class LargeFileDecorationProvider implements vscode.FileDecorationProvider {
    private shownNotifications = new Set<string>();

    async provideFileDecoration(
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<vscode.FileDecoration | undefined> {
        try {
            // Only process JSONL files
            if (uri.scheme !== 'file' || !uri.fsPath || path.extname(uri.fsPath) !== '.jsonl') {
                return undefined;
            }

            const stats = await fs.promises.stat(uri.fsPath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB > 100) {
                // Show notification only once per file
                if (!this.shownNotifications.has(uri.fsPath)) {
                    this.shownNotifications.add(uri.fsPath);
                    
                    vscode.window.showInformationMessage(
                        `Large file detected (${sizeMB.toFixed(2)} MB): ${path.basename(uri.fsPath)}. Split it into smaller parts?`,
                        'Split into Parts'
                    ).then(selection => {
                        if (selection === 'Split into Parts') {
                            vscode.commands.executeCommand('jsonl-gazelle.openLargeFile', uri);
                        }
                    });
                }
                
                return {
                    badge: '⚠️',
                    tooltip: 'File too large. Right-click and select "Split into Parts (100MB+)" to split the file'
                };
            }
        } catch (error) {
            // Ignore errors
        }
        return undefined;
    }
}

async function splitLargeFileDirectly(uri: vscode.Uri) {
    try {
        // Check file size first
        const stats = await fs.promises.stat(uri.fsPath);
        const sizeMB = stats.size / (1024 * 1024);
        
        // Show progress notification
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Splitting file: ${path.basename(uri.fsPath)}`,
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: 'Starting file split...' });
            
            // Split file immediately
            const parts = await splitLargeFile(uri.fsPath);
            
            if (parts.length > 0) {
                const fileNames = parts.map(p => path.basename(p));
                
                // Show completion message
                progress.report({ increment: 100, message: `Split into ${parts.length} parts` });
                
                const result = await vscode.window.showInformationMessage(
                    `File split into ${parts.length} part${parts.length > 1 ? 's' : ''}: ${fileNames.join(', ')}`,
                    'Open All'
                );
                
                if (result === 'Open All') {
                    // Open the split files in JSONL Gazelle
                    for (const partPath of parts) {
                        try {
                            const splitUri = vscode.Uri.file(partPath);
                            await vscode.commands.executeCommand(
                                'vscode.openWith',
                                splitUri,
                                'jsonl-gazelle.jsonlViewer',
                                vscode.ViewColumn.One
                            );
                        } catch (err) {
                            console.error(`Error opening ${partPath}:`, err);
                        }
                    }
                }
            }
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error splitting file: ${error.message}`);
    }
}

async function splitLargeFile(inputPath: string, maxSizeMB: number = 50): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        const maxSize = maxSizeMB * 1024 * 1024;
        const parts: string[] = [];
        
        const dir = path.dirname(inputPath);
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        
        let currentWriteStream: fs.WriteStream | null = null;
        let currentSize = 0;
        let partNumber = 1;
        let isClosing = false;
        let bufferedLines: string[] = [];
        
        // Helper to write a line (handles buffering during stream transitions)
        const writeLine = (line: string) => {
            if (isClosing) {
                bufferedLines.push(line);
                return;
            }
            
            if (!currentWriteStream) {
                bufferedLines.push(line);
                return;
            }
            
            try {
                const lineSize = Buffer.byteLength(line, 'utf8');
                
                // Check if we need a new part
                if (currentSize + lineSize > maxSize && currentSize > 0) {
                    // Start new part
                    const oldStream = currentWriteStream;
                    isClosing = true;
                    bufferedLines.push(line);
                    
                    oldStream.end(() => {
                        // Create new part
                        const newPartPath = path.join(dir, `${base}_part${partNumber}${ext}`);
                        parts.push(newPartPath);
                        partNumber++;
                        
                        currentWriteStream = fs.createWriteStream(newPartPath);
                        currentSize = 0;
                        isClosing = false;
                        
                        // Write buffered lines
                        const linesToProcess = [...bufferedLines];
                        bufferedLines = [];
                        linesToProcess.forEach(l => writeLine(l));
                    });
                } else {
                    // Write to current stream
                    currentWriteStream.write(line);
                    currentSize += lineSize;
                }
            } catch (err) {
                // If write fails, buffer and continue
                bufferedLines.push(line);
            }
        };
        
        // Create first part
        const firstPartPath = path.join(dir, `${base}_part${partNumber}${ext}`);
        parts.push(firstPartPath);
        currentWriteStream = fs.createWriteStream(firstPartPath);
        currentSize = 0;
        partNumber++;
        
        let partialLine = '';
        
        const stream = fs.createReadStream(inputPath, {
            encoding: 'utf8',
            highWaterMark: 64 * 1024,
            autoClose: true
        });
        
        stream.on('data', (chunk: string) => {
            const data = partialLine + chunk;
            const lines = data.split('\n');
            partialLine = lines.pop() || '';
            
            lines.forEach(line => {
                writeLine(line + '\n');
            });
        });
        
        stream.on('end', () => {
            // Write final partial line
            if (partialLine) {
                writeLine(partialLine + '\n');
            }
            
            // Wait for any pending writes and close the last stream
            const closeLastStream = () => {
                if (currentWriteStream && !currentWriteStream.destroyed) {
                    const streamToClose = currentWriteStream;
                    currentWriteStream = null;
                    
                    streamToClose.end(() => {
                        // Ensure all buffered lines are processed
                        if (bufferedLines.length > 0) {
                            const newPartPath = path.join(dir, `${base}_part${partNumber}${ext}`);
                            parts.push(newPartPath);
                            
                            const finalStream = fs.createWriteStream(newPartPath);
                            bufferedLines.forEach(line => {
                                finalStream.write(line);
                            });
                            finalStream.end(() => {
                                resolve(parts);
                            });
                        } else {
                            resolve(parts);
                        }
                    });
                } else if (bufferedLines.length > 0) {
                    const newPartPath = path.join(dir, `${base}_part${partNumber}${ext}`);
                    parts.push(newPartPath);
                    
                    const finalStream = fs.createWriteStream(newPartPath);
                    bufferedLines.forEach(line => {
                        finalStream.write(line);
                    });
                    finalStream.end(() => {
                        resolve(parts);
                    });
                } else {
                    resolve(parts);
                }
            };
            
            // Give some time for any pending async operations
            setTimeout(closeLastStream, 100);
        });
        
        stream.on('error', (err) => reject(err));
    }).catch((error: any) => {
        vscode.window.showErrorMessage(`Error splitting file: ${error.message}`);
        return [];
    });
}

// Rating prompt manager
class RatingPromptManager {
    private readonly OPEN_COUNT_KEY = 'jsonl-gazelle.openCount';
    private readonly HAS_RATED_KEY = 'jsonl-gazelle.hasRated';
    private readonly LAST_PROMPTED_COUNT_KEY = 'jsonl-gazelle.lastPromptedCount';
    private isShowingPrompt: boolean = false; // Prevent multiple prompts at once

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Check if we should show rating prompt and show it if needed
     */
    async checkAndShowRatingPrompt(): Promise<void> {
        // Don't show if user already rated or if prompt is already showing
        const hasRated = this.context.globalState.get<boolean>(this.HAS_RATED_KEY, false);
        if (hasRated || this.isShowingPrompt) {
            return;
        }

        // Get current open count
        const openCount = this.context.globalState.get<number>(this.OPEN_COUNT_KEY, 0) + 1;
        await this.context.globalState.update(this.OPEN_COUNT_KEY, openCount);

        // Get last prompted count
        const lastPromptedCount = this.context.globalState.get<number>(this.LAST_PROMPTED_COUNT_KEY, 0);

        // Determine if we should prompt
        let shouldPrompt = false;
        
        if (openCount === 3) {
            // First prompt after 3 opens
            shouldPrompt = true;
        } else if (openCount > lastPromptedCount && (openCount - lastPromptedCount) >= 10) {
            // Subsequent prompts every 10 opens
            shouldPrompt = true;
        }

        if (!shouldPrompt) {
            return;
        }

        // Show rating prompt
        this.isShowingPrompt = true;
        try {
            await this.showRatingPrompt(openCount);
        } finally {
            this.isShowingPrompt = false;
        }
    }

        private async showRatingPrompt(openCount: number): Promise<void> {
        // Determine if we're in Cursor or VS Code
        const isCursor = vscode.env.appName.toLowerCase().includes('cursor');   

        // Determine marketplace URL
        const marketplaceUrl = isCursor
            ? 'https://open-vsx.org/extension/gabor/jsonl-gazelle'
            : `https://marketplace.visualstudio.com/items?itemName=gabor.jsonl-gazelle`;                                                                        

        const marketplaceName = isCursor ? 'OpenVSX' : 'Visual Studio Code Marketplace';
        const message = `Please rate us and write a review on ${marketplaceName} to help others find our way of working on JSONL data files.`;

        // Show modal dialog via webview
        const result = await this.showRatingModal(message, marketplaceUrl);

        if (result === 'rate') {
            // User clicked "OK" - open marketplace and remember      
            await vscode.env.openExternal(vscode.Uri.parse(marketplaceUrl));
            await this.context.globalState.update(this.HAS_RATED_KEY, true);
        } else {
            // User clicked "Maybe Later" or dismissed - remember this prompt count
            await this.context.globalState.update(this.LAST_PROMPTED_COUNT_KEY, openCount);
        }
    }

    private async showRatingModal(message: string, marketplaceUrl: string): Promise<'rate' | 'later' | 'dismissed'> {
        return new Promise((resolve) => {
            // Create webview panel for modal (fullscreen overlay style)
            const panel = vscode.window.createWebviewPanel(
                'ratingPrompt',
                'Please rate and review JSONL Gazelle',
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: false,
                    localResourceRoots: []
                }
            );

            // Set HTML content
            panel.webview.html = this.getRatingModalHtml(message);

            let resolved = false;
            let modalReady = false;
            let timeouts: NodeJS.Timeout[] = [];

            // Helper to safely post message (check if panel still exists)
            const safePostMessage = (message: any) => {
                try {
                    if (panel && !resolved) {
                        panel.webview.postMessage(message);
                    }
                } catch (error) {
                    // Panel might be disposed, ignore
                }
            };

            // Helper to clear all timeouts
            const clearAllTimeouts = () => {
                timeouts.forEach(timeout => clearTimeout(timeout));
                timeouts = [];
            };

            // Wait for panel to become visible, then tell webview to attach handlers
            const viewStateDisposable = panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.visible && !modalReady && !resolved) {
                    // Panel is now visible, send message to webview to attach handlers
                    const timeout = setTimeout(() => {
                        safePostMessage({ type: 'attach-handlers' });
                    }, 100);
                    timeouts.push(timeout);
                }
            });

            // Handle messages from webview (handlers are attached in the HTML/JS after modal is visible)
            const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
                // Handle ready signal from webview
                if (message.type === 'modal-ready') {
                    modalReady = true;
                    return;
                }
                if (resolved) return;

                if (message.type === 'rate') {
                    resolved = true;
                    disposeAll();
                    resolve('rate');
                    panel.dispose();
                } else if (message.type === 'later') {
                    resolved = true;
                    disposeAll();
                    resolve('later');
                    panel.dispose();
                } else if (message.type === 'dismiss') {
                    resolved = true;
                    disposeAll();
                    resolve('dismissed');
                    panel.dispose();
                }
            });

            // Helper to dispose all resources
            const disposeAll = () => {
                clearAllTimeouts();
                messageDisposable.dispose();
                viewStateDisposable.dispose();
            };

            // Handle panel disposal (clean up handlers)
            const disposeHandler = () => {
                if (!resolved) {
                    resolved = true;
                    resolve('dismissed');
                }
                disposeAll();
            };

            panel.onDidDispose(disposeHandler);

            // Also trigger if panel is already visible
            if (panel.visible && !resolved) {
                const timeout = setTimeout(() => {
                    safePostMessage({ type: 'attach-handlers' });
                }, 100);
                timeouts.push(timeout);
            }
        });
    }

    private getRatingModalHtml(message: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Please rate and review JSONL Gazelle</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: transparent;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            animation: fadeIn 0.2s ease-out;
            cursor: pointer;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
            }
            to {
                opacity: 1;
            }
        }

        .modal-container {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 24px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
            z-index: 1001;
            animation: slideIn 0.2s ease-out;
            position: relative;
            cursor: default;
        }

        @keyframes slideIn {
            from {
                transform: translateY(-20px);
                opacity: 0;
            }
            to {
                transform: translateY(0);
                opacity: 1;
            }
        }

        .modal-message {
            margin-bottom: 24px;
            line-height: 1.5;
            color: var(--vscode-foreground);
        }

        .modal-buttons {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .modal-button {
            padding: 6px 16px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            transition: background-color 0.2s;
        }

        .modal-button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .modal-button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .modal-button.secondary {
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-button-border);
        }

        .modal-button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .modal-button:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
    </style>
</head>
<body>
    <div class="modal-overlay" id="overlay">
        <div class="modal-container" id="modal">
            <div class="modal-message">${this.escapeHtml(message)}</div>
            <div class="modal-buttons">
                <button class="modal-button secondary" id="laterBtn">Maybe later</button>                                                                       
                <button class="modal-button primary" id="rateBtn">OK</button>                                                                         
            </div>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let handlersAttached = false;
            let cleanupFunctions = [];
            let attachMessageHandler = null;

            function attachHandlers() {
                if (handlersAttached) return;
                handlersAttached = true;

                const rateBtn = document.getElementById('rateBtn');
                const laterBtn = document.getElementById('laterBtn');
                const overlay = document.getElementById('overlay');
                const modal = document.getElementById('modal');

                // Rate button handler
                const rateHandler = () => {
                    vscode.postMessage({ type: 'rate' });
                    cleanup();
                };
                rateBtn.addEventListener('click', rateHandler);
                cleanupFunctions.push(() => rateBtn.removeEventListener('click', rateHandler));

                // Later button handler
                const laterHandler = () => {
                    vscode.postMessage({ type: 'later' });
                    cleanup();
                };
                laterBtn.addEventListener('click', laterHandler);
                cleanupFunctions.push(() => laterBtn.removeEventListener('click', laterHandler));

                // Click outside modal handler
                const overlayClickHandler = (e) => {
                    if (e.target === overlay) {
                        vscode.postMessage({ type: 'dismiss' });
                        cleanup();
                    }
                };
                overlay.addEventListener('click', overlayClickHandler);
                cleanupFunctions.push(() => overlay.removeEventListener('click', overlayClickHandler));

                // Prevent modal clicks from closing
                const modalClickHandler = (e) => {
                    e.stopPropagation();
                };
                modal.addEventListener('click', modalClickHandler);
                cleanupFunctions.push(() => modal.removeEventListener('click', modalClickHandler));

                // Escape key handler
                const escapeHandler = (e) => {
                    if (e.key === 'Escape') {
                        vscode.postMessage({ type: 'dismiss' });
                        cleanup();
                    }
                };
                document.addEventListener('keydown', escapeHandler);
                cleanupFunctions.push(() => document.removeEventListener('keydown', escapeHandler));

                // Focus primary button
                rateBtn.focus();

                // Notify extension that handlers are attached
                vscode.postMessage({ type: 'modal-ready' });
            }

            function cleanup() {
                cleanupFunctions.forEach(fn => fn());
                cleanupFunctions = [];
                
                // Remove attach-handlers listener
                if (attachMessageHandler) {
                    window.removeEventListener('message', attachMessageHandler);
                    attachMessageHandler = null;
                }
            }

            // Wait for message from extension to attach handlers (after modal is visible)
            attachMessageHandler = (event) => {
                const message = event.data;
                if (message.type === 'attach-handlers') {
                    attachHandlers();
                }
            };
            window.addEventListener('message', attachMessageHandler);

            // Fallback: if DOM is ready but we haven't received attach message yet,
            // wait for it. But don't attach automatically.
        })();
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}

export function deactivate() {}
