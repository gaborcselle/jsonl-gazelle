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
                    tooltip: 'File too large. Right-click and select "Split into Parts (100MB+)" to split the file',
                    color: new vscode.ThemeColor('errorForeground')
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

export function deactivate() {}
