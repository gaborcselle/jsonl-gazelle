/**
 * HTML for the JSONL diff webview panel.
 *
 * The extension posts a 'diffData' message with the computed diff model and
 * the script renders it entirely through DOM APIs (textContent only), so no
 * document content is ever interpreted as HTML.
 */

import { NUMBER_LITERAL_MARK } from '../jsonl/diff';

export function getDiffViewHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JSONL Diff</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            color: var(--vscode-editor-foreground, #cccccc);
            background: var(--vscode-editor-background, #1e1e1e);
        }
        .diff-header {
            position: sticky;
            top: 0;
            z-index: 10;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            padding: 8px 12px;
            background: var(--vscode-editorWidget-background, #252526);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            font-family: var(--vscode-font-family, sans-serif);
            font-size: 12px;
        }
        .diff-titles {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1 1 auto;
        }
        .diff-file {
            padding: 2px 8px;
            border-radius: 3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .diff-file.old {
            background: var(--vscode-diffEditor-removedLineBackground, rgba(218, 54, 51, 0.18));
            color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
        }
        .diff-file.new {
            background: var(--vscode-diffEditor-insertedLineBackground, rgba(35, 134, 54, 0.18));
            color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
        }
        .diff-arrow { opacity: 0.6; }
        .diff-note {
            display: none;
            padding: 2px 8px;
            border-radius: 3px;
            background: var(--vscode-inputValidation-infoBackground, rgba(56, 139, 253, 0.15));
            border: 1px solid var(--vscode-inputValidation-infoBorder, rgba(56, 139, 253, 0.4));
        }
        .diff-stats { display: flex; gap: 6px; }
        .stat {
            display: none;
            padding: 2px 8px;
            border-radius: 10px;
            font-weight: 600;
            white-space: nowrap;
        }
        .stat.visible { display: inline-block; }
        .stat.modified {
            background: rgba(210, 153, 34, 0.15);
            color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
        }
        .stat.added {
            background: var(--vscode-diffEditor-insertedLineBackground, rgba(35, 134, 54, 0.18));
            color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
        }
        .stat.removed {
            background: var(--vscode-diffEditor-removedLineBackground, rgba(218, 54, 51, 0.18));
            color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
        }
        .stat.unchanged {
            background: rgba(128, 128, 128, 0.15);
            color: var(--vscode-descriptionForeground, #9d9d9d);
        }
        .diff-empty {
            display: none;
            padding: 24px;
            text-align: center;
            font-family: var(--vscode-font-family, sans-serif);
            color: var(--vscode-descriptionForeground, #9d9d9d);
        }
        .diff-list { padding-bottom: 24px; }
        .diff-row {
            display: flex;
            align-items: flex-start;
            line-height: 1.5;
            border-left: 3px solid transparent;
        }
        .diff-row .gutter {
            flex: 0 0 46px;
            padding: 0 6px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground, #858585);
            user-select: none;
        }
        .diff-row .marker {
            flex: 0 0 18px;
            text-align: center;
            font-weight: 700;
            user-select: none;
        }
        .diff-row .content {
            flex: 1 1 auto;
            min-width: 0;
            padding-right: 12px;
        }
        .diff-row .raw {
            display: block;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .diff-row.expanded .raw {
            white-space: pre-wrap;
            word-break: break-all;
        }
        .diff-row.added {
            background: var(--vscode-diffEditor-insertedLineBackground, rgba(35, 134, 54, 0.15));
            border-left-color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
        }
        .diff-row.added .marker { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
        .diff-row.removed {
            background: var(--vscode-diffEditor-removedLineBackground, rgba(218, 54, 51, 0.15));
            border-left-color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
        }
        .diff-row.removed .marker { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
        .diff-row.modified {
            background: rgba(210, 153, 34, 0.07);
            border-left-color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
            cursor: pointer;
        }
        .diff-row.modified .marker { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); }
        .diff-row.unchanged { opacity: 0.65; }
        .diff-row.added, .diff-row.removed { cursor: pointer; }
        .chips {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 8px;
            padding: 2px 0;
        }
        .chip {
            display: inline-flex;
            align-items: baseline;
            gap: 4px;
            max-width: 100%;
            padding: 0 6px;
            border-radius: 3px;
            background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.12));
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            white-space: nowrap;
            overflow: hidden;
        }
        .chip-path {
            color: var(--vscode-symbolIcon-propertyForeground, #75beff);
            font-weight: 600;
        }
        .chip.added .chip-path { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
        .chip.removed .chip-path { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
        .chip-old {
            background: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.3));
            border-radius: 2px;
            padding: 0 3px;
            text-decoration: line-through;
            text-decoration-thickness: 1px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chip-new {
            background: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.3));
            border-radius: 2px;
            padding: 0 3px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chip-arrow { opacity: 0.6; }
        .row-details {
            display: none;
            gap: 12px;
            padding: 6px 0 8px 0;
            cursor: default;
        }
        .diff-row.open .row-details { display: flex; }
        .row-details .pane {
            flex: 1 1 50%;
            min-width: 0;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            overflow: hidden;
        }
        .row-details .pane-title {
            padding: 2px 8px;
            font-family: var(--vscode-font-family, sans-serif);
            font-size: 11px;
            font-weight: 600;
            background: var(--vscode-editorWidget-background, #252526);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .row-details .pane.old .pane-title { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
        .row-details .pane.new .pane-title { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
        .row-details pre {
            margin: 0;
            padding: 6px 8px;
            overflow: auto;
            max-height: 320px;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .diff-sep {
            padding: 3px 12px 3px 70px;
            color: var(--vscode-descriptionForeground, #9d9d9d);
            background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
            border-top: 1px dashed var(--vscode-panel-border, #3c3c3c);
            border-bottom: 1px dashed var(--vscode-panel-border, #3c3c3c);
            cursor: pointer;
            user-select: none;
            font-family: var(--vscode-font-family, sans-serif);
            font-size: 11px;
        }
        .diff-sep:hover { color: var(--vscode-foreground, #cccccc); }
    </style>
</head>
<body>
    <div class="diff-header">
        <div class="diff-titles">
            <span class="diff-file old" id="leftLabel"></span>
            <span class="diff-arrow">→</span>
            <span class="diff-file new" id="rightLabel"></span>
            <span class="diff-note" id="diffNote"></span>
        </div>
        <div class="diff-stats">
            <span class="stat modified" id="statModified"></span>
            <span class="stat added" id="statAdded"></span>
            <span class="stat removed" id="statRemoved"></span>
            <span class="stat unchanged" id="statUnchanged"></span>
        </div>
    </div>
    <div class="diff-empty" id="diffEmpty"></div>
    <div class="diff-list" id="diffList"></div>

    <script nonce="${nonce}">
        (function() {
            var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
            var CONTEXT_LINES = 3;
            var EXPAND_CHUNK = 200;
            var VALUE_MAX_LEN = 120;
            var TITLE_MAX_LEN = 1500;

            function el(tag, className, text) {
                var node = document.createElement(tag);
                if (className) { node.className = className; }
                if (text !== undefined) { node.textContent = text; }
                return node;
            }

            // --- shared:number-literals (keep in sync with src/jsonl/diff.ts) ---
            // Numbers JSON.parse would change (integers beyond 2^53 are
            // rounded, 1e400 turns into null) travel as marked strings holding
            // their text, and are written back as that text.
            var NUMBER_LITERAL_MARK = ${JSON.stringify(NUMBER_LITERAL_MARK)};
            var LONG_NUMBER_HINT = /\\d{16}|[eE][+-]?\\d{3}/;
            var NUMBER_LITERAL = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$/;
            var MARKED_NUMBER = new RegExp('"' + NUMBER_LITERAL_MARK + '(-?[0-9][0-9.eE+-]*)"', 'g');

            function protectNumberLiterals(text) {
                if (!LONG_NUMBER_HINT.test(text) || text.indexOf(NUMBER_LITERAL_MARK[0]) !== -1 || /\\\\u[eE]000/.test(text)) {
                    return text;
                }
                var result = '';
                var copied = 0;
                var i = 0;
                while (i < text.length) {
                    var ch = text[i];
                    if (ch === '"') {
                        i++;
                        while (i < text.length && text[i] !== '"') {
                            i += text[i] === '\\\\' ? 2 : 1;
                        }
                        i++;
                    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
                        var end = i + 1;
                        while (end < text.length && '0123456789.eE+-'.indexOf(text[end]) !== -1) {
                            end++;
                        }
                        var literal = text.slice(i, end);
                        if (isInexactNumber(literal)) {
                            result += text.slice(copied, i) + '"' + NUMBER_LITERAL_MARK + literal + '"';
                            copied = end;
                        }
                        i = end;
                    } else {
                        i++;
                    }
                }
                return copied === 0 ? text : result + text.slice(copied);
            }

            function isInexactNumber(literal) {
                if (!NUMBER_LITERAL.test(literal)) {
                    return false;
                }
                var value = Number(literal);
                return !isFinite(value) || (/^-?\\d+$/.test(literal) && !Number.isSafeInteger(value));
            }

            function restoreNumberLiterals(json) {
                return json.indexOf(NUMBER_LITERAL_MARK) === -1 ? json : json.replace(MARKED_NUMBER, '$1');
            }
            // --- end shared:number-literals ---

            function formatValue(value) {
                var text;
                if (value === undefined) {
                    text = 'undefined';
                } else {
                    try {
                        text = restoreNumberLiterals(JSON.stringify(value));
                    } catch (e) {
                        text = String(value);
                    }
                }
                return text;
            }

            function truncated(text) {
                if (text.length <= VALUE_MAX_LEN) { return text; }
                return text.slice(0, VALUE_MAX_LEN - 1) + '\\u2026';
            }

            function valueSpan(className, value) {
                var text = formatValue(value);
                var span = el('span', className, truncated(text));
                if (text.length > VALUE_MAX_LEN) {
                    span.title = text.length > TITLE_MAX_LEN ? text.slice(0, TITLE_MAX_LEN) + '\\u2026' : text;
                }
                return span;
            }

            function prettyJson(rawText) {
                try {
                    // The plain parse decides whether the line is valid JSON
                    var value = JSON.parse(rawText);
                    var protectedText = protectNumberLiterals(rawText);
                    if (protectedText !== rawText) {
                        value = JSON.parse(protectedText);
                    }
                    return restoreNumberLiterals(JSON.stringify(value, null, 2));
                } catch (e) {
                    return rawText;
                }
            }

            function buildChip(change) {
                var chip = el('span', 'chip ' + change.type);
                var prefix = change.type === 'added' ? '+ ' : (change.type === 'removed' ? '\\u2212 ' : '');
                chip.appendChild(el('span', 'chip-path', prefix + change.path + ':'));
                if (change.type === 'changed') {
                    chip.appendChild(valueSpan('chip-old', change.oldValue));
                    chip.appendChild(el('span', 'chip-arrow', '\\u2192'));
                    chip.appendChild(valueSpan('chip-new', change.newValue));
                } else if (change.type === 'added') {
                    chip.appendChild(valueSpan('chip-new', change.newValue));
                } else {
                    chip.appendChild(valueSpan('chip-old', change.oldValue));
                }
                return chip;
            }

            function buildDetails(row) {
                var details = el('div', 'row-details');
                details.addEventListener('click', function(e) { e.stopPropagation(); });
                var oldPane = el('div', 'pane old');
                oldPane.appendChild(el('div', 'pane-title', 'Before'));
                var oldPre = el('pre');
                oldPre.textContent = prettyJson(row.oldText || '');
                oldPane.appendChild(oldPre);
                var newPane = el('div', 'pane new');
                newPane.appendChild(el('div', 'pane-title', 'After'));
                var newPre = el('pre');
                newPre.textContent = prettyJson(row.newText || '');
                newPane.appendChild(newPre);
                details.appendChild(oldPane);
                details.appendChild(newPane);
                return details;
            }

            function buildRow(row) {
                var rowEl = el('div', 'diff-row ' + row.type);
                rowEl.appendChild(el('span', 'gutter old', row.oldLineNumber === null ? '' : String(row.oldLineNumber)));
                rowEl.appendChild(el('span', 'gutter new', row.newLineNumber === null ? '' : String(row.newLineNumber)));
                var markers = { added: '+', removed: '\\u2212', modified: '~', unchanged: '' };
                rowEl.appendChild(el('span', 'marker', markers[row.type]));
                var content = el('div', 'content');
                if (row.type === 'modified') {
                    var chips = el('div', 'chips');
                    var changes = row.fieldChanges || [];
                    for (var i = 0; i < changes.length; i++) {
                        chips.appendChild(buildChip(changes[i]));
                    }
                    content.appendChild(chips);
                    content.appendChild(buildDetails(row));
                    rowEl.title = 'Click to show full before/after JSON';
                    rowEl.addEventListener('click', function() {
                        rowEl.classList.toggle('open');
                    });
                } else {
                    var text = row.type === 'removed' ? row.oldText : row.newText;
                    content.appendChild(el('span', 'raw', text === null ? '' : text));
                    if (row.type !== 'unchanged') {
                        rowEl.title = 'Click to toggle line wrapping';
                        rowEl.addEventListener('click', function() {
                            rowEl.classList.toggle('expanded');
                        });
                    }
                }
                rowEl.appendChild(content);
                return rowEl;
            }

            function buildSeparator(hiddenRows) {
                var count = hiddenRows.length;
                var sep = el('div', 'diff-sep', '\\u22EF ' + count + ' unchanged line' + (count === 1 ? '' : 's') + ' \\u2014 click to show');
                sep.addEventListener('click', function() {
                    var fragment = document.createDocumentFragment();
                    var shown = hiddenRows.slice(0, EXPAND_CHUNK);
                    for (var i = 0; i < shown.length; i++) {
                        fragment.appendChild(buildRow(shown[i]));
                    }
                    var rest = hiddenRows.slice(EXPAND_CHUNK);
                    if (rest.length > 0) {
                        fragment.appendChild(buildSeparator(rest));
                    }
                    sep.parentNode.replaceChild(fragment, sep);
                });
                return sep;
            }

            function flushUnchangedRun(container, run, isLeading, isTrailing) {
                if (run.length === 0) { return; }
                var head = isLeading ? 0 : CONTEXT_LINES;
                var tail = isTrailing ? 0 : CONTEXT_LINES;
                if (run.length <= head + tail + 2) {
                    for (var i = 0; i < run.length; i++) {
                        container.appendChild(buildRow(run[i]));
                    }
                    return;
                }
                for (var j = 0; j < head; j++) {
                    container.appendChild(buildRow(run[j]));
                }
                container.appendChild(buildSeparator(run.slice(head, run.length - tail)));
                for (var k = run.length - tail; k < run.length; k++) {
                    container.appendChild(buildRow(run[k]));
                }
            }

            // Every row is unchanged. The texts can still differ in how lines
            // end; saying "identical" then would hide a real change to the file.
            function emptyMessage(lineEndingChanges) {
                var lineEndings = !!(lineEndingChanges && lineEndingChanges.lineEndings);
                var finalNewline = !!(lineEndingChanges && lineEndingChanges.finalNewline);
                if (lineEndings && finalNewline) {
                    return 'No changes to the rows \\u2014 only the line endings and the newline at the end of the file differ.';
                }
                if (lineEndings) {
                    return 'No changes to the rows \\u2014 only the line endings differ (e.g. CRLF vs LF).';
                }
                if (finalNewline) {
                    return 'No changes to the rows \\u2014 only the newline at the end of the file differs.';
                }
                return 'No changes \\u2014 both versions have identical content.';
            }

            function setStat(id, count, label) {
                var node = document.getElementById(id);
                node.textContent = label + ' ' + count;
                node.classList.toggle('visible', count > 0);
            }

            function render(data) {
                document.getElementById('leftLabel').textContent = data.leftLabel;
                document.getElementById('rightLabel').textContent = data.rightLabel;
                var note = document.getElementById('diffNote');
                if (data.note) {
                    note.textContent = data.note;
                    note.style.display = 'inline-block';
                } else {
                    note.style.display = 'none';
                }
                setStat('statModified', data.summary.modified, '~');
                setStat('statAdded', data.summary.added, '+');
                setStat('statRemoved', data.summary.removed, '\\u2212');
                setStat('statUnchanged', data.summary.unchanged, '=');

                var hasChanges = (data.summary.modified + data.summary.added + data.summary.removed) > 0;
                var empty = document.getElementById('diffEmpty');
                empty.textContent = emptyMessage(data.lineEndingChanges);
                empty.style.display = hasChanges ? 'none' : 'block';

                var list = document.getElementById('diffList');
                list.textContent = '';
                if (!hasChanges) { return; }

                var container = document.createDocumentFragment();
                var run = [];
                var seenChange = false;
                for (var i = 0; i < data.rows.length; i++) {
                    var row = data.rows[i];
                    if (row.type === 'unchanged') {
                        run.push(row);
                    } else {
                        flushUnchangedRun(container, run, !seenChange, false);
                        run = [];
                        seenChange = true;
                        container.appendChild(buildRow(row));
                    }
                }
                flushUnchangedRun(container, run, !seenChange, true);
                list.appendChild(container);
            }

            window.addEventListener('message', function(event) {
                var message = event.data;
                if (message && message.type === 'diffData') {
                    render(message.payload);
                }
            });

            // Exposed for testing the view outside of VS Code
            window.__renderDiff = render;

            if (vscode) {
                vscode.postMessage({ type: 'ready' });
            }
        })();
    </script>
</body>
</html>`;
}
