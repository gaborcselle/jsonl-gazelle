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
        
        await openLargeFileInWebview(uri);
    });

    context.subscriptions.push(openLargeFileCommand);
}

async function openLargeFileInWebview(uri: vscode.Uri) {
    try {
        // Check file size first
        const stats = await fs.promises.stat(uri.fsPath);
        const sizeMB = stats.size / (1024 * 1024);
        
        const panel = vscode.window.createWebviewPanel(
            'jsonl-gazelle.largeFileViewer',
            `Large: ${path.basename(uri.fsPath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Show loading indicator
        panel.webview.html = getLoadingHtml(path.basename(uri.fsPath));
        
        // For very large files, only read first 20MB for quick display
        const previewSizeMB = sizeMB > 100 ? 20 : 100;
        
        // Read file in chunks to avoid loading entire file into memory
        const truncated = await readFileUpToLimit(uri.fsPath, previewSizeMB * 1024 * 1024);
        const truncatedMB = (Buffer.byteLength(truncated, 'utf8') / (1024 * 1024)).toFixed(2);
        const lineCount = truncated.split('\n').length;

        panel.webview.html = getLargeFileHtml(path.basename(uri.fsPath), sizeMB.toFixed(2), truncatedMB, lineCount.toString(), truncated);

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'openInSystem':
                    // Close webview and open file immediately
                    panel.dispose();
                    setTimeout(async () => {
                        try {
                            const doc = await vscode.workspace.openTextDocument(uri);
                            await vscode.window.showTextDocument(doc, { 
                                viewColumn: vscode.ViewColumn.One,
                                preview: false // Don't preview, just open
                            });
                        } catch (error: any) {
                            vscode.window.showWarningMessage(
                                'This file is too large to open directly. Right-click on the file and select "Split File into Parts" to create editable files.'
                            );
                        }
                    }, 50);
                    break;
                case 'splitFile':
                    const parts = await splitLargeFile(uri.fsPath);
                    panel.dispose();
                    if (parts.length > 1) {
                        vscode.window.showInformationMessage(
                            `File split into ${parts.length} parts (<50MB each)`
                        );
                    }
                    break;
            }
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error opening file: ${error.message}`);
    }
}

async function readFileUpToLimit(filePath: string, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let truncated = '';
        let currentSize = 0;
        let partialLine = '';

        const stream = fs.createReadStream(filePath, { 
            encoding: 'utf8',
            highWaterMark: 64 * 1024 // Read in 64KB chunks
        });

        stream.on('data', (chunk: string) => {
            const data = partialLine + chunk;
            const lines = data.split('\n');
            
            // Keep the last incomplete line for next chunk
            partialLine = lines.pop() || '';
            
            for (const line of lines) {
                const lineToAdd = line + '\n';
                const lineSize = Buffer.byteLength(lineToAdd, 'utf8');
                
                if (currentSize + lineSize > maxBytes) {
                    stream.destroy();
                    resolve(truncated);
                    return;
                }
                
                truncated += lineToAdd;
                currentSize += lineSize;
            }
        });

        stream.on('end', () => {
            // Add the final partial line if it fits
            if (partialLine && currentSize + Buffer.byteLength(partialLine + '\n', 'utf8') <= maxBytes) {
                truncated += partialLine + '\n';
            }
            resolve(truncated);
        });

        stream.on('error', (err) => {
            reject(err);
        });
    });
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getLoadingHtml(fileName: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        .loading-container {
            text-align: center;
        }
        .spinner {
            border: 4px solid var(--vscode-panel-border);
            border-top: 4px solid var(--vscode-button-background);
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .loading-text {
            color: var(--vscode-foreground);
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="loading-container">
        <div class="spinner"></div>
        <div class="loading-text">Loading ${escapeHtml(fileName)}...</div>
    </div>
</body>
</html>`;
}

function getLargeFileHtml(fileName: string, fileSizeMB: string, truncatedMB: string, lineCount: string, content: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .header {
            background: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .warning {
            background: #fff3cd;
            border: 1px solid #ffc107;
            padding: 15px;
            margin: 15px 20px;
            border-radius: 4px;
            color: #856404;
        }
        .stats {
            padding: 10px 20px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
        }
        .stat-item {
            display: flex;
            flex-direction: column;
        }
        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }
        .stat-value {
            font-size: 14px;
            font-weight: 600;
        }
        .actions {
            padding: 15px 20px;
            display: flex;
            gap: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.2s ease, opacity 0.15s ease;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:active {
            background: var(--vscode-button-secondaryBackground);
            opacity: 0.7;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .content {
            padding: 20px;
            max-height: calc(100vh - 250px);
            overflow: auto;
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2 style="margin: 0">📄 ${escapeHtml(fileName)}</h2>
    </div>
    
    <div class="warning">
        ⚠️ <strong>File exceeds VS Code limit (${escapeHtml(fileSizeMB)}MB > 100MB)</strong><br>
        Showing first ${escapeHtml(truncatedMB)}MB (${escapeHtml(lineCount)} lines). Editing in Gazelle is unavailable.<br>
        <small>💡 Use the button below to open the full file in the standard editor.</small>
    </div>
    
    <div class="stats">
        <div class="stat-item">
            <span class="stat-label">File Size</span>
            <span class="stat-value">${escapeHtml(fileSizeMB)} MB</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Loaded</span>
            <span class="stat-value">${escapeHtml(truncatedMB)} MB</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Lines</span>
            <span class="stat-value">${escapeHtml(lineCount)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Mode</span>
            <span class="stat-value">🔍 View Only</span>
        </div>
    </div>
    
    <div class="actions">
        <button id="splitBtn" onclick="handleSplitFile()">✂️ Split File into Parts &lt;50MB</button>
        <button onclick="vscode.postMessage({ command: 'openInSystem' })">📝 Open in Text Editor (may be slow)</button>
    </div>
    
    <div class="content">${escapeHtml(content)}</div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function handleSplitFile() {
            const btn = document.getElementById('splitBtn');
            if (btn && !btn.disabled) {
                btn.disabled = true;
                btn.textContent = '⏳ Splitting...';
                vscode.postMessage({ command: 'splitFile' });
            }
        }
    </script>
</body>
</html>`;
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
        let partialLine = '';
        let partNumber = 1;
        
        let isCreatingPart = false;
        
        const createPart = async () => {
            if (isCreatingPart || !currentWriteStream) return;
            
            isCreatingPart = true;
            currentWriteStream.end();
            
            await new Promise<void>((res) => {
                if (currentWriteStream) {
                    currentWriteStream.once('finish', () => {
                        isCreatingPart = false;
                        const partPath = path.join(dir, `${base}_part${partNumber}${ext}`);
                        parts.push(partPath);
                        currentWriteStream = fs.createWriteStream(partPath);
                        currentSize = 0;
                        partNumber++;
                        res();
                    });
                } else {
                    isCreatingPart = false;
                    res();
                }
            });
        };
        
        // Create first part synchronously
        const firstPartPath = path.join(dir, `${base}_part${partNumber}${ext}`);
        parts.push(firstPartPath);
        currentWriteStream = fs.createWriteStream(firstPartPath);
        currentSize = 0;
        partNumber++;
        
        const stream = fs.createReadStream(inputPath, {
            encoding: 'utf8',
            highWaterMark: 64 * 1024
        });
        
        stream.on('data', async (chunk: string) => {
            const data = partialLine + chunk;
            const lines = data.split('\n');
            partialLine = lines.pop() || '';
            
            for (const line of lines) {
                // Preserve all lines, including empty ones
                const lineToWrite = line + '\n';
                const lineSize = Buffer.byteLength(lineToWrite, 'utf8');
                
                if (currentSize + lineSize > maxSize && currentSize > 0) {
                    await createPart();
                }
                
                if (currentWriteStream) {
                    currentWriteStream.write(lineToWrite);
                    currentSize += lineSize;
                }
            }
        });
        
        stream.on('end', () => {
            if (partialLine && currentWriteStream) {
                currentWriteStream.write(partialLine + '\n');
                partialLine = '';
            }
            
            if (currentWriteStream) {
                currentWriteStream.end();
            }
            
            // Wait for stream to finish
            if (currentWriteStream) {
                currentWriteStream.once('finish', () => {
                    setTimeout(() => resolve(parts), 200);
                });
            } else {
                setTimeout(() => resolve(parts), 200);
            }
        });
        
        stream.on('error', (err) => reject(err));
    }).catch((error: any) => {
        vscode.window.showErrorMessage(`Error splitting file: ${error.message}`);
        return [];
    });
}

export function deactivate() {}
