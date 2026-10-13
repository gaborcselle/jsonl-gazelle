// A small in-memory stand-in for the `vscode` module, enough to drive
// JsonlViewerProvider end to end from a plain Node test: documents with real
// text, WorkspaceEdit/applyEdit, change events, and webview panels that record
// what they are sent.
const Module = require('module');

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}

class Range {
    constructor(a, b, c, d) {
        if (a instanceof Position) {
            this.start = a;
            this.end = b;
        } else {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
        }
    }
}

class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}

function uriFor(path) {
    return { toString: () => 'file://' + path, scheme: 'file', fsPath: path };
}

function install() {
    const documents = new Map();
    let changeListeners = [];
    const messages = { info: [], warn: [], error: [] };
    const answers = { warn: undefined };
    const config = {};

    function offsetAt(doc, position) {
        const lines = doc.text.split('\n');
        if (position.line >= lines.length) return doc.text.length;
        let offset = 0;
        for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
        return Math.min(offset + Math.min(position.character, lines[position.line].length), doc.text.length);
    }

    const vscode = {
        Position, Range, WorkspaceEdit,
        Uri: {
            file: uriFor,
            parse: s => uriFor(s.replace(/^file:\/\//, '')),
            joinPath: (base, ...parts) => ({ toString: () => base.toString() + '/' + parts.join('/') })
        },
        ProgressLocation: { Notification: 15 },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        workspace: {
            getConfiguration: () => ({ get: (key, fallback) => (key in config ? config[key] : fallback) }),
            fs: { stat: async uri => ({ size: Buffer.byteLength(documents.get(uri.toString()).text) }) },
            onDidChangeTextDocument(listener) {
                changeListeners.push(listener);
                return { dispose() { changeListeners = changeListeners.filter(l => l !== listener); } };
            },
            async applyEdit(edit) {
                for (const { uri, range, text } of edit.edits) {
                    const doc = documents.get(uri.toString());
                    const start = offsetAt(doc, range.start);
                    const end = offsetAt(doc, range.end);
                    doc.text = doc.text.slice(0, start) + text + doc.text.slice(end);
                    doc.isDirty = true;
                    changeListeners.slice().forEach(listener => listener({ document: doc }));
                }
                return true;
            },
            createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} })
        },
        window: {
            showInformationMessage: async message => { messages.info.push(message); },
            showWarningMessage: async message => { messages.warn.push(message); return answers.warn; },
            showErrorMessage: async message => { messages.error.push(message); },
            withProgress: async (_options, task) => task({ report() {} }),
            registerCustomEditorProvider: () => ({ dispose() {} })
        },
        env: {
            clipboard: { text: '', async readText() { return this.text; }, async writeText(text) { this.text = text; } },
            openExternal: async () => true
        },
        commands: { executeCommand: async () => undefined }
    };

    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return vscode;
        return originalLoad.apply(this, arguments);
    };

    function createDocument(path, text) {
        const doc = {
            text,
            uri: uriFor(path),
            isDirty: false,
            isClosed: false,
            getText() { return this.text; },
            get lineCount() { return this.text.split('\n').length; },
            positionAt(offset) {
                const before = this.text.slice(0, offset).split('\n');
                return new Position(before.length - 1, before[before.length - 1].length);
            },
            async save() { this.isDirty = false; return true; }
        };
        documents.set(doc.uri.toString(), doc);
        return doc;
    }

    // Change a document the way another editor or a git checkout would
    function changeExternally(doc, text) {
        doc.text = text;
        changeListeners.slice().forEach(listener => listener({ document: doc }));
    }

    function createPanel() {
        const panel = {
            posted: [],
            active: true,
            webview: {
                options: {},
                html: '',
                cspSource: 'csp',
                asWebviewUri: uri => uri,
                postMessage(message) { panel.posted.push(message); return Promise.resolve(true); },
                onDidReceiveMessage(handler) { panel.receive = handler; return { dispose() {} }; }
            },
            onDidDispose(handler) { panel.dispose = handler; return { dispose() {} }; },
            onDidChangeViewState(handler) { panel.viewStateChanged = handler; return { dispose() {} }; },
            send(message) { return panel.receive(message); },
            focus() { panel.active = true; return panel.viewStateChanged && panel.viewStateChanged({ webviewPanel: panel }); },
            lastUpdate() {
                for (let i = panel.posted.length - 1; i >= 0; i--) {
                    if (panel.posted[i].type === 'update') return panel.posted[i].data;
                }
                return undefined;
            }
        };
        return panel;
    }

    function createContext() {
        const state = new Map();
        return {
            extensionUri: uriFor('/extension'),
            globalState: {
                get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
                update: async (key, value) => { state.set(key, value); }
            },
            secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
            subscriptions: []
        };
    }

    return { vscode, config, messages, answers, createDocument, changeExternally, createPanel, createContext };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { install, settle };
