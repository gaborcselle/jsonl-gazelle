/**
 * Webview JavaScript code
 */

import { COLUMN_TYPE_LABELS } from '../jsonl/sorting';

export const scripts = `
        const vscode = acquireVsCodeApi();
        
        function escapeRegex(str) {
            return str.replace(/[\\x2E\\x2A\\x2B\\x3F\\x5E\\x24\\x7B\\x7D\\x28\\x29\\x7C\\x5B\\x5D\\x5C]/g, '\\\\$&');
        }
        
        let currentData = {
            rows: [],
            rowIndices: [], // Mapping of filtered row index to actual row index
            allRows: [], // Full array for index mapping
            columns: [],
            isIndexing: true,
            searchTerm: '',
            parsedLines: [],
            rawContent: '',
            errorCount: 0,
            displaySort: null, // { columnPath, direction } while the view is sorted
            columnTypes: {}, // Detected value type per column path
            uiPreferences: {
                lastView: 'table',
                wrapText: false
            }
        };

        // Shared with the extension host's sort type detection
        const SORT_TYPE_LABELS = ${JSON.stringify(COLUMN_TYPE_LABELS)};

        // Set when a cell edit is expected to move its row under the active
        // display sort; consumed by the next table rebuild (see checkSortJump)
        let pendingSortJumpWatch = null;
        let sortJumpNoticeTimeout = null;

        let contextMenuColumn = null;
        let uiPreferencesApplied = false;
        let prettyEditorModified = false; // Whether the user edited in pretty print view
        let rawEditorModified = false; // Whether the user edited in raw view
        let contextMenuRow = null;
        let currentView = 'table';
        let isResizing = false;
        let resizeData = null;
        let scrollPositions = {
            table: 0,
            json: 0,
            raw: 0
        };
        let savedColumnWidths = {}; // Store column widths by column path
        let selectedRowActualIndex = null; // Actual file index of the selected row (survives re-renders)
        // Spreadsheet-style cell cursor. Held as a file row index + column path
        // rather than screen coordinates, so it survives the full table rebuild
        // that every update does, and follows its row through a display sort.
        let cursorActualRowIndex = null;
        let cursorColumnPath = null;
        // The elements currently carrying the cursor and row highlights. Kept so
        // the highlights can be moved without scanning a fully rendered table;
        // re-pointed by createTableRow as rows are (re-)rendered.
        let cursorCellElement = null;
        let selectedRowElement = null;
        const DEFAULT_PAGE_ROWS = 20; // Page Up/Down fallback when the table height is unknown
        let followMode = false; // Auto-reload and scroll to bottom when the file grows (tail -f)
        let deferredUpdatePending = false; // An update arrived while a cell edit was in progress
        let lastRenderedColumnsKey = null; // Visible-columns signature of the last built table header
        const TABLE_CHUNK_SIZE = 200;
        const JSON_CHUNK_SIZE = 30;
        const tableRenderState = {
            renderedRows: 0,
            totalRows: 0,
            isRendering: false
        };
        const jsonRenderState = {
            renderedRows: 0,
            totalRows: 0,
            isRendering: false
        };
        const rawRenderState = {
            renderedLines: 0,
            totalLines: 0,
            isRendering: false
        };
        const RAW_CHUNK_SIZE = 100;
        let containerScrollListenerAttached = false;
        
        // Column resize functionality
        function startResize(e, th, columnPath) {
            e.preventDefault();
            e.stopPropagation();
            
            // Don't start resizing on click - only on mouse movement
            // Just prepare the resize data
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            const thead = table.querySelector('thead tr');
            
            // Ensure fixed layout and initialize column widths if needed
            if (table.style.tableLayout !== 'fixed') {
                if (colgroup && thead) {
                    const headers = thead.querySelectorAll('th');
                    const cols = colgroup.querySelectorAll('col');
                    headers.forEach((header, index) => {
                        if (cols[index]) {
                            // Use saved width if available, otherwise measure current width
                            let width;
                            const columnPath = cols[index].dataset.columnPath;
                            if (columnPath && savedColumnWidths[columnPath]) {
                                width = parseInt(savedColumnWidths[columnPath], 10);
                            } else {
                                width = header.getBoundingClientRect().width;
                            }
                            
                            // Set explicit width for all columns
                            cols[index].style.width = width + 'px';
                            header.style.width = width + 'px';
                            
                            // Save width for persistence (except row number column)
                            if (columnPath) {
                                savedColumnWidths[columnPath] = width + 'px';
                            }
                        }
                    });
                }
                table.style.tableLayout = 'fixed';
            }
            
            // Get current width from colgroup or header
            let currentWidth = th.offsetWidth;
            const columnIndex = Array.from(th.parentNode.children).indexOf(th);
            if (colgroup) {
                const cols = colgroup.querySelectorAll('col');
                if (cols[columnIndex] && cols[columnIndex].style.width) {
                    currentWidth = parseInt(cols[columnIndex].style.width, 10);
                }
            }
            
            // Store resize data but don't set isResizing yet
            resizeData = {
                th: th,
                columnPath: columnPath,
                startX: e.clientX,
                startWidth: currentWidth,
                hasMoved: false
            };
            
            // Add listeners but only start resizing on actual movement
            document.body.classList.add('resizing');
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', stopResize);
        }
        
        function handleResizeMove(e) {
            if (!resizeData) {
                stopResize();
                return;
            }
            
            const deltaX = e.clientX - resizeData.startX;
            
            // Only start resizing if mouse has actually moved
            if (!resizeData.hasMoved && Math.abs(deltaX) < 1) {
                return; // No movement, don't resize
            }
            
            // Start resizing on first movement
            if (!resizeData.hasMoved) {
                resizeData.hasMoved = true;
                isResizing = true;
            }
            
            if (!isResizing) return;
            
            // Calculate new width: start width + pixels moved
            const newWidth = Math.max(50, resizeData.startWidth + deltaX);
            
            // Update the column width
            resizeData.th.style.width = newWidth + 'px';
            
            // Update the corresponding col element in colgroup
            const columnIndex = Array.from(resizeData.th.parentNode.children).indexOf(resizeData.th);
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            
            if (colgroup) {
                const cols = colgroup.querySelectorAll('col');
                if (cols[columnIndex]) {
                    cols[columnIndex].style.width = newWidth + 'px';
                    
                    // Save this width for persistence
                    const columnPath = cols[columnIndex].dataset.columnPath;
                    if (columnPath) {
                        savedColumnWidths[columnPath] = newWidth + 'px';
                    }
                }
            }
            
            // Update all cells in this column
            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const cell = row.children[columnIndex];
                if (cell) {
                    cell.style.width = newWidth + 'px';
                }
            });
        }
        
        function stopResize() {
            isResizing = false;
            resizeData = null;
            document.body.classList.remove('resizing');
            document.removeEventListener('mousemove', handleResizeMove);
            document.removeEventListener('mouseup', stopResize);
        }

        // Find/Replace State
        let findReplaceState = {
            matches: [],
            currentMatchIndex: -1,
            findPattern: '',
            useRegex: false,
            caseSensitive: false,
            wholeWord: false
        };

        // Find/Replace Modal Functions
        function openFindReplaceBar() {
            // For Monaco editors (json/raw views), trigger Monaco's find widget
            if (currentView === 'json' && prettyEditor) {
                prettyEditor.getAction('actions.find').run();
                return;
            } else if (currentView === 'raw' && rawEditor) {
                rawEditor.getAction('actions.find').run();
                return;
            }
            
            // For table view, show custom find bar
            const bar = document.getElementById('findReplaceBar');
            
            // Toggle: if already visible, close it; otherwise open it
            if (bar.style.display === 'block') {
                closeFindReplaceBar();
            } else {
                bar.style.display = 'block';
                document.getElementById('findInput').focus();
                performFind(); // Initial find with current input
            }
        }

        function closeFindReplaceBar() {
            const bar = document.getElementById('findReplaceBar');
            bar.style.display = 'none';
            clearHighlights();
        }

        function performFind() {
            const findText = document.getElementById('findInput').value;
            const useRegex = document.getElementById('regexCheckbox').checked;
            const caseSensitive = document.getElementById('caseSensitiveCheckbox').checked;
            const wholeWord = document.getElementById('wholeWordCheckbox').checked;

            // Clear previous highlights
            clearHighlights();

            if (!findText) {
                document.getElementById('findMatchCount').textContent = '0 matches';
                document.getElementById('regexError').style.display = 'none';
                findReplaceState.matches = [];
                return;
            }

            try {
                // Build search pattern
                let pattern;
                if (useRegex) {
                    pattern = new RegExp(findText, caseSensitive ? 'g' : 'gi');
                } else {
                    let escapedText = escapeRegex(findText);
                    if (wholeWord) {
                        escapedText = '\\\\b' + escapedText + '\\\\b';
                    }
                    pattern = new RegExp(escapedText, caseSensitive ? 'g' : 'gi');
                }

                // Hide regex error if pattern is valid
                document.getElementById('regexError').style.display = 'none';

                // Store state
                findReplaceState.findPattern = findText;
                findReplaceState.useRegex = useRegex;
                findReplaceState.caseSensitive = caseSensitive;
                findReplaceState.wholeWord = wholeWord;

                // Find matches based on current view
                findMatchesInCurrentView(pattern);

                // Update match count
                const matchCount = findReplaceState.matches.length;
                document.getElementById('findMatchCount').textContent =
                    matchCount === 0 ? 'No matches' :
                    matchCount === 1 ? '1 match' :
                    matchCount + ' matches';

                // Highlight first match
                if (matchCount > 0) {
                    findReplaceState.currentMatchIndex = 0;
                    highlightCurrentMatch();
                }

            } catch (error) {
                // Show regex error
                document.getElementById('regexError').textContent = 'Invalid regex pattern: ' + error.message;
                document.getElementById('regexError').style.display = 'block';
                findReplaceState.matches = [];
                document.getElementById('findMatchCount').textContent = '0 matches';
            }
        }

        function findMatchesInCurrentView(pattern) {
            findReplaceState.matches = [];

            if (currentView === 'table') {
                // Search in table cells (use raw value if available, otherwise text content)
                const cells = document.querySelectorAll('#dataTable td');
                cells.forEach((cell, index) => {
                    // Use raw value for accurate matching (without JSON quotes)
                    const text = cell.dataset.rawValue !== undefined ? cell.dataset.rawValue : cell.textContent;
                    const matches = [...text.matchAll(pattern)];

                    // Get the row index from the cell's parent row
                    const row = cell.closest('tr');
                    const rowIndex = row ? parseInt(row.dataset.index) || 0 : 0;
                    const cellIndexInRow = Array.from(row.children).indexOf(cell);

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: cell,
                            text: text,
                            match: match[0],
                            index: match.index,
                            cellIndex: index,
                            rowIndex: rowIndex,
                            cellIndexInRow: cellIndexInRow,
                            matchIndexInCell: match.index
                        });
                    });
                });

                // Sort matches by row, then by cell position in row, then by position in cell
                // This ensures top-to-bottom, left-to-right order
                findReplaceState.matches.sort((a, b) => {
                    if (a.rowIndex !== b.rowIndex) {
                        return a.rowIndex - b.rowIndex;
                    }
                    if (a.cellIndexInRow !== b.cellIndexInRow) {
                        return a.cellIndexInRow - b.cellIndexInRow;
                    }
                    return a.matchIndexInCell - b.matchIndexInCell;
                });
            } else if (currentView === 'json') {
                // Search in JSON view
                const jsonLines = document.querySelectorAll('.json-content-editable');
                jsonLines.forEach((textarea, lineIndex) => {
                    const text = textarea.value;
                    const matches = [...text.matchAll(pattern)];

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: textarea,
                            text: text,
                            match: match[0],
                            index: match.index,
                            lineIndex: lineIndex
                        });
                    });
                });
            } else if (currentView === 'raw') {
                // Search in raw view
                const rawLines = document.querySelectorAll('.raw-line-content');
                rawLines.forEach((lineContent, lineIndex) => {
                    const text = lineContent.textContent;
                    const matches = [...text.matchAll(pattern)];

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: lineContent,
                            text: text,
                            match: match[0],
                            index: match.index,
                            lineIndex: lineIndex
                        });
                    });
                });
            }
        }

        function highlightCurrentMatch() {
            // Clear previous current highlight
            document.querySelectorAll('.find-highlight-current').forEach(el => {
                el.classList.remove('find-highlight-current');
                el.classList.add('find-highlight');
            });

            if (findReplaceState.currentMatchIndex < 0 ||
                findReplaceState.currentMatchIndex >= findReplaceState.matches.length) {
                return;
            }

            const match = findReplaceState.matches[findReplaceState.currentMatchIndex];

            // Scroll to and highlight the match
            if (match.element) {
                match.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // For table cells and raw content, add highlight class
                if (currentView === 'table' || currentView === 'raw') {
                    match.element.classList.add('find-highlight-current');
                } else if (currentView === 'json') {
                    // For JSON textareas, set selection
                    match.element.focus();
                    match.element.setSelectionRange(match.index, match.index + match.match.length);
                }
            }

            // Update count display
            document.getElementById('findMatchCount').textContent =
                (findReplaceState.currentMatchIndex + 1) + ' of ' + findReplaceState.matches.length;
        }

        function clearHighlights() {
            document.querySelectorAll('.find-highlight, .find-highlight-current').forEach(el => {
                el.classList.remove('find-highlight', 'find-highlight-current');
            });
        }

        function findNext() {
            if (findReplaceState.matches.length === 0) {
                performFind();
                return;
            }

            // Go to next match (wrap to start if at end)
            findReplaceState.currentMatchIndex =
                (findReplaceState.currentMatchIndex + 1) % findReplaceState.matches.length;
            highlightCurrentMatch();
        }

        function findPrevious() {
            if (findReplaceState.matches.length === 0) {
                performFind();
                return;
            }

            // Go to previous match (wrap to end if at start)
            findReplaceState.currentMatchIndex =
                (findReplaceState.currentMatchIndex - 1 + findReplaceState.matches.length) % findReplaceState.matches.length;
            highlightCurrentMatch();
        }

        function replaceCurrent() {
            if (findReplaceState.currentMatchIndex < 0 ||
                findReplaceState.matches.length === 0) {
                return;
            }

            const match = findReplaceState.matches[findReplaceState.currentMatchIndex];
            const replaceText = document.getElementById('replaceInput').value;

            if (currentView === 'table') {
                // Replace in table cell
                const cell = match.element;
                const row = cell.closest('tr');
                const rowIndex = parseInt(row.dataset.index);
                const columnPath = cell.dataset.columnPath;

                // Get actual row data with safety checks
                const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                    ? currentData.rowIndices[rowIndex]
                    : rowIndex;

                const allRows = currentData.allRows || currentData.rows || [];
                const rowData = allRows[actualRowIndex];

                if (!rowData) {
                    console.error('Could not find row data for index:', actualRowIndex);
                    console.error('Available data:', {
                        rowIndex,
                        actualRowIndex,
                        allRowsLength: allRows.length,
                        hasRowIndices: !!currentData.rowIndices
                    });
                    return;
                }

                // Get current value from the stored raw value (which matches what we searched)
                let currentValueStr = match.text; // Use the text we found the match in

                // Perform replacement on the actual value
                const newValueStr = currentValueStr.substring(0, match.index) +
                                    replaceText +
                                    currentValueStr.substring(match.index + match.match.length);

                // Update display (JSON stringify for consistent display)
                match.element.textContent = JSON.stringify(newValueStr);
                // Update the raw value data attribute
                match.element.dataset.rawValue = newValueStr;

                // Send update to backend
                vscode.postMessage({
                    type: 'updateCell',
                    rowIndex: actualRowIndex,
                    columnPath: columnPath,
                    value: newValueStr
                });

            } else if (currentView === 'json') {
                // Replace in JSON textarea
                const textarea = match.element;
                const oldValue = textarea.value;
                const newValue = oldValue.substring(0, match.index) +
                                 replaceText +
                                 oldValue.substring(match.index + match.match.length);

                textarea.value = newValue;

                // Trigger update
                const rowIndex = parseInt(textarea.closest('.json-line').dataset.index);
                const actualRowIndex = currentData.rowIndices ? currentData.rowIndices[rowIndex] : rowIndex;

                try {
                    const parsedData = JSON.parse(newValue);
                    vscode.postMessage({
                        type: 'documentChanged',
                        rowIndex: actualRowIndex,
                        newData: parsedData
                    });
                } catch (e) {
                    // Invalid JSON after replace
                }

            } else if (currentView === 'raw') {
                // Raw view is read-only for cell-level edits, so skip
                vscode.window.showWarningMessage('Replace is not supported in Raw view. Switch to Table or JSON view.');
                return;
            }

            // Re-run find to update matches
            performFind();
        }

        function replaceAll() {
            if (findReplaceState.matches.length === 0) {
                return;
            }

            const replaceText = document.getElementById('replaceInput').value;
            const matchCount = findReplaceState.matches.length;

            // Note: confirm() doesn't work in sandboxed webviews, so we skip confirmation
            // User can always undo with Ctrl+Z

            // Group matches by element to reduce updates
            const elementMatches = new Map();
            findReplaceState.matches.forEach(match => {
                if (!elementMatches.has(match.element)) {
                    elementMatches.set(match.element, []);
                }
                elementMatches.get(match.element).push(match);
            });

            // Replace in each element (process in reverse order to maintain indices)
            elementMatches.forEach((matches, element) => {
                matches.sort((a, b) => b.index - a.index); // Reverse order

                if (currentView === 'table') {
                    const row = element.closest('tr');
                    const rowIndex = parseInt(row.dataset.index);
                    const columnPath = element.dataset.columnPath;

                    // Get actual row data with safety checks
                    const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                        ? currentData.rowIndices[rowIndex]
                        : rowIndex;

                    const allRows = currentData.allRows || currentData.rows || [];
                    const rowData = allRows[actualRowIndex];

                    if (!rowData) {
                        console.error('Could not find row data for index:', actualRowIndex);
                        return;
                    }

                    // Get current value from the first match's text (all matches in same element have same text)
                    let newText = matches[0].text;

                    // Apply all replacements in reverse order (already sorted)
                    matches.forEach(match => {
                        newText = newText.substring(0, match.index) +
                                  replaceText +
                                  newText.substring(match.index + match.match.length);
                    });

                    // Update display (JSON stringify for consistent display)
                    element.textContent = JSON.stringify(newText);
                    // Update the raw value data attribute
                    element.dataset.rawValue = newText;

                    // Send update
                    vscode.postMessage({
                        type: 'updateCell',
                        rowIndex: actualRowIndex,
                        columnPath: columnPath,
                        value: newText
                    });

                } else if (currentView === 'json') {
                    let newValue = element.value;
                    matches.forEach(match => {
                        newValue = newValue.substring(0, match.index) +
                                   replaceText +
                                   newValue.substring(match.index + match.match.length);
                    });

                    element.value = newValue;

                    const rowIndex = parseInt(element.closest('.json-line').dataset.index);
                    const actualRowIndex = currentData.rowIndices ? currentData.rowIndices[rowIndex] : rowIndex;

                    try {
                        const parsedData = JSON.parse(newValue);
                        vscode.postMessage({
                            type: 'documentChanged',
                            rowIndex: actualRowIndex,
                            newData: parsedData
                        });
                    } catch (e) {
                        // Invalid JSON
                    }
                }
            });

            vscode.window.showInformationMessage('Replaced ' + matchCount + ' occurrences');

            // Re-run find
            performFind();
        }

        // Find/Replace Event Listeners
        document.getElementById('findInput').addEventListener('input', performFind);
        document.getElementById('regexCheckbox').addEventListener('change', performFind);
        document.getElementById('caseSensitiveCheckbox').addEventListener('change', performFind);
        document.getElementById('wholeWordCheckbox').addEventListener('change', performFind);
        document.getElementById('findReplaceCloseBtn').addEventListener('click', closeFindReplaceBar);

        document.getElementById('findNextBtn').addEventListener('click', findNext);
        document.getElementById('findPrevBtn').addEventListener('click', findPrevious);
        document.getElementById('replaceBtn').addEventListener('click', replaceCurrent);
        document.getElementById('replaceAllBtn').addEventListener('click', replaceAll);

        // Keyboard shortcuts for Find/Replace
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + F: Open Find
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                if (currentView === 'table') {
                    e.preventDefault();
                    openFindReplaceBar();
                } else if (currentView === 'json' && prettyEditor) {
                    e.preventDefault();
                    prettyEditor.getAction('actions.find').run();
                } else if (currentView === 'raw' && rawEditor) {
                    e.preventDefault();
                    rawEditor.getAction('actions.find').run();
                }
            }

            // Cmd/Ctrl + H: Open Find/Replace (only for Table view)
            if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
                if (currentView === 'table') {
                    e.preventDefault();
                    openFindReplaceBar();
                    document.getElementById('replaceInput').focus();
                }
                // For 'json' and 'raw' views, let Monaco's built-in Find widget handle it
            }

            // Escape: Close Find/Replace bar, Column Manager modal or file stats
            if (e.key === 'Escape') {
                if (document.getElementById('findReplaceBar').style.display === 'block') {
                    closeFindReplaceBar();
                } else if (document.getElementById('columnManagerModal').classList.contains('show')) {
                    closeColumnManager();
                } else {
                    toggleFileInfo(true);
                }
            }

            // Enter in find input: Find next
            if (e.key === 'Enter' && document.activeElement.id === 'findInput') {
                e.preventDefault();
                findNext();
            }

            // Enter in replace input: Replace current
            if (e.key === 'Enter' && document.activeElement.id === 'replaceInput') {
                e.preventDefault();
                if (e.shiftKey) {
                    replaceAll();
                } else {
                    replaceCurrent();
                }
            }

            // F3 or Cmd/Ctrl+G: Find next (only for Table view)
            if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key === 'g')) {
                if (currentView === 'table') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        findPrevious();
                    } else {
                        findNext();
                    }
                }
                // For 'json' and 'raw' views, let Monaco handle Find Next/Previous
            }
        });

        // Refresh shortcuts (Ctrl/Cmd+R, F5) and Escape-to-deselect.
        // Capture phase so the shortcut wins over Monaco in the raw/pretty views.
        document.addEventListener('keydown', (e) => {
            const isRefreshKey = e.key === 'F5' ||
                ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R'));
            if (isRefreshKey) {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'refresh' });
                return;
            }
            if (e.key === 'Escape' && !document.querySelector('td.editing') &&
                (selectedRowActualIndex !== null || cursorActualRowIndex !== null)) {
                clearCellCursor();
                clearRowSelection();
            }
        }, true);

        // Spreadsheet keyboard navigation: arrow keys move a cell cursor, Enter
        // (or F2) edits the cell under it, Tab advances to the next cell.
        const GRID_NAVIGATION_KEYS = {
            ArrowUp: 'up',
            ArrowDown: 'down',
            ArrowLeft: 'left',
            ArrowRight: 'right',
            Home: 'rowStart',
            End: 'rowEnd',
            PageUp: 'pageUp',
            PageDown: 'pageDown'
        };

        document.addEventListener('keydown', (e) => {
            // Modified arrows are VS Code's (line moves, entry navigation)
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (!isGridNavigationActive()) return;

            const move = GRID_NAVIGATION_KEYS[e.key];
            if (move) {
                e.preventDefault();
                moveCellCursor(move);
                return;
            }

            // Tab and Enter have jobs outside the grid - only take them over
            // once the cursor is actually on a cell
            if (!getCursorPosition()) return;

            if (e.key === 'Tab') {
                e.preventDefault();
                moveCellCursor(e.shiftKey ? 'previous' : 'next');
            } else if (e.key === 'Enter' || e.key === 'F2') {
                if (isActivationKeyOwnedByFocus()) return;
                e.preventDefault();
                editCursorCell();
            }
        });

        // Event listeners
        document.getElementById('logo').addEventListener('click', () => {
            vscode.postMessage({
                type: 'openUrl',
                url: 'https://github.com/gaborcselle/jsonl-gazelle'
            });
        });

        // Refresh and Follow buttons
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });
        document.getElementById('followBtn').addEventListener('click', () => {
            followMode = !followMode;
            document.getElementById('followBtn').classList.toggle('toggled', followMode);
            vscode.postMessage({ type: 'setFollowMode', enabled: followMode });
            if (followMode) {
                vscode.postMessage({ type: 'refresh' });
                followScrollToBottom();
            }
        });

        // Find/Replace Button
        document.getElementById('findReplaceBtn').addEventListener('click', openFindReplaceBar);

        // File stats popover
        document.getElementById('fileInfoBtn').addEventListener('click', () => toggleFileInfo());
        // A resize can move or rewrap the toolbar out from under the popover
        window.addEventListener('resize', () => toggleFileInfo(true));

        // Column Manager Modal
        document.getElementById('columnManagerBtn').addEventListener('click', openColumnManager);
        document.getElementById('modalCloseBtn').addEventListener('click', closeColumnManager);
        document.getElementById('columnManagerModal').addEventListener('click', (e) => {
            if (e.target.id === 'columnManagerModal') {
                closeColumnManager();
            }
        });
        
        // Wrap Text Toggle
        const wrapTextCheckbox = document.getElementById('wrapTextCheckbox');

        wrapTextCheckbox.addEventListener('change', (e) => {
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            const thead = table.querySelector('thead tr');

            if (e.target.checked) {
                // Freeze current column widths before applying wrap; only while the
                // table is visible - a hidden table measures every column as 0px
                if (currentView === 'table' && colgroup && thead) {
                    const headers = thead.querySelectorAll('th');
                    const cols = colgroup.querySelectorAll('col');

                    // Measure and freeze ALL column widths
                    headers.forEach((th, index) => {
                        if (cols[index]) {
                            // Always set width to current actual width
                            const width = th.getBoundingClientRect().width;
                            cols[index].style.width = width + 'px';

                            // Save width for persistence
                            const columnPath = cols[index].dataset.columnPath;
                            if (columnPath) {
                                savedColumnWidths[columnPath] = width + 'px';
                            }
                        }
                    });

                    // Apply fixed layout to prevent recalculation
                    table.style.tableLayout = 'fixed';
                }

                // Add wrap class
                table.classList.add('text-wrap');
            } else {
                // Remove wrap but KEEP widths and fixed layout
                table.classList.remove('text-wrap');
                // Note: We intentionally do NOT remove table-layout or col widths
                // so the column sizes remain stable
            }

            // Wrap is shared by all three views; keep the editors in sync
            const editorWordWrap = e.target.checked ? 'on' : 'off';
            if (prettyEditor) prettyEditor.updateOptions({ wordWrap: editorWordWrap });
            if (rawEditor) rawEditor.updateOptions({ wordWrap: editorWordWrap });

            // Persist wrap text preference globally
            vscode.postMessage({
                type: 'setWrapTextPreference',
                enabled: e.target.checked
            });
        });
        
        function openColumnManager() {
            const modal = document.getElementById('columnManagerModal');
            const columnList = document.getElementById('columnList');
            columnList.innerHTML = '';
            
            currentData.columns.forEach((column, index) => {
                const columnItem = document.createElement('div');
                columnItem.className = 'column-item';
                columnItem.draggable = true;
                columnItem.dataset.columnIndex = index;
                columnItem.dataset.columnPath = column.path;
                
                // Drag handle
                const dragHandle = document.createElement('div');
                dragHandle.className = 'column-drag-handle';
                dragHandle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="8" x2="20" y2="8"></line><line x1="4" y1="16" x2="20" y2="16"></line></svg>';
                
                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'column-checkbox';
                checkbox.checked = column.visible;
                checkbox.addEventListener('change', () => {
                    vscode.postMessage({
                        type: 'toggleColumnVisibility',
                        columnPath: column.path
                    });
                });
                
                // Column name
                const columnName = document.createElement('span');
                columnName.className = 'column-name';
                columnName.textContent = column.displayName;
                columnName.title = column.displayName;
                
                columnItem.appendChild(dragHandle);
                columnItem.appendChild(checkbox);
                columnItem.appendChild(columnName);
                
                // Drag events for modal
                columnItem.addEventListener('dragstart', handleModalDragStart);
                columnItem.addEventListener('dragend', handleModalDragEnd);
                columnItem.addEventListener('dragover', handleModalDragOver);
                columnItem.addEventListener('drop', handleModalDrop);
                
                columnList.appendChild(columnItem);
            });
            
            modal.classList.add('show');
        }
        
        function closeColumnManager() {
            const modal = document.getElementById('columnManagerModal');
            modal.classList.remove('show');
        }
        
        // Add Column Modal
        let addColumnPosition = null;
        let addColumnReferenceColumn = null;
        
        function openAddColumnModal(position, referenceColumn) {
            addColumnPosition = position;
            addColumnReferenceColumn = referenceColumn;
            
            const modal = document.getElementById('addColumnModal');
            const input = document.getElementById('newColumnName');
            input.value = '';
            modal.classList.add('show');
            
            // Focus input
            setTimeout(() => input.focus(), 100);
        }
        
        function closeAddColumnModal() {
            const modal = document.getElementById('addColumnModal');
            modal.classList.remove('show');
            addColumnPosition = null;
            addColumnReferenceColumn = null;
        }
        
        function confirmAddColumn() {
            const input = document.getElementById('newColumnName');
            const columnName = input.value.trim();
            
            if (!columnName) {
                return; // Don't add empty column name
            }
            
            vscode.postMessage({
                type: 'addColumn',
                columnName: columnName,
                position: addColumnPosition,
                referenceColumn: addColumnReferenceColumn
            });
            
            closeAddColumnModal();
        }
        
        // Add Column Modal event listeners
        document.getElementById('addColumnCloseBtn').addEventListener('click', closeAddColumnModal);
        document.getElementById('addColumnCancelBtn').addEventListener('click', closeAddColumnModal);
        document.getElementById('addColumnConfirmBtn').addEventListener('click', confirmAddColumn);
        document.getElementById('addColumnModal').addEventListener('click', (e) => {
            if (e.target.id === 'addColumnModal') {
                closeAddColumnModal();
            }
        });
        document.getElementById('newColumnName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmAddColumn();
            } else if (e.key === 'Escape') {
                closeAddColumnModal();
            }
        });

        // AI Column Modal
        let aiColumnPosition = null;
        let aiColumnReferenceColumn = null;
        let aiColumnEscHandler = null;
        let aiColumnEnumInputHandler = null;
        let aiColumnModalClickHandler = null;
        let aiColumnCloseBtnHandler = null;
        let aiColumnCancelBtnHandler = null;
        let aiColumnConfirmBtnHandler = null;
        let aiColumnModalBodyScrollHandler = null;
        let aiColumnWindowResizeHandler = null;
        let aiColumnWindowScrollHandler = null;

        function openAIColumnModal(position, referenceColumn) {
            aiColumnPosition = position;
            aiColumnReferenceColumn = referenceColumn;

            const modal = document.getElementById('aiColumnModal');
            const nameInput = document.getElementById('aiColumnName');
            const promptInput = document.getElementById('aiPrompt');
            const useEnumCheckbox = document.getElementById('aiUseEnum');
            const enumValuesInput = document.getElementById('aiEnumValues');
            
            nameInput.value = '';
            promptInput.value = '';
            useEnumCheckbox.checked = false;
            enumValuesInput.value = '';
            enumValuesInput.style.display = 'none';
            enumValuesInput.disabled = true;
            
            // Reset prompt required attribute and label
            const promptLabel = document.querySelector('label[for="aiPrompt"]');
            promptInput.setAttribute('required', 'required');
            if (promptLabel) {
                promptLabel.textContent = promptLabel.textContent.replace(' (optional):', ':');
            }
            
            modal.classList.add('show');

            // Remove previous backdrop click handler if it exists
            if (aiColumnModalClickHandler) {
                modal.removeEventListener('mousedown', aiColumnModalClickHandler);
            }
            
            // Add mousedown handler for closing modal on backdrop click
            aiColumnModalClickHandler = (e) => {
                // Close only if click is on the backdrop, not on modal content
                if (!e.target.closest('.modal-content')) {
                    closeAIColumnModal();
                }
            };
            modal.addEventListener('mousedown', aiColumnModalClickHandler);

            // Add close, cancel and confirm button handlers
            const closeBtn = document.getElementById('aiColumnCloseBtn');
            const cancelBtn = document.getElementById('aiColumnCancelBtn');
            const confirmBtn = document.getElementById('aiColumnConfirmBtn');
            
            // Remove existing handlers if they exist
            if (aiColumnCloseBtnHandler && closeBtn) {
                closeBtn.removeEventListener('click', aiColumnCloseBtnHandler);
            }
            if (aiColumnCancelBtnHandler && cancelBtn) {
                cancelBtn.removeEventListener('click', aiColumnCancelBtnHandler);
            }
            if (aiColumnConfirmBtnHandler && confirmBtn) {
                confirmBtn.removeEventListener('click', aiColumnConfirmBtnHandler);
            }
            
            // Add new handlers
            aiColumnCloseBtnHandler = () => closeAIColumnModal();
            aiColumnCancelBtnHandler = () => closeAIColumnModal();
            aiColumnConfirmBtnHandler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                confirmAIColumn();
            };
            
            closeBtn.addEventListener('click', aiColumnCloseBtnHandler);
            cancelBtn.addEventListener('click', aiColumnCancelBtnHandler);
            confirmBtn.addEventListener('click', aiColumnConfirmBtnHandler);

            // Remove previous ESC handler if it exists
            if (aiColumnEscHandler) {
                document.removeEventListener('keydown', aiColumnEscHandler);
            }
            
            // Add ESC handler for modal
            aiColumnEscHandler = (e) => {
                if (e.key === 'Escape') {
                    closeAIColumnModal();
                }
            };
            document.addEventListener('keydown', aiColumnEscHandler);
            
            // Remove previous enum input handler if it exists
            if (aiColumnEnumInputHandler) {
                enumValuesInput.removeEventListener('input', aiColumnEnumInputHandler);
            }
            
            // Add input handler for enum values input
            aiColumnEnumInputHandler = (e) => {
                // Clear previous timer
                if (enumInputDebounceTimer) {
                    clearTimeout(enumInputDebounceTimer);
                }
                
                // Set new timer with 500ms delay
                enumInputDebounceTimer = setTimeout(() => {
                    showEnumDropdown(e.target.value);
                }, 500);
            };
            enumValuesInput.addEventListener('input', aiColumnEnumInputHandler);

            // Add scroll and resize handlers for enum dropdown positioning
            const aiColumnModalBody = modal.querySelector('.modal-body');
            if (aiColumnModalBody) {
                aiColumnModalBodyScrollHandler = updateEnumDropdownPosition;
                aiColumnModalBody.addEventListener('scroll', aiColumnModalBodyScrollHandler);
            }
            aiColumnWindowResizeHandler = updateEnumDropdownPosition;
            aiColumnWindowScrollHandler = updateEnumDropdownPosition;
            window.addEventListener('resize', aiColumnWindowResizeHandler);
            window.addEventListener('scroll', aiColumnWindowScrollHandler, true);

            // Focus name input
            setTimeout(() => nameInput.focus(), 100);
        }

        function closeAIColumnModal() {
            const modal = document.getElementById('aiColumnModal');
            const useEnumCheckbox = document.getElementById('aiUseEnum');
            const enumValuesInput = document.getElementById('aiEnumValues');
            const promptInput = document.getElementById('aiPrompt');
            const promptLabel = document.querySelector('label[for="aiPrompt"]');
            
            modal.classList.remove('show');
            aiColumnPosition = null;
            aiColumnReferenceColumn = null;
            useEnumCheckbox.checked = false;
            enumValuesInput.value = '';
            enumValuesInput.style.display = 'none';
            enumValuesInput.disabled = true;
            
            // Hide dropdown
            hideEnumDropdown();
            
            // Remove enum dropdown handlers
            const dropdown = document.getElementById('enumHistoryDropdown');
            if (dropdown) {
                if (enumDropdownMousedownHandler) {
                    dropdown.removeEventListener('mousedown', enumDropdownMousedownHandler);
                    enumDropdownMousedownHandler = null;
                }
                if (enumDropdownMouseupHandler) {
                    dropdown.removeEventListener('mouseup', enumDropdownMouseupHandler);
                    enumDropdownMouseupHandler = null;
                }
            }
            
            // Remove scroll and resize handlers
            const aiColumnModalBody = modal.querySelector('.modal-body');
            if (aiColumnModalBody && aiColumnModalBodyScrollHandler) {
                aiColumnModalBody.removeEventListener('scroll', aiColumnModalBodyScrollHandler);
                aiColumnModalBodyScrollHandler = null;
            }
            if (aiColumnWindowResizeHandler) {
                window.removeEventListener('resize', aiColumnWindowResizeHandler);
                aiColumnWindowResizeHandler = null;
            }
            if (aiColumnWindowScrollHandler) {
                window.removeEventListener('scroll', aiColumnWindowScrollHandler, true);
                aiColumnWindowScrollHandler = null;
            }
            
            // Clear debounce timer
            if (enumInputDebounceTimer) {
                clearTimeout(enumInputDebounceTimer);
                enumInputDebounceTimer = null;
            }
            
            // Remove ESC handler
            if (aiColumnEscHandler) {
                document.removeEventListener('keydown', aiColumnEscHandler);
                aiColumnEscHandler = null;
            }
            
            // Remove input handler
            if (aiColumnEnumInputHandler) {
                enumValuesInput.removeEventListener('input', aiColumnEnumInputHandler);
                aiColumnEnumInputHandler = null;
            }
            
            // Remove mousedown handler for backdrop click
            if (aiColumnModalClickHandler) {
                modal.removeEventListener('mousedown', aiColumnModalClickHandler);
                aiColumnModalClickHandler = null;
            }
            
            // Remove close, cancel and confirm button handlers
            const closeBtn = document.getElementById('aiColumnCloseBtn');
            const cancelBtn = document.getElementById('aiColumnCancelBtn');
            const confirmBtn = document.getElementById('aiColumnConfirmBtn');
            
            if (aiColumnCloseBtnHandler && closeBtn) {
                closeBtn.removeEventListener('click', aiColumnCloseBtnHandler);
                aiColumnCloseBtnHandler = null;
            }
            if (aiColumnCancelBtnHandler && cancelBtn) {
                cancelBtn.removeEventListener('click', aiColumnCancelBtnHandler);
                aiColumnCancelBtnHandler = null;
            }
            if (aiColumnConfirmBtnHandler && confirmBtn) {
                confirmBtn.removeEventListener('click', aiColumnConfirmBtnHandler);
                aiColumnConfirmBtnHandler = null;
            }
            
            // Reset prompt required attribute and label
            promptInput.setAttribute('required', 'required');
            if (promptLabel) {
                promptLabel.textContent = promptLabel.textContent.replace(' (optional):', ':');
            }
        }

        function confirmAIColumn() {
            const nameInput = document.getElementById('aiColumnName');
            const promptInput = document.getElementById('aiPrompt');
            const useEnumCheckbox = document.getElementById('aiUseEnum');
            const enumValuesInput = document.getElementById('aiEnumValues');
            
            const columnName = nameInput.value.trim();
            const promptTemplate = promptInput.value.trim();
            const useEnum = useEnumCheckbox.checked;
            const enumValues = enumValuesInput.value.trim();

            // Column name is always required
            if (!columnName) {
                return;
            }

            // Prompt is required unless enum is selected
            if (!useEnum && !promptTemplate) {
                return;
            }

            // Enum values are required when enum is selected
            if (useEnum && !enumValues) {
                // Show error or warning
                enumValuesInput.focus();
                return;
            }

            const enumArray = useEnum && enumValues 
                ? enumValues.split(',').map(v => v.trim()).filter(v => v.length > 0)
                : null;

            vscode.postMessage({
                type: 'addAIColumn',
                columnName: columnName,
                promptTemplate: promptTemplate || '', // Send empty string if no prompt
                position: aiColumnPosition,
                referenceColumn: aiColumnReferenceColumn,
                enumValues: enumArray
            });

            closeAIColumnModal();
        }

        // AI Suggestions Modal
        let suggestionsModalReferenceColumn = null;
        let suggestionsModalEscHandler = null;
        let suggestionsModalClickHandler = null;
        let suggestionsModalCloseBtnHandler = null;
        let suggestionsModalCancelBtnHandler = null;

        function checkAPIKeyAndOpenSuggestionsModal(referenceColumn) {
            checkAPIKeyAndOpenModal(openAISuggestionsModal, referenceColumn);
        }

        function openAISuggestionsModal(referenceColumn) {
            suggestionsModalReferenceColumn = referenceColumn;

            const modal = document.getElementById('aiSuggestionsModal');
            const loadingDiv = document.getElementById('aiSuggestionsLoading');
            const listDiv = document.getElementById('aiSuggestionsList');
            const errorDiv = document.getElementById('aiSuggestionsError');
            
            // Show loading, hide list and error
            loadingDiv.style.display = 'block';
            listDiv.style.display = 'none';
            errorDiv.style.display = 'none';
            listDiv.innerHTML = '';
            
            modal.classList.add('show');

            // Remove previous backdrop click handler if it exists
            if (suggestionsModalClickHandler) {
                modal.removeEventListener('mousedown', suggestionsModalClickHandler);
            }

            // Add mousedown handler for closing modal on backdrop click
            suggestionsModalClickHandler = (e) => {
                if (!e.target.closest('.modal-content')) {
                    closeAISuggestionsModal();
                }
            };
            modal.addEventListener('mousedown', suggestionsModalClickHandler);

            // Get buttons
            const closeBtn = document.getElementById('aiSuggestionsCloseBtn');
            const cancelBtn = document.getElementById('aiSuggestionsCancelBtn');
            
            // Remove existing button handlers if they exist
            if (suggestionsModalCloseBtnHandler && closeBtn) {
                closeBtn.removeEventListener('click', suggestionsModalCloseBtnHandler);
            }
            if (suggestionsModalCancelBtnHandler && cancelBtn) {
                cancelBtn.removeEventListener('click', suggestionsModalCancelBtnHandler);
            }

            // Add close and cancel button handlers
            suggestionsModalCloseBtnHandler = () => closeAISuggestionsModal();
            suggestionsModalCancelBtnHandler = () => closeAISuggestionsModal();
            
            closeBtn.addEventListener('click', suggestionsModalCloseBtnHandler);
            cancelBtn.addEventListener('click', suggestionsModalCancelBtnHandler);

            // Remove previous ESC handler if it exists
            if (suggestionsModalEscHandler) {
                document.removeEventListener('keydown', suggestionsModalEscHandler);
            }

            // Add ESC handler for modal
            suggestionsModalEscHandler = (e) => {
                if (e.key === 'Escape') {
                    closeAISuggestionsModal();
                }
            };
            document.addEventListener('keydown', suggestionsModalEscHandler);
            
            // Request suggestions from backend
            vscode.postMessage({
                type: 'requestColumnSuggestions',
                referenceColumn: referenceColumn
            });
        }

        function closeAISuggestionsModal() {
            const modal = document.getElementById('aiSuggestionsModal');
            modal.classList.remove('show');
            
            // Remove ESC handler
            if (suggestionsModalEscHandler) {
                document.removeEventListener('keydown', suggestionsModalEscHandler);
                suggestionsModalEscHandler = null;
            }
            
            // Remove backdrop click handler
            if (suggestionsModalClickHandler) {
                modal.removeEventListener('mousedown', suggestionsModalClickHandler);
                suggestionsModalClickHandler = null;
            }
            
            // Remove close and cancel button handlers
            const closeBtn = document.getElementById('aiSuggestionsCloseBtn');
            const cancelBtn = document.getElementById('aiSuggestionsCancelBtn');
            
            if (suggestionsModalCloseBtnHandler && closeBtn) {
                closeBtn.removeEventListener('click', suggestionsModalCloseBtnHandler);
                suggestionsModalCloseBtnHandler = null;
            }
            if (suggestionsModalCancelBtnHandler && cancelBtn) {
                cancelBtn.removeEventListener('click', suggestionsModalCancelBtnHandler);
                suggestionsModalCancelBtnHandler = null;
            }
            
            suggestionsModalReferenceColumn = null;
        }

        function handleAISuggestions(suggestions, error) {
            const loadingDiv = document.getElementById('aiSuggestionsLoading');
            const listDiv = document.getElementById('aiSuggestionsList');
            const errorDiv = document.getElementById('aiSuggestionsError');
            
            loadingDiv.style.display = 'none';
            
            if (error) {
                errorDiv.style.display = 'block';
                document.getElementById('aiSuggestionsErrorMessage').textContent = error;
                return;
            }
            
            if (!suggestions || suggestions.length === 0) {
                errorDiv.style.display = 'block';
                document.getElementById('aiSuggestionsErrorMessage').textContent = 'No suggestions generated. Please try again.';
                return;
            }
            
            listDiv.style.display = 'block';
            listDiv.innerHTML = '';
            
            suggestions.forEach((suggestion) => {
                const suggestionItem = document.createElement('div');
                suggestionItem.style.cssText = 'padding: 12px; border: 1px solid var(--vscode-input-border); border-radius: 6px; cursor: pointer; background: var(--vscode-input-background); transition: background 0.2s; margin-bottom: 10px;';
                suggestionItem.onmouseover = () => {
                    suggestionItem.style.background = 'var(--vscode-list-hoverBackground)';
                };
                suggestionItem.onmouseout = () => {
                    suggestionItem.style.background = 'var(--vscode-input-background)';
                };
                suggestionItem.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Store reference column before closing
                    const refColumn = suggestionsModalReferenceColumn;
                    
                    // Close suggestions modal
                    closeAISuggestionsModal();
                    
                    // Small delay to ensure modal is fully closed before opening new one
                    setTimeout(() => {
                        // Open AI column modal with pre-filled data
                        openAIColumnModal('before', refColumn);
                        
                        // Pre-fill the inputs
                        setTimeout(() => {
                            const nameInput = document.getElementById('aiColumnName');
                            const promptInput = document.getElementById('aiPrompt');
                            
                            if (nameInput) nameInput.value = suggestion.columnName;
                            if (promptInput) promptInput.value = suggestion.prompt;
                        }, 50);
                    }, 50);
                };
                
                const columnName = document.createElement('div');
                columnName.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground); font-size: 14px;';
                columnName.textContent = suggestion.columnName;
                
                const prompt = document.createElement('div');
                prompt.style.cssText = 'font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.5;';
                prompt.textContent = suggestion.prompt;
                
                suggestionItem.appendChild(columnName);
                suggestionItem.appendChild(prompt);
                listDiv.appendChild(suggestionItem);
            });
        }

        // AI Column Modal event listeners (info button is static, confirm is added dynamically)
        document.getElementById('aiColumnInfoBtn').addEventListener('click', () => {
            const infoPanel = document.getElementById('aiInfoPanel');
            infoPanel.style.display = infoPanel.style.display === 'none' ? 'block' : 'none';
        });
        
        // Enum checkbox toggle
        document.getElementById('aiUseEnum').addEventListener('change', (e) => {
            const useEnum = e.target.checked;
            const enumValuesInput = document.getElementById('aiEnumValues');
            const promptInput = document.getElementById('aiPrompt');
            const promptLabel = document.querySelector('label[for="aiPrompt"]');
            
            if (useEnum) {
                enumValuesInput.style.display = 'block';
                enumValuesInput.disabled = false;
                // Remove required attribute from prompt when enum is selected
                promptInput.removeAttribute('required');
                // Update label to indicate prompt is optional
                if (promptLabel && !promptLabel.textContent.includes('(optional')) {
                    promptLabel.textContent = promptLabel.textContent.replace(':', ' (optional):');
                }
                // Request recent enum values from backend
                vscode.postMessage({ type: 'getRecentEnumValues' });
                setTimeout(() => enumValuesInput.focus(), 100);
            } else {
                enumValuesInput.style.display = 'none';
                enumValuesInput.disabled = true;
                enumValuesInput.value = '';
                hideEnumDropdown();
                // Add required attribute back to prompt when enum is not selected
                promptInput.setAttribute('required', 'required');
                // Restore original label
                if (promptLabel) {
                    promptLabel.textContent = promptLabel.textContent.replace(' (optional):', ':');
                }
            }
        });
        
        // Enum dropdown management
        let recentEnumValues = [];
        let enumInputDebounceTimer = null;
        let enumDropdownMousedownHandler = null;
        let enumDropdownMouseupHandler = null;
        
        function hideEnumDropdown() {
            const dropdown = document.getElementById('enumHistoryDropdown');
            dropdown.style.display = 'none';
        }
        
        function updateEnumDropdownPosition() {
            const dropdown = document.getElementById('enumHistoryDropdown');
            const enumValuesInput = document.getElementById('aiEnumValues');
            if (dropdown && dropdown.style.display !== 'none' && enumValuesInput && enumValuesInput.offsetParent !== null) {
                const inputRect = enumValuesInput.getBoundingClientRect();
                dropdown.style.top = (inputRect.bottom + 2) + 'px';
                dropdown.style.left = inputRect.left + 'px';
                dropdown.style.width = inputRect.width + 'px';
            }
        }
        
        function showEnumDropdown(filterText = '') {
            if (recentEnumValues.length === 0) {
                hideEnumDropdown();
                return;
            }
            
            const dropdown = document.getElementById('enumHistoryDropdown');
            
            // Filter values based on input text
            let valuesToShow = recentEnumValues;
            if (filterText.length > 0) {
                const filterLower = filterText.toLowerCase();
                valuesToShow = recentEnumValues.filter(value => 
                    value.toLowerCase().startsWith(filterLower)
                );
            }
            
            if (valuesToShow.length === 0) {
                hideEnumDropdown();
                return;
            }
            
            dropdown.replaceChildren();
            valuesToShow.forEach(value => {
                const item = document.createElement('div');
                item.className = 'enum-history-item';
                item.textContent = value;
                dropdown.appendChild(item);
            });
            
            dropdown.style.display = 'block';
            updateEnumDropdownPosition();
            
            // Use event delegation on dropdown container instead of individual items
            // This avoids needing to remove handlers when items are recreated
            if (!enumDropdownMousedownHandler) {
                enumDropdownMousedownHandler = (e) => {
                    const item = e.target.closest('.enum-history-item');
                    if (item) {
                        e.preventDefault(); // Prevent input blur
                        e.stopPropagation(); // Prevent event from bubbling to modal
                    }
                };
                dropdown.addEventListener('mousedown', enumDropdownMousedownHandler);
            }
            if (!enumDropdownMouseupHandler) {
                enumDropdownMouseupHandler = (e) => {
                    const item = e.target.closest('.enum-history-item');
                    if (item) {
                        e.preventDefault(); // Prevent input blur
                        e.stopPropagation(); // Prevent event from bubbling to modal
                        const enumValuesInput = document.getElementById('aiEnumValues');
                        enumValuesInput.value = item.textContent;
                        hideEnumDropdown();
                        // Keep focus on input
                        setTimeout(() => enumValuesInput.focus(), 10);
                    }
                };
                dropdown.addEventListener('mouseup', enumDropdownMouseupHandler);
            }
        }
        
        // Handle focus/blur on enum input
        document.getElementById('aiEnumValues').addEventListener('focus', () => {
            const enumValuesInput = document.getElementById('aiEnumValues');
            showEnumDropdown(enumValuesInput.value);
        });
        
        document.getElementById('aiEnumValues').addEventListener('blur', (e) => {
            // Use setTimeout to allow click on dropdown item before hiding
            setTimeout(() => {
                const dropdown = document.getElementById('enumHistoryDropdown');
                const activeElement = document.activeElement;
                // Only hide if focus didn't move to dropdown
                if (activeElement !== dropdown && !dropdown.contains(activeElement)) {
                    hideEnumDropdown();
                }
            }, 200);
        });

        // Settings Modal
        // Store which modal should be opened after settings are saved
        let pendingModalCallback = null;
        let pendingModalArgs = null;

        // Per-provider AI settings state
        const AI_PROVIDER_META = {
            openai: { label: 'OpenAI', keyLabel: 'OpenAI API Key:', placeholder: 'sk-...' },
            anthropic: { label: 'Anthropic', keyLabel: 'Anthropic API Key:', placeholder: 'sk-ant-...' },
            gemini: { label: 'Google Gemini', keyLabel: 'Google Gemini API Key:', placeholder: 'AIza...' },
            local: { label: 'Local server', keyLabel: 'API Key (optional):', placeholder: 'optional - most local servers need no key', keyOptional: true, needsBaseUrl: true, noKey: true }
        };
        const settingsState = {
            provider: 'openai',
            keys: { openai: '', anthropic: '', gemini: '', local: '' },
            loadedKeys: { openai: '', anthropic: '', gemini: '', local: '' },
            models: { openai: 'gpt-5.4-mini', anthropic: 'claude-opus-4-8', gemini: 'gemini-2.5-flash', local: '' },
            availableModels: {
                openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
                anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
                gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
                local: []
            },
            localBaseUrl: 'http://localhost:11434/v1'
        };
        // Providers whose model list was already auto-fetched this session
        const autoFetchedProviders = {};

        // Copy the current form inputs into settingsState for the active provider
        function stashSettingsInputs() {
            const p = settingsState.provider;
            settingsState.keys[p] = document.getElementById('aiApiKey').value;
            const modelSelect = document.getElementById('aiModelSelect');
            if (modelSelect.value) {
                settingsState.models[p] = modelSelect.value;
            }
            if (AI_PROVIDER_META[p] && AI_PROVIDER_META[p].needsBaseUrl) {
                settingsState.localBaseUrl = document.getElementById('aiBaseUrl').value;
            }
        }

        function renderModelOptions() {
            const p = settingsState.provider;
            const modelSelect = document.getElementById('aiModelSelect');
            const models = (settingsState.availableModels[p] || []).slice();
            const current = settingsState.models[p];
            if (current && models.indexOf(current) === -1) {
                models.unshift(current);
            }
            modelSelect.innerHTML = '';
            models.forEach(function(m) {
                const option = document.createElement('option');
                option.value = m;
                option.textContent = m;
                modelSelect.appendChild(option);
            });
            if (current) {
                modelSelect.value = current;
            }
        }

        function renderSettingsForm() {
            const p = settingsState.provider;
            const meta = AI_PROVIDER_META[p] || AI_PROVIDER_META.openai;
            document.getElementById('aiProviderSelect').value = p;
            document.getElementById('aiApiKeyLabel').textContent = meta.keyLabel;
            const keyInput = document.getElementById('aiApiKey');
            keyInput.placeholder = meta.placeholder;
            keyInput.value = settingsState.keys[p] || '';
            const keyRow = document.getElementById('aiApiKeyRow');
            if (keyRow) {
                keyRow.style.display = meta.noKey ? 'none' : 'block';
            }

            const baseUrlRow = document.getElementById('aiBaseUrlRow');
            if (baseUrlRow) {
                baseUrlRow.style.display = meta.needsBaseUrl ? 'block' : 'none';
            }
            if (meta.needsBaseUrl) {
                document.getElementById('aiBaseUrl').value = settingsState.localBaseUrl || '';
            }

            renderModelOptions();

            // Automatically pull the latest model list once per provider when it's usable
            const canFetch = meta.keyOptional || (settingsState.keys[p] || '').trim();
            if (canFetch && !autoFetchedProviders[p]) {
                autoFetchedProviders[p] = true;
                requestModelFetch();
            }
        }

        function requestModelFetch() {
            stashSettingsInputs();
            const p = settingsState.provider;
            const meta = AI_PROVIDER_META[p] || AI_PROVIDER_META.openai;
            const key = (settingsState.keys[p] || '').trim();
            const status = document.getElementById('modelFetchStatus');
            if (!key && !meta.keyOptional) {
                if (status) {
                    status.textContent = 'Enter an API key to fetch the latest models.';
                }
                return;
            }
            if (status) {
                status.textContent = 'Fetching latest models...';
            }
            const request = { type: 'fetchModels', provider: p, apiKey: key };
            if (meta.needsBaseUrl) {
                request.baseUrl = settingsState.localBaseUrl;
            }
            vscode.postMessage(request);
        }

        function openSettingsModal(showWarning = false, modalCallback = null, ...modalArgs) {
            const modal = document.getElementById('settingsModal');

            // Store the callback and args if provided
            pendingModalCallback = modalCallback;
            pendingModalArgs = modalArgs;

            // Show or hide warning based on parameter
            const warningElement = document.getElementById('apiKeyWarning');
            if (warningElement) {
                warningElement.style.display = showWarning ? 'block' : 'none';
            }

            const statusElement = document.getElementById('modelFetchStatus');
            if (statusElement) {
                statusElement.textContent = '';
            }

            // Request current settings from backend
            vscode.postMessage({ type: 'getSettings' });

            modal.classList.add('show');
        }

        function checkAPIKeyAndOpenModal(modalFunction, ...args) {
            vscode.postMessage({ type: 'checkAPIKey' });
            
            // Listen for API key check response
            const checkAPIKeyListener = (event) => {
                const message = event.data;
                if (message.type === 'apiKeyCheckResult') {
                    window.removeEventListener('message', checkAPIKeyListener);
                    clearTimeout(timeoutId);
                    
                    if (message.hasAPIKey) {
                        modalFunction(...args);
                    } else {
                        // Send message to backend to show warning and open settings
                        vscode.postMessage({ 
                            type: 'showAPIKeyWarning' 
                        });
                        // Open settings modal with warning and callback to open the original modal
                        openSettingsModal(true, modalFunction, ...args);
                    }
                }
            };
            
            // Timeout after 5 seconds if no response
            const timeoutId = setTimeout(() => {
                window.removeEventListener('message', checkAPIKeyListener);
                console.error('API key check timed out');
                // Fallback: open settings modal
                vscode.postMessage({ 
                    type: 'showAPIKeyWarning' 
                });
                openSettingsModal(true, modalFunction, ...args);
            }, 5000);
            
            window.addEventListener('message', checkAPIKeyListener);
        }

        function closeSettingsModal() {
            const modal = document.getElementById('settingsModal');
            modal.classList.remove('show');
            // Clear pending callback when closing
            pendingModalCallback = null;
            pendingModalArgs = null;
        }

        function saveSettings() {
            stashSettingsInputs();

            // Store callback and args before they're cleared
            const callback = pendingModalCallback;
            const args = pendingModalArgs;

            // Only send keys that changed since they were loaded
            const keysToSave = {};
            Object.keys(AI_PROVIDER_META).forEach(function(p) {
                if (settingsState.keys[p] !== settingsState.loadedKeys[p]) {
                    keysToSave[p] = settingsState.keys[p];
                }
            });

            vscode.postMessage({
                type: 'saveSettings',
                settings: {
                    provider: settingsState.provider,
                    keys: keysToSave,
                    models: settingsState.models,
                    localBaseUrl: settingsState.localBaseUrl
                },
                // Include callback info if available
                openOriginalModal: !!callback
            });

            const activeMeta = AI_PROVIDER_META[settingsState.provider] || AI_PROVIDER_META.openai;
            const activeProviderReady = !!activeMeta.keyOptional || !!(settingsState.keys[settingsState.provider] || '').trim();

            closeSettingsModal();

            // If there was a pending modal callback and the provider is usable, wait for confirmation
            if (callback && activeProviderReady) {
                // Listen for settings saved confirmation from backend
                const settingsSavedListener = (event) => {
                    const message = event.data;
                    if (message.type === 'settingsSaved') {
                        window.removeEventListener('message', settingsSavedListener);
                        
                        if (message.hasAPIKey) {
                            // Open the original modal
                            callback(...args);
                        }
                    }
                };
                
                window.addEventListener('message', settingsSavedListener);
                // Cleanup after 5 seconds
                setTimeout(() => {
                    window.removeEventListener('message', settingsSavedListener);
                }, 5000);
            }
        }

        // Settings Modal event listeners
        document.getElementById('aiProviderSelect').addEventListener('change', (e) => {
            // The form still shows the previous provider's values - stash them first
            stashSettingsInputs();
            settingsState.provider = e.target.value;
            renderSettingsForm();
        });
        document.getElementById('refreshModelsBtn').addEventListener('click', requestModelFetch);
        document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
        document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsModal);
        document.getElementById('settingsCancelBtn').addEventListener('click', closeSettingsModal);
        document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                closeSettingsModal();
            }
        });
        // Hidden reset button - sends reset message to backend
        document.getElementById('settingsResetBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'resetSettings' });
        });


        // AI Rows Modal
        let aiRowsReferenceRow = null;

        function openAIRowsModal(rowIndex) {
            aiRowsReferenceRow = rowIndex;

            const modal = document.getElementById('aiRowsModal');
            const contextRowCountInput = document.getElementById('contextRowCount');
            const rowCountInput = document.getElementById('rowCount');
            const promptInput = document.getElementById('aiRowsPrompt');
            const advancedSection = document.getElementById('aiRowsAdvancedSection');
            const advancedToggle = document.getElementById('aiRowsAdvancedToggle');

            // Set defaults
            contextRowCountInput.value = '10';
            rowCountInput.value = '5';
            if (!promptInput.value || promptInput.value === promptInput.placeholder) {
                promptInput.value = 'Based on these example rows:\\n{{context_rows}}\\n\\nGenerate {{row_count}} new unique rows with the EXACT same structure and all the same fields. Make the data realistic and different from the examples above.';
            }

            // Hide advanced section by default when opening
            if (advancedSection) {
                advancedSection.style.display = 'none';
            }
            if (advancedToggle) {
                advancedToggle.textContent = 'Advanced';
            }

            modal.classList.add('show');

            // Focus context row count input
            setTimeout(() => contextRowCountInput.focus(), 100);
        }

        function closeAIRowsModal() {
            const modal = document.getElementById('aiRowsModal');
            modal.classList.remove('show');
            aiRowsReferenceRow = null;
        }

        function generateAIRows() {
            const contextRowCount = parseInt(document.getElementById('contextRowCount').value) || 10;
            const rowCount = parseInt(document.getElementById('rowCount').value) || 5;
            const promptTemplate = document.getElementById('aiRowsPrompt').value.trim();

            if (!promptTemplate) {
                return;
            }

            vscode.postMessage({
                type: 'generateAIRows',
                rowIndex: aiRowsReferenceRow,
                contextRowCount: contextRowCount,
                rowCount: rowCount,
                promptTemplate: promptTemplate
            });

            closeAIRowsModal();
        }

        // AI Rows Modal event listeners
        document.getElementById('aiRowsCloseBtn').addEventListener('click', closeAIRowsModal);
        document.getElementById('aiRowsCancelBtn').addEventListener('click', closeAIRowsModal);
        document.getElementById('aiRowsGenerateBtn').addEventListener('click', generateAIRows);
        document.getElementById('aiRowsModal').addEventListener('click', (e) => {
            if (e.target.id === 'aiRowsModal') {
                closeAIRowsModal();
            }
        });
        const aiRowsAdvancedToggleBtn = document.getElementById('aiRowsAdvancedToggle');
        if (aiRowsAdvancedToggleBtn) {
            aiRowsAdvancedToggleBtn.addEventListener('click', () => {
                const section = document.getElementById('aiRowsAdvancedSection');
                if (!section) return;
                const isHidden = section.style.display === 'none';
                section.style.display = isHidden ? 'block' : 'none';
                aiRowsAdvancedToggleBtn.textContent = isHidden ? 'Hide Advanced' : 'Advanced';
            });
        }

        // Modal drag and drop
        let draggedModalItem = null;
        
        function handleModalDragStart(e) {
            draggedModalItem = e.target;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        }
        
        function handleModalDragEnd(e) {
            e.target.classList.remove('dragging');
            document.querySelectorAll('.column-item').forEach(item => {
                item.classList.remove('drag-over');
            });
        }
        
        function handleModalDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const target = e.target.closest('.column-item');
            if (target && target !== draggedModalItem) {
                document.querySelectorAll('.column-item').forEach(item => {
                    item.classList.remove('drag-over');
                });
                target.classList.add('drag-over');
            }
        }
        
        function handleModalDrop(e) {
            e.preventDefault();
            
            const target = e.target.closest('.column-item');
            if (target && target !== draggedModalItem) {
                const fromIndex = parseInt(draggedModalItem.dataset.columnIndex);
                const toIndex = parseInt(target.dataset.columnIndex);
                
                vscode.postMessage({
                    type: 'reorderColumns',
                    fromIndex: fromIndex,
                    toIndex: toIndex
                });
                
                // Visual reorder
                const columnList = document.getElementById('columnList');
                if (fromIndex < toIndex) {
                    columnList.insertBefore(draggedModalItem, target.nextSibling);
                } else {
                    columnList.insertBefore(draggedModalItem, target);
                }
                
                // Update indices
                Array.from(columnList.children).forEach((item, index) => {
                    item.dataset.columnIndex = index;
                });
            }
            
            target.classList.remove('drag-over');
        }
        
        
        
        
        
        
        // --- shared:unhideable-columns (keep in sync with src/jsonl/columns.ts) ---
        function getUnhideableColumns(columns) {
            if (!Array.isArray(columns)) {
                return [];
            }

            const byPath = new Map();
            columns.forEach(col => byPath.set(col.path, col));

            return columns.filter(col => {
                if (col.visible || col.isExpanded) {
                    return false;
                }
                if (col.parentPath) {
                    const parent = byPath.get(col.parentPath);
                    if (!parent || !parent.isExpanded) {
                        return false;
                    }
                }
                return true;
            });
        }
        // --- end shared:unhideable-columns ---

        // Fills the "Unhide Column" submenu; returns true when there is anything to unhide
        function populateUnhideColumnsMenu() {
            const menuItem = document.getElementById('unhideColumnsMenuItem');
            const submenu = document.getElementById('unhideColumnsSubmenu');
            const label = document.getElementById('unhideColumnsLabel');
            if (!menuItem || !submenu) return false;

            menuItem.classList.remove('submenu-open');
            submenu.classList.remove('flip-left', 'flip-up');
            submenu.scrollTop = 0;
            submenu.innerHTML = '';

            const hiddenColumns = getUnhideableColumns(currentData && currentData.columns);

            if (hiddenColumns.length === 0) {
                menuItem.style.display = 'none';
                return false;
            }

            if (label) {
                label.textContent = 'Unhide Column (' + hiddenColumns.length + ')';
            }

            hiddenColumns.forEach(column => {
                const entry = document.createElement('div');
                entry.className = 'context-menu-item';
                entry.dataset.action = 'unhideColumn';
                entry.dataset.columnPath = column.path;
                entry.textContent = column.displayName || column.path;
                entry.title = column.path;
                submenu.appendChild(entry);
            });

            if (hiddenColumns.length > 1) {
                const separator = document.createElement('div');
                separator.className = 'context-menu-separator';
                submenu.appendChild(separator);

                const showAll = document.createElement('div');
                showAll.className = 'context-menu-item';
                showAll.dataset.action = 'unhideAllColumns';
                showAll.textContent = 'Unhide All Columns';
                submenu.appendChild(showAll);
            }

            menuItem.style.display = 'block';
            return true;
        }

        // Open the column menu straight onto its unhide list. Used by the badge on
        // the row-number header, so unhiding is reachable by left-click and not
        // only by knowing to right-click.
        function openUnhideColumnsMenu(event) {
            event.preventDefault();
            // The document-level handler closes the menu on any outside click,
            // and this button sits outside it
            event.stopPropagation();

            showContextMenu(event, null);

            const menuItem = document.getElementById('unhideColumnsMenuItem');
            if (!menuItem || menuItem.style.display === 'none') return;

            menuItem.classList.add('submenu-open');
            positionUnhideColumnsSubmenu();
        }

        // Flip the submenu when it would run past the right or bottom edge of the window
        function positionUnhideColumnsSubmenu() {
            positionSubmenu('unhideColumnsMenuItem', 'unhideColumnsSubmenu');
        }

        function positionSortSubmenu() {
            positionSubmenu('sortMenuItem', 'sortSubmenu');
        }

        function positionSubmenu(menuItemId, submenuId) {
            const menuItem = document.getElementById(menuItemId);
            const submenu = document.getElementById(submenuId);
            if (!menuItem || !submenu) return;

            submenu.classList.remove('flip-left', 'flip-up');

            // Measure off-screen so the flip decision doesn't depend on the hover state
            const previousDisplay = submenu.style.display;
            const previousVisibility = submenu.style.visibility;
            submenu.style.visibility = 'hidden';
            submenu.style.display = 'block';

            const itemRect = menuItem.getBoundingClientRect();
            const submenuWidth = submenu.offsetWidth;
            const submenuHeight = submenu.offsetHeight;

            submenu.style.display = previousDisplay;
            submenu.style.visibility = previousVisibility;

            if (itemRect.right + submenuWidth > window.innerWidth && itemRect.left - submenuWidth > 0) {
                submenu.classList.add('flip-left');
            }
            if (itemRect.top + submenuHeight > window.innerHeight && itemRect.bottom - submenuHeight > 0) {
                submenu.classList.add('flip-up');
            }
        }

        function showContextMenu(event, columnPath) {
            event.preventDefault();
            contextMenuColumn = columnPath || null;

            const menu = document.getElementById('contextMenu');
            const unstringifyMenuItem = document.getElementById('unstringifyMenuItem');

            const hasHiddenColumns = populateUnhideColumnsMenu();

            // Column-specific entries only make sense when a data column was right-clicked
            // (the row-number header opens the same menu just to reach the unhide list)
            menu.querySelectorAll('.column-only').forEach(element => {
                element.style.display = contextMenuColumn ? 'block' : 'none';
            });

            // Check if this column contains stringified JSON
            const hasStringifiedJson = contextMenuColumn ? checkColumnForStringifiedJson(contextMenuColumn) : false;
            unstringifyMenuItem.style.display = hasStringifiedJson ? 'block' : 'none';

            if (contextMenuColumn) {
                // Tell the user how this column's values will be compared. Stays
                // hidden until detection has run, rather than guessing a type.
                const sortTypeHint = document.getElementById('sortTypeHint');
                if (sortTypeHint) {
                    const detectedType = currentData.columnTypes && currentData.columnTypes[contextMenuColumn];
                    sortTypeHint.textContent = detectedType
                        ? 'Sorts as: ' + (SORT_TYPE_LABELS[detectedType] || detectedType)
                        : '';
                    sortTypeHint.style.display = detectedType ? 'block' : 'none';
                }

                // Clearing is only meaningful while a column is display-sorted
                const clearDisplaySortMenuItem = document.getElementById('clearDisplaySortMenuItem');
                if (clearDisplaySortMenuItem) {
                    clearDisplaySortMenuItem.style.display = currentData.displaySort ? 'block' : 'none';
                }
            }

            if (!contextMenuColumn && !hasHiddenColumns) {
                hideContextMenu();
                return;
            }

            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';

            // Keep the menu inside the window now that its height varies with the unhide entry
            const menuRect = menu.getBoundingClientRect();
            if (menuRect.right > window.innerWidth) {
                menu.style.left = Math.max(0, event.pageX - menuRect.width) + 'px';
            }
            if (menuRect.bottom > window.innerHeight) {
                menu.style.top = Math.max(0, event.pageY - menuRect.height) + 'px';
            }

            positionUnhideColumnsSubmenu();
        }

        function checkColumnForStringifiedJson(columnPath) {
            // Check a sample of rows to see if they contain stringified JSON
            const sampleSize = Math.min(20, currentData.rows.length);
            for (let i = 0; i < sampleSize; i++) {
                const value = getNestedValue(currentData.rows[i], columnPath);
                if (isStringifiedJson(value)) {
                    return true;
                }
            }
            return false;
        }
        
        function isStringifiedJson(value) {
            if (typeof value !== 'string') {
                return false;
            }
            
            const trimmed = value.trim();
            // Check if it starts with "[" or "{" and looks like JSON
            return (trimmed.startsWith('[') || trimmed.startsWith('{')) && 
                   (trimmed.endsWith(']') || trimmed.endsWith('}'));
        }
        
        // Display-only sort. The extension permutes the rows it sends back, so
        // the table just re-renders; the file on disk is untouched.
        function setDisplaySort(columnPath, direction) {
            hideSortJumpNotice(); // Positions in it refer to the old ordering
            vscode.postMessage({
                type: 'setDisplaySort',
                columnPath: columnPath,
                direction: direction
            });
        }

        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
            document.getElementById('unhideColumnsMenuItem')?.classList.remove('submenu-open');
            document.getElementById('sortMenuItem')?.classList.remove('submenu-open');
            document.getElementById('rowContextMenu').style.display = 'none';
            contextMenuColumn = null;
            contextMenuRow = null;
        }
        
        function handleContextMenu(event) {
            const item = event.target.closest('.context-menu-item');
            const action = item?.dataset.action;
            if (!action) return;

            // Unhide entries work without a right-clicked column
            switch (action) {
                case 'unhideColumns':
                    // Parent of the submenu: toggle it (for click/touch) and keep the menu open
                    item.classList.toggle('submenu-open');
                    positionUnhideColumnsSubmenu();
                    return;
                case 'unhideColumn':
                    vscode.postMessage({
                        type: 'showColumns',
                        columnPaths: [item.dataset.columnPath]
                    });
                    hideContextMenu();
                    return;
                case 'unhideAllColumns':
                    vscode.postMessage({ type: 'showColumns' });
                    hideContextMenu();
                    return;
            }

            if (!contextMenuColumn) return;

            switch (action) {
                case 'sortMenu':
                    // Parent of the sort submenu: toggle it and keep the menu open
                    item.classList.toggle('submenu-open');
                    positionSortSubmenu();
                    return;
                case 'displaySortAsc':
                    setDisplaySort(contextMenuColumn, 'asc');
                    break;
                case 'displaySortDesc':
                    setDisplaySort(contextMenuColumn, 'desc');
                    break;
                case 'clearDisplaySort':
                    setDisplaySort(null, null);
                    break;
                case 'sortAsc':
                    vscode.postMessage({
                        type: 'sortRows',
                        columnPath: contextMenuColumn,
                        direction: 'asc'
                    });
                    break;
                case 'sortDesc':
                    vscode.postMessage({
                        type: 'sortRows',
                        columnPath: contextMenuColumn,
                        direction: 'desc'
                    });
                    break;
                case 'hideColumn':
                    vscode.postMessage({
                        type: 'toggleColumnVisibility',
                        columnPath: contextMenuColumn
                    });
                    break;
                case 'insertBefore':
                    openAddColumnModal('before', contextMenuColumn);
                    break;
                case 'insertAfter':
                    openAddColumnModal('after', contextMenuColumn);
                    break;
                case 'insertAIColumn':
                    checkAPIKeyAndOpenModal(openAIColumnModal, 'before', contextMenuColumn);
                    break;
                case 'suggestColumnWithAI':
                    checkAPIKeyAndOpenSuggestionsModal(contextMenuColumn);
                    break;
                case 'remove':
                    vscode.postMessage({
                        type: 'removeColumn',
                        columnPath: contextMenuColumn
                    });
                    break;
                case 'unstringify':
                    vscode.postMessage({
                        type: 'unstringifyColumn',
                        columnPath: contextMenuColumn
                    });
                    break;
            }

            hideContextMenu();
        }

        function showRowContextMenu(event, rowIndex) {
            event.preventDefault();
            contextMenuRow = rowIndex;

            const menu = document.getElementById('rowContextMenu');
            const pasteAboveMenuItem = document.getElementById('pasteAboveMenuItem');
            const pasteBelowMenuItem = document.getElementById('pasteBelowMenuItem');
            
            // Initially show paste options as disabled while validating
            pasteAboveMenuItem.style.display = 'block';
            pasteBelowMenuItem.style.display = 'block';
            pasteAboveMenuItem.classList.add('disabled');
            pasteBelowMenuItem.classList.add('disabled');
            
            // Request clipboard validation from backend
            vscode.postMessage({
                type: 'validateClipboard'
            });

            // Temporarily position menu off-screen to measure its dimensions
            menu.style.display = 'block';
            menu.style.visibility = 'hidden';
            menu.style.left = '-9999px';
            menu.style.top = '-9999px';
            
            // Get menu dimensions (now that it's displayed, even if hidden)
            const menuRect = menu.getBoundingClientRect();
            const menuWidth = menuRect.width || menu.offsetWidth;
            const menuHeight = menuRect.height || menu.offsetHeight;
            
            // Make menu visible again
            menu.style.visibility = 'visible';
            
            // Get viewport dimensions
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            // Calculate initial position (use clientX/clientY for viewport-relative coordinates)
            let left = event.clientX;
            let top = event.clientY;
            
            // Adjust horizontal position if menu goes beyond right edge
            if (left + menuWidth > viewportWidth) {
                left = viewportWidth - menuWidth - 10; // 10px margin from edge
            }
            
            // Adjust horizontal position if menu goes beyond left edge
            if (left < 0) {
                left = 10; // 10px margin from edge
            }
            
            // Adjust vertical position if menu goes beyond bottom edge
            if (top + menuHeight > viewportHeight) {
                top = viewportHeight - menuHeight - 10; // 10px margin from edge
            }
            
            // Adjust vertical position if menu goes beyond top edge
            if (top < 0) {
                top = 10; // 10px margin from edge
            }
            
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        function handleRowContextMenu(event) {
            const action = event.target.closest('.row-context-menu-item')?.dataset.action;
            if (!action || contextMenuRow === null) return;

            // Check if the clicked item is disabled
            const clickedItem = event.target.closest('.row-context-menu-item');
            if (clickedItem && clickedItem.classList.contains('disabled')) {
                return; // Don't execute action for disabled items
            }

            switch (action) {
                case 'copyRow':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'copyRow',
                            rowIndex: actualRowIndex
                        });
                    }
                    break;
                case 'insertAbove':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'insertRow',
                            rowIndex: actualRowIndex,
                            position: 'above'
                        });
                    }
                    break;
                case 'insertBelow':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'insertRow',
                            rowIndex: actualRowIndex,
                            position: 'below'
                        });
                    }
                    break;
                case 'duplicateRow':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'duplicateRow',
                            rowIndex: actualRowIndex
                        });
                    }
                    break;
                case 'insertAIRows':
                    checkAPIKeyAndOpenModal(openAIRowsModal, contextMenuRow);
                    break;
                case 'pasteAbove':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'pasteRow',
                            rowIndex: actualRowIndex,
                            position: 'above'
                        });
                    }
                    break;
                case 'pasteBelow':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        vscode.postMessage({
                            type: 'pasteRow',
                            rowIndex: actualRowIndex,
                            position: 'below'
                        });
                    }
                    break;
                case 'deleteRow':
                    {
                        const actualRowIndex = currentData.rowIndices && currentData.rowIndices[contextMenuRow] !== undefined
                            ? currentData.rowIndices[contextMenuRow]
                            : contextMenuRow;
                        // Send delete request directly - backend will handle confirmation if needed
                        vscode.postMessage({
                            type: 'deleteRow',
                            rowIndex: actualRowIndex
                        });
                    }
                    break;
            }

            hideContextMenu();
        }
        
        function updateTable(data) {
            // Validate data structure before processing
            if (!data || typeof data !== 'object') {
                console.error('updateTable: Invalid data received');
                return;
            }
            
            // Ensure required arrays exist
            if (!Array.isArray(data.rows)) {
                console.warn('updateTable: data.rows is not an array, initializing');
                data.rows = [];
            }
            if (!Array.isArray(data.columns)) {
                console.warn('updateTable: data.columns is not an array, initializing');
                data.columns = [];
            }
            if (!Array.isArray(data.rowIndices)) {
                console.warn('updateTable: data.rowIndices is not an array, initializing');
                data.rowIndices = data.rows.map((_, index) => index);
            }
            // The extension omits allRows when it would be identical to rows
            if (!Array.isArray(data.allRows)) {
                data.allRows = data.rows;
            }

            currentData = data;

            // Handle loading state in header
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');

            if (data.isIndexing) {
                // Initial loading - show animated logo and hide controls
                logo.style.display = 'none';
                const logoAnimation = document.getElementById('logoAnimation');
                if (logoAnimation) logoAnimation.style.display = 'block';
                loadingState.style.display = 'flex';
                document.getElementById('loadingLabel').textContent = 'Loading large file...';
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'none';
                return;
            }
            
            // Show loading progress if chunks are still loading
            updateLoadingBanner(data.loadingProgress);

            // Restore the last used view once, on the first update after load.
            // Later updates (cell edits, chunked loading) must not override in-session choices.
            if (data.uiPreferences && !uiPreferencesApplied) {
                const desiredView = data.uiPreferences.lastView || 'table';

                if (desiredView !== currentView) {
                    switchView(desiredView, false);
                }
            }

            // Update search inputs

            // Update error count
            updateErrorBadge(data.errorCount);

            // Keep the file stats popover current if the user has it open
            renderFileInfo();

            // If the extension guarantees rows were only appended since the last
            // update (end of background chunk loading), keep the existing DOM -
            // rebuilding and re-scrolling a deep table here is expensive and jarring
            if (data.appendCompatible &&
                lastRenderedColumnsKey === computeVisibleColumnsKey(data.columns) &&
                isIdentityRowMapping(data) &&
                data.rows.length >= tableRenderState.renderedRows) {
                tableRenderState.totalRows = data.rows.length;
                if (followMode && currentView === 'table') {
                    requestAnimationFrame(followScrollToBottom);
                }
            } else if (document.querySelector('#tableBody td.editing')) {
                // Rebuilding would destroy an in-progress cell edit - defer until
                // the edit ends; currentData is already fresh so the deferred
                // rebuild shows new data
                deferredUpdatePending = true;
            } else {
                rebuildTable();
            }

            // Restore wrap text once, now that the table header exists
            if (data.uiPreferences && !uiPreferencesApplied) {
                uiPreferencesApplied = true;

                const wrapCheckbox = document.getElementById('wrapTextCheckbox');
                const desiredWrap = !!data.uiPreferences.wrapText;

                if (wrapCheckbox && wrapCheckbox.checked !== desiredWrap) {
                    wrapCheckbox.checked = desiredWrap;
                    // The change handler applies wrap to whichever views exist
                    // and skips width-freezing while the table is hidden
                    wrapCheckbox.dispatchEvent(new Event('change'));
                }
            }

            // Reset JSON rendering state when data updates
            if (currentView === 'json') {
                renderJsonChunk(true);
                requestAnimationFrame(() => restoreScrollPosition('json'));
            } else {
                resetJsonRenderingState();
            }

            // Reset Raw rendering state when data updates
            if (currentView === 'raw') {
                renderRawChunk(true);
                requestAnimationFrame(() => restoreScrollPosition('raw'));
            } else {
                resetRawRenderingState();
            }

            attachScrollListener();

            if (currentView === 'table') {
                requestAnimationFrame(ensureTableViewportFilled);
            } else if (currentView === 'json') {
                requestAnimationFrame(ensureJsonViewportFilled);
            } else if (currentView === 'raw') {
                requestAnimationFrame(ensureRawViewportFilled);
            }
        }

        // Header loading banner shared by full updates and appendRows deltas
        function updateLoadingBanner(loadingProgress) {
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');
            const logoAnimation = document.getElementById('logoAnimation');
            const loadingProgressElement = document.getElementById('loadingProgress');

            if (loadingProgress && loadingProgress.loadingChunks) {
                logo.style.display = 'none';
                if (logoAnimation) logoAnimation.style.display = 'block';
                loadingState.style.display = 'flex';
                document.getElementById('loadingLabel').textContent = 'Loading large file...';

                const memoryInfo = loadingProgress.memoryOptimized ?
                    \`<div style="font-size: 11px; color: var(--vscode-warningForeground); margin-top: 5px;">
                        Memory optimized: Showing \${loadingProgress.displayedRows.toLocaleString()} of \${loadingProgress.loadedLines.toLocaleString()} loaded rows
                    </div>\` : '';

                loadingProgressElement.innerHTML = \`
                    <div>\${loadingProgress.loadedLines.toLocaleString()} / \${loadingProgress.totalLines.toLocaleString()} lines (\${loadingProgress.progressPercent}%)</div>
                    \${memoryInfo}
                \`;
            } else {
                // Loading complete - show controls and hide animated logo
                logo.style.display = 'block';
                if (logoAnimation) logoAnimation.style.display = 'none';
                loadingState.style.display = 'none';
            }

            // Don't show the indexing div since we have header loading state
            document.getElementById('indexingDiv').style.display = 'none';
            document.getElementById('dataTable').style.display = 'table';
        }

        function formatBytes(bytes) {
            if (!bytes || bytes < 0) return '';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let value = bytes;
            let unitIndex = 0;
            while (value >= 1024 && unitIndex < units.length - 1) {
                value /= 1024;
                unitIndex++;
            }
            const formatted = unitIndex === 0 ? value.toString() : value.toFixed(1);
            return formatted + ' ' + units[unitIndex];
        }

        // Fill the file stats popover from currentData. Only does work while the
        // popover is open, so data updates during chunk loading stay cheap
        function renderFileInfo() {
            const popover = document.getElementById('fileInfoPopover');
            if (!popover || popover.style.display === 'none') return;

            const data = currentData || {};
            const lp = data.loadingProgress || {};
            const rows = Array.isArray(data.rows) ? data.rows : [];
            // Count actual parsed records, not raw lines: a trailing newline or
            // blank lines inflate loadingProgress.totalLines, so use the loaded
            // row count (blank/empty lines are skipped during parsing).
            const allRows = Array.isArray(data.allRows) ? data.allRows : rows;
            const columns = Array.isArray(data.columns) ? data.columns.filter(column => column.visible).length : 0;

            // A filtered view shows a subset, so report both counts
            const records = rows.length !== allRows.length
                ? rows.length.toLocaleString() + ' of ' + allRows.length.toLocaleString()
                : allRows.length.toLocaleString();
            // Background chunks are still being parsed, so the counts are partial
            const partial = data.isIndexing || (lp && lp.loadingChunks);

            const entries = [
                ['Records', records + (partial ? ' (loading…)' : '')],
                ['Columns', columns.toLocaleString()],
                ['Size', formatBytes(lp.fileSizeBytes || 0) || '—']
            ];

            popover.textContent = '';
            entries.forEach(entry => {
                const row = document.createElement('div');
                row.className = 'file-info-row';
                const label = document.createElement('span');
                label.className = 'file-info-label';
                label.textContent = entry[0];
                const value = document.createElement('span');
                value.textContent = entry[1];
                row.appendChild(label);
                row.appendChild(value);
                popover.appendChild(row);
            });
        }

        // Hang the popover under its button, clamped to the viewport: the
        // toolbar wraps at narrow widths, so the button can sit close enough
        // to an edge that a fixed anchor would push the panel off screen
        function positionFileInfo() {
            const popover = document.getElementById('fileInfoPopover');
            const button = document.getElementById('fileInfoBtn');
            if (!popover || !button) return;

            const margin = 8;
            const rect = button.getBoundingClientRect();
            const width = popover.offsetWidth;
            const rightmost = Math.max(margin, document.documentElement.clientWidth - width - margin);

            popover.style.left = Math.max(margin, Math.min(rect.right - width, rightmost)) + 'px';
            popover.style.top = (rect.bottom + 6) + 'px';
        }

        // Open/close the file stats popover; pass true to force it closed
        function toggleFileInfo(forceClose) {
            const popover = document.getElementById('fileInfoPopover');
            const button = document.getElementById('fileInfoBtn');
            if (!popover || !button) return;

            const open = forceClose === true ? false : popover.style.display === 'none';
            popover.style.display = open ? 'block' : 'none';
            button.classList.toggle('toggled', open);
            if (open) {
                renderFileInfo();
                positionFileInfo();
            }
        }

        function updateErrorBadge(errorCount) {
            const errorCountElement = document.getElementById('errorCount');
            if (errorCount > 0) {
                errorCountElement.textContent = errorCount;
                errorCountElement.style.display = 'flex';
                // Default to raw view if there are errors, but not while following a
                // live-appended file (a mid-write partial last line parses as an error)
                if (currentView === 'table' && !followMode) {
                    switchView('raw', false);
                }
            } else {
                errorCountElement.style.display = 'none';
            }
        }

        // Signature of what the table header (and every row's cells) is built from
        function computeVisibleColumnsKey(columns) {
            if (!Array.isArray(columns)) return '';
            return columns
                .filter(column => column.visible)
                .map(column => column.path + (column.isExpanded ? '*' : ''))
                .join('|');
        }

        // True when rows are unfiltered (rowIndices is the identity mapping)
        function isIdentityRowMapping(data) {
            const indices = data.rowIndices;
            if (!Array.isArray(indices) || indices.length !== data.rows.length) return false;
            if (indices.length === 0) return true;
            return indices[0] === 0 && indices[indices.length - 1] === indices.length - 1;
        }

        function buildTableHeader(data) {
            const thead = document.getElementById('tableHead');
            const colgroup = document.getElementById('tableColgroup');
            if (!thead) return;

            thead.innerHTML = '';
            if (colgroup) colgroup.innerHTML = '';
            
            const headerRow = document.createElement('tr');

            const hiddenColumns = getUnhideableColumns(data.columns);
            // The row-number column needs room for the hidden-columns badge
            const rowNumWidth = hiddenColumns.length > 0 ? '72px' : '40px';

            // Add col for row number column
            if (colgroup) {
                const col = document.createElement('col');
                col.style.width = rowNumWidth;
                colgroup.appendChild(col);
            }

            // Add row number header
            const rowNumHeader = document.createElement('th');
            rowNumHeader.textContent = '#';
            rowNumHeader.style.minWidth = rowNumWidth;
            rowNumHeader.style.textAlign = 'center';
            rowNumHeader.classList.add('row-header');
            rowNumHeader.title = 'Right-click to unhide columns';
            // Entry point for unhiding columns that still works when every column is hidden
            rowNumHeader.addEventListener('contextmenu', (e) => showContextMenu(e, null));

            // Hidden columns are otherwise invisible - the only hint they exist is
            // a gap in the header. Surface a count here, and make it the shortcut
            // to the same unhide menu the right-click opens.
            if (hiddenColumns.length > 0) {
                const hiddenBadge = document.createElement('button');
                hiddenBadge.className = 'hidden-columns-badge';
                hiddenBadge.title = hiddenColumns.length === 1
                    ? '1 hidden column - click to unhide'
                    : hiddenColumns.length + ' hidden columns - click to unhide';
                hiddenBadge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
                const count = document.createElement('span');
                count.textContent = String(hiddenColumns.length);
                hiddenBadge.appendChild(count);
                hiddenBadge.addEventListener('click', openUnhideColumnsMenu);
                rowNumHeader.appendChild(hiddenBadge);
            }

            headerRow.appendChild(rowNumHeader);

            // Data columns
            data.columns.forEach(column => {
                if (!column.visible) {
                    return;
                }

                // Add col element for this column
                if (colgroup) {
                    const col = document.createElement('col');
                    col.dataset.columnPath = column.path;
                    colgroup.appendChild(col);
                }

                const th = document.createElement('th');
                const headerContent = document.createElement('span');
                headerContent.style.display = 'inline-block';
                headerContent.style.whiteSpace = 'nowrap';
                headerContent.style.overflow = 'hidden';
                headerContent.style.textOverflow = 'ellipsis';
                headerContent.style.maxWidth = '100%';

                if (column.parentPath) {
                    const collapseButton = document.createElement('button');
                    collapseButton.className = 'collapse-button';
                    collapseButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,18 9,12 15,6"></polyline></svg>';
                    collapseButton.title = 'Collapse to ' + column.parentPath;
                    collapseButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'collapseColumn',
                            columnPath: column.parentPath
                        });
                    });
                    headerContent.appendChild(collapseButton);
                    headerContent.appendChild(document.createTextNode(column.displayName));

                    const value = getSampleValue(data.rows, column.path);
                    if (typeof value === 'object' && value !== null && !column.isExpanded) {
                        const expandButton = document.createElement('button');
                        expandButton.className = 'expand-button';
                        expandButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"></polyline></svg>';
                        expandButton.title = 'Expand';
                        expandButton.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            vscode.postMessage({
                                type: 'expandColumn',
                                columnPath: column.path
                            });
                        });
                        headerContent.appendChild(expandButton);
                    }

                    th.classList.add('subcolumn-header');
                } else {
                    headerContent.appendChild(document.createTextNode(column.displayName));

                    const value = getSampleValue(data.rows, column.path);
                    if (typeof value === 'object' && value !== null) {
                        const button = document.createElement('button');
                        button.className = 'expand-button';
                        button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"></polyline></svg>';
                        button.title = 'Expand';
                        button.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            vscode.postMessage({
                                type: 'expandColumn',
                                columnPath: column.path
                            });
                        });
                        headerContent.appendChild(button);
                    }
                }

                th.appendChild(headerContent);

                // Mark the column the view is currently sorted by. Sits outside
                // headerContent so a long column name can't ellipsize it away.
                const displaySort = data.displaySort;
                if (displaySort && displaySort.columnPath === column.path) {
                    const indicator = document.createElement('span');
                    indicator.className = 'sort-indicator';
                    indicator.textContent = displaySort.direction === 'desc' ? '▼' : '▲';
                    indicator.title = 'Display sorted ' + (displaySort.direction === 'desc' ? 'descending' : 'ascending');
                    th.appendChild(indicator);
                }

                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                resizeHandle.addEventListener('mousedown', (e) => startResize(e, th, column.path));
                th.appendChild(resizeHandle);

                th.addEventListener('contextmenu', (e) => showContextMenu(e, column.path));
                
                // Add drag and drop for column reordering
                th.draggable = true;
                th.dataset.columnPath = column.path;
                th.title = 'Drag to reorder • Right-click for options';
                th.addEventListener('dragstart', handleHeaderDragStart);
                th.addEventListener('dragend', handleHeaderDragEnd);
                th.addEventListener('dragover', handleHeaderDragOver);
                th.addEventListener('drop', handleHeaderDrop);
                
                headerRow.appendChild(th);
            });

            thead.appendChild(headerRow);
            lastRenderedColumnsKey = computeVisibleColumnsKey(data.columns);

            // Restore saved column widths after rebuilding table
            if (colgroup && Object.keys(savedColumnWidths).length > 0) {
                const cols = colgroup.querySelectorAll('col');
                cols.forEach(col => {
                    const columnPath = col.dataset.columnPath;
                    if (columnPath && savedColumnWidths[columnPath]) {
                        col.style.width = savedColumnWidths[columnPath];
                    }
                });
                
                // Restore table layout if widths were saved
                const table = document.getElementById('dataTable');
                if (table) {
                    table.style.tableLayout = 'fixed';
                }
            }
        }
        
        // Table header drag and drop
        let draggedHeader = null;
        let draggedHeaderIndex = null;
        
        function handleHeaderDragStart(e) {
            const th = e.target.closest('th');
            if (!th || th.classList.contains('row-header')) return;
            
            draggedHeader = th;
            th.classList.add('dragging-header');
            e.dataTransfer.effectAllowed = 'move';
            
            // Find the index of this column (excluding row header)
            const headers = Array.from(th.parentNode.children).filter(el => !el.classList.contains('row-header'));
            draggedHeaderIndex = headers.indexOf(th);
        }
        
        function handleHeaderDragEnd(e) {
            const th = e.target.closest('th');
            if (th) {
                th.classList.remove('dragging-header');
            }
            document.querySelectorAll('th').forEach(header => {
                header.classList.remove('drag-over-header');
            });
            draggedHeader = null;
            draggedHeaderIndex = null;
        }
        
        function handleHeaderDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const th = e.target.closest('th');
            if (th && !th.classList.contains('row-header') && th !== draggedHeader) {
                document.querySelectorAll('th').forEach(header => {
                    header.classList.remove('drag-over-header');
                });
                th.classList.add('drag-over-header');
            }
        }
        
        function handleHeaderDrop(e) {
            e.preventDefault();
            
            const targetTh = e.target.closest('th');
            if (!targetTh || targetTh.classList.contains('row-header') || targetTh === draggedHeader) {
                return;
            }
            
            // Find the index of target column (excluding row header)
            const headers = Array.from(targetTh.parentNode.children).filter(el => !el.classList.contains('row-header'));
            const targetIndex = headers.indexOf(targetTh);
            
            if (draggedHeaderIndex !== null && draggedHeaderIndex !== targetIndex) {
                vscode.postMessage({
                    type: 'reorderColumns',
                    fromIndex: draggedHeaderIndex,
                    toIndex: targetIndex
                });
            }
            
            targetTh.classList.remove('drag-over-header');
        }

        // Table row drag and drop for reordering
        let draggedRow = null;

        function handleRowDragStart(e) {
            const tr = e.target.closest('tr');
            if (!tr) return;
            draggedRow = tr;
            tr.classList.add('dragging-row');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tr.dataset.actualIndex || '');
        }

        function handleRowDragEnd(e) {
            const tr = e.target.closest('tr');
            if (tr) tr.classList.remove('dragging-row');
            document.querySelectorAll('#tableBody tr.drag-over-row').forEach(row => row.classList.remove('drag-over-row'));
            draggedRow = null;
        }

        function handleRowDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const tr = e.target.closest('tr');
            if (tr && tr !== draggedRow) {
                document.querySelectorAll('#tableBody tr.drag-over-row').forEach(row => row.classList.remove('drag-over-row'));
                tr.classList.add('drag-over-row');
            }
        }

        function handleRowDrop(e) {
            e.preventDefault();
            if (currentData.displaySort) return; // Visual order != file order
            const targetTr = e.target.closest('tr');
            if (!targetTr || targetTr === draggedRow) return;
            const fromIndex = parseInt(draggedRow.dataset.actualIndex, 10);
            const toIndex = parseInt(targetTr.dataset.actualIndex, 10);
            if (fromIndex === toIndex) return;
            targetTr.classList.remove('drag-over-row');
            vscode.postMessage({
                type: 'reorderRows',
                fromIndex: fromIndex,
                toIndex: toIndex
            });
        }

        function createTableRow(row, rowIndex) {
            const tr = document.createElement('tr');

            // Get the actual index from the pre-computed mapping
            // rowIndex here is the filtered index (0-based position in currentData.rows)
            const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                ? currentData.rowIndices[rowIndex]
                : rowIndex; // Fallback to filtered index if mapping is unavailable

            // Store the filtered row index on the row element for Find/Replace
            tr.dataset.index = rowIndex.toString();
            tr.dataset.actualIndex = actualRowIndex.toString();

            // Re-apply selection after re-renders (the tbody is rebuilt on every update)
            if (selectedRowActualIndex !== null && actualRowIndex === selectedRowActualIndex) {
                tr.classList.add('selected');
                selectedRowElement = tr;
            }

            // Click to select the row so it stays visible while scrolling horizontally
            tr.addEventListener('click', () => selectRow(actualRowIndex));

            // Add row number cell
            const rowNumCell = document.createElement('td');
            // Display sequential number (1, 2, 3...) for visual ordering
            rowNumCell.textContent = (rowIndex + 1).toString();
            rowNumCell.classList.add('row-header');
            // Tooltip shows the actual row number in the file and drag hint
            rowNumCell.title = 'Row ' + (actualRowIndex + 1) + ' in file • Drag to reorder';
            rowNumCell.addEventListener('contextmenu', (e) => showRowContextMenu(e, rowIndex));
            tr.appendChild(rowNumCell);

            // Row drag and drop for reordering. Disabled while the view is
            // display-sorted: dropping a row would move it to the target's
            // position in the file, which is not where it appears on screen.
            tr.draggable = !currentData.displaySort;
            tr.addEventListener('dragstart', handleRowDragStart);
            tr.addEventListener('dragend', handleRowDragEnd);
            tr.addEventListener('dragover', handleRowDragOver);
            tr.addEventListener('drop', handleRowDrop);

            // Data cells
            currentData.columns.forEach(column => {
                if (!column.visible) {
                    return;
                }

                const td = document.createElement('td');
                const value = getNestedValue(row, column.path);
                const valueStr = value !== undefined ? JSON.stringify(value) : '';

                // Store column path and raw value on the cell element for Find/Replace
                td.dataset.columnPath = column.path;
                // Store the JSON stringified value for accurate find/replace (handles objects properly)
                td.dataset.rawValue = valueStr;

                if (column.isExpanded) {
                    td.classList.add('expanded-column');
                }

                // Re-apply the cell cursor: the tbody is rebuilt on every update
                if (cursorActualRowIndex !== null &&
                    actualRowIndex === cursorActualRowIndex &&
                    column.path === cursorColumnPath) {
                    td.classList.add('cell-cursor');
                    cursorCellElement = td;
                }

                // Clicking a cell puts the keyboard cursor on it. Registered
                // first so expandable cells, whose own handler stops the event,
                // still move the cursor.
                td.addEventListener('click', () => setCellCursor(actualRowIndex, column.path, false));

                if (typeof value === 'object' && value !== null && !column.isExpanded) {
                    td.classList.add('expandable-cell');
                    td.textContent = valueStr;
                    td.title = valueStr;
                    td.addEventListener('click', (e) => expandCell(e, td, actualRowIndex, column.path));
                    td.addEventListener('dblclick', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'expandColumn',
                            columnPath: column.path
                        });
                    });
                } else {
                    td.textContent = valueStr;
                    td.title = valueStr;
                    td.addEventListener('dblclick', (e) => editCell(e, td, actualRowIndex, column.path));
                }

                tr.appendChild(td);
            });

            return tr;
        }

        function renderTableChunk(reset = false) {
            const tbody = document.getElementById('tableBody');
            if (!tbody) return;

            if (reset) {
                tableRenderState.totalRows = currentData.rows ? currentData.rows.length : 0;
                tableRenderState.renderedRows = 0;
                tableRenderState.isRendering = false;
                tbody.innerHTML = '';
            }

            if (tableRenderState.isRendering) return;
            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;
            if (!currentData.rows || currentData.rows.length === 0) return;

            tableRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = tableRenderState.renderedRows;
            const end = Math.min(start + TABLE_CHUNK_SIZE, currentData.rows.length);

            for (let rowIndex = start; rowIndex < end; rowIndex++) {
                const row = currentData.rows[rowIndex];
                if (row) { // Ensure row exists before creating table row
                    fragment.appendChild(createTableRow(row, rowIndex));
                }
            }

            tbody.appendChild(fragment);
            tableRenderState.renderedRows = end;
            tableRenderState.isRendering = false;

            if (currentView === 'table') {
                requestAnimationFrame(ensureTableViewportFilled);
            }
        }

        function ensureTableViewportFilled() {
            if (currentView !== 'table') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderTableChunk();
            }
        }

        function ensureTableScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderTableChunk();
                requestAnimationFrame(() => ensureTableScrollCapacity(targetScroll));
            }
        }

        // Rebuild header + body from currentData, preserving the table's scroll
        // position (background chunk loading used to reset the view to the top)
        function rebuildTable() {
            const tableContainer = document.getElementById('tableContainer');
            const prevScroll = (currentView === 'table' && !followMode && tableContainer)
                ? tableContainer.scrollTop
                : 0;
            buildTableHeader(currentData);
            renderTableChunk(true);
            if (followMode) {
                requestAnimationFrame(followScrollToBottom);
            } else if (prevScroll > 0) {
                restoreTableScroll(prevScroll);
            }
            checkSortJump();
        }

        // Render enough chunks to make the saved scroll offset reachable, then
        // restore it. Runs synchronously in one batch: per-frame loops from
        // successive updates used to overlap and thrash the tbody
        function restoreTableScroll(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (tableRenderState.renderedRows > 0 && tableRenderState.renderedRows < tableRenderState.totalRows) {
                // Estimate the rows needed from the average row height so the
                // batch doesn't re-measure layout after every chunk
                const rowHeight = Math.max(1, tableContainer.scrollHeight / tableRenderState.renderedRows);
                const rowsNeeded = Math.min(tableRenderState.totalRows,
                    Math.ceil((targetScroll + tableContainer.clientHeight) / rowHeight) + TABLE_CHUNK_SIZE);
                while (tableRenderState.renderedRows < rowsNeeded) {
                    renderTableChunk();
                }
            }
            // Top up in case variable row heights made the estimate fall short
            while (tableRenderState.renderedRows < tableRenderState.totalRows &&
                   tableContainer.scrollHeight - tableContainer.clientHeight < targetScroll) {
                renderTableChunk();
            }
            tableContainer.scrollTop = targetScroll;
        }

        // Editing the sorted column can move the row out from under the user.
        // Remember where it was so the next rebuild can tell them where it went.
        function watchSortJump(actualRowIndex, columnPath) {
            const displaySort = currentData.displaySort;
            // Only the sorted column can change a row's position: the sort is
            // stable, so edits to any other column leave the order alone
            if (!displaySort || displaySort.columnPath !== columnPath) return;

            const previousPosition = (currentData.rowIndices || []).indexOf(actualRowIndex);
            if (previousPosition === -1) return;

            pendingSortJumpWatch = {
                actualRowIndex: actualRowIndex,
                previousPosition: previousPosition,
                // The sort this position was measured under. If it changes before
                // the update lands, the row moved because of the re-sort, not the
                // edit, and the notice would be misleading.
                columnPath: displaySort.columnPath,
                direction: displaySort.direction
            };
        }

        // Runs after a rebuild: if the watched row landed somewhere else, offer a
        // non-modal way to follow it rather than silently moving it
        function checkSortJump() {
            const watch = pendingSortJumpWatch;
            if (!watch) return;
            pendingSortJumpWatch = null;

            // Only report movement caused by the edit itself: if the sort was
            // cleared or changed in the meantime, any movement is down to that
            const displaySort = currentData.displaySort;
            if (!displaySort ||
                displaySort.columnPath !== watch.columnPath ||
                displaySort.direction !== watch.direction) {
                return;
            }

            const newPosition = (currentData.rowIndices || []).indexOf(watch.actualRowIndex);
            if (newPosition === -1 || newPosition === watch.previousPosition) return;

            const notice = document.getElementById('sortJumpNotice');
            const text = document.getElementById('sortJumpNoticeText');
            if (!notice || !text) return;

            // The # column shows the display position, so name both that and the
            // file line - otherwise "row 1 moved to row 1" reads as nonsense
            text.textContent = 'Edited row (file line ' + (watch.actualRowIndex + 1) + ') moved from #' +
                (watch.previousPosition + 1) + ' to #' + (newPosition + 1) + ' in the sorted view.';
            // Track the row, not the position: another update may reorder the
            // view again before the user clicks, so resolve the position then
            notice.dataset.targetRow = String(watch.actualRowIndex);
            notice.style.display = 'flex';

            if (sortJumpNoticeTimeout) clearTimeout(sortJumpNoticeTimeout);
            sortJumpNoticeTimeout = setTimeout(hideSortJumpNotice, 12000);
        }

        function hideSortJumpNotice() {
            const notice = document.getElementById('sortJumpNotice');
            if (notice) notice.style.display = 'none';
            if (sortJumpNoticeTimeout) {
                clearTimeout(sortJumpNoticeTimeout);
                sortJumpNoticeTimeout = null;
            }
        }

        // Scroll a row of the current (possibly sorted) view into view and flash it
        function jumpToDisplayRow(position) {
            if (currentView !== 'table') {
                switchView('table', false);
            }

            const tbody = document.getElementById('tableBody');
            if (!tbody || position < 0) return;

            // The table body renders lazily in chunks - render up to the target
            ensureRowRendered(position);

            const tr = tbody.children[position];
            if (!tr) return;

            tr.scrollIntoView({ block: 'center' });

            selectRow(parseInt(tr.dataset.actualIndex, 10));

            // Restart the flash even if the row still carries the class
            tr.classList.remove('row-flash');
            void tr.offsetWidth;
            tr.classList.add('row-flash');
        }

        // --- shared:grid-navigation (keep in sync with src/jsonl/gridNavigation.ts) ---
        function moveGridCursor(cursor, move, rowCount, columnCount, pageSize) {
            if (!(rowCount > 0) || !(columnCount > 0)) {
                return null;
            }

            const lastRow = rowCount - 1;
            const lastColumn = columnCount - 1;
            const page = pageSize && pageSize > 0 ? Math.floor(pageSize) : 1;

            if (!cursor) {
                return { row: 0, column: 0 };
            }

            // Rows can be filtered away and columns hidden between two keystrokes, so a
            // stored cursor is clamped back into the grid before it is moved
            let row = clampGridIndex(cursor.row, lastRow);
            let column = clampGridIndex(cursor.column, lastColumn);

            switch (move) {
                case 'up':
                    row = Math.max(0, row - 1);
                    break;
                case 'down':
                    row = Math.min(lastRow, row + 1);
                    break;
                case 'left':
                    column = Math.max(0, column - 1);
                    break;
                case 'right':
                    column = Math.min(lastColumn, column + 1);
                    break;
                case 'rowStart':
                    column = 0;
                    break;
                case 'rowEnd':
                    column = lastColumn;
                    break;
                case 'pageUp':
                    row = Math.max(0, row - page);
                    break;
                case 'pageDown':
                    row = Math.min(lastRow, row + page);
                    break;
                case 'next':
                    if (column < lastColumn) {
                        column = column + 1;
                    } else if (row < lastRow) {
                        row = row + 1;
                        column = 0;
                    }
                    break;
                case 'previous':
                    if (column > 0) {
                        column = column - 1;
                    } else if (row > 0) {
                        row = row - 1;
                        column = lastColumn;
                    }
                    break;
                default:
                    break;
            }

            return { row: row, column: column };
        }

        function clampGridIndex(value, max) {
            if (typeof value !== 'number' || !isFinite(value)) {
                return 0;
            }
            return Math.min(Math.max(0, Math.floor(value)), max);
        }
        // --- end shared:grid-navigation ---

        function getVisibleColumns() {
            return (currentData.columns || []).filter(col => col.visible);
        }

        // The cell cursor in display coordinates, or null when it is not on
        // screen - its row may be filtered out or its column hidden
        function getCursorPosition() {
            if (cursorActualRowIndex === null || cursorColumnPath === null) return null;
            const row = (currentData.rowIndices || []).indexOf(cursorActualRowIndex);
            if (row === -1) return null;
            const column = getVisibleColumns().findIndex(col => col.path === cursorColumnPath);
            if (column === -1) return null;
            return { row: row, column: column };
        }

        // The row element for a file row index, or null when that row is
        // filtered out or has not been rendered yet (rendering is chunked)
        function getRenderedRow(actualRowIndex) {
            const position = (currentData.rowIndices || []).indexOf(actualRowIndex);
            if (position === -1) return null;
            const tbody = document.getElementById('tableBody');
            if (!tbody || !tbody.children) return null;
            return tbody.children[position] || null;
        }

        // The <td> the cursor sits on, or null when it is off screen
        function getCursorCell() {
            const position = getCursorPosition();
            if (!position) return null;
            const tr = getRenderedRow(cursorActualRowIndex);
            if (!tr || !tr.children) return null;
            // Offset by one: the row-number cell comes before the data cells
            return tr.children[position.column + 1] || null;
        }

        // Highlight the row the way a click does, keyboard or mouse driven.
        // Like the cell cursor, the highlighted row is remembered rather than
        // searched for, so this stays cheap on a fully rendered large file.
        function selectRow(actualRowIndex) {
            selectedRowActualIndex = actualRowIndex;
            if (selectedRowElement && selectedRowElement.classList) {
                selectedRowElement.classList.remove('selected');
            }
            selectedRowElement = getRenderedRow(actualRowIndex);
            if (selectedRowElement && selectedRowElement.classList) {
                selectedRowElement.classList.add('selected');
            }
        }

        function clearRowSelection() {
            selectedRowActualIndex = null;
            if (selectedRowElement && selectedRowElement.classList) {
                selectedRowElement.classList.remove('selected');
            }
            selectedRowElement = null;
        }

        // Repaint the cursor on the live DOM. The class is also applied during
        // render (see createTableRow), which is what carries it across rebuilds.
        // The previously highlighted cell is remembered rather than searched
        // for: with a large file the rendered table runs to thousands of cells,
        // and this runs on every keystroke.
        function applyCursorHighlight(scrollIntoView) {
            if (cursorCellElement && cursorCellElement.classList) {
                cursorCellElement.classList.remove('cell-cursor');
            }
            cursorCellElement = getCursorCell();
            if (!cursorCellElement) return;
            cursorCellElement.classList.add('cell-cursor');
            if (scrollIntoView) {
                scrollCellIntoView(cursorCellElement);
            }
        }

        // Scroll the cursor cell just far enough to be fully visible. Done by
        // hand rather than with scrollIntoView because the header row and the
        // row-number column are sticky: they float over the top and left of the
        // scroll area, and scrollIntoView happily parks the cursor underneath
        function scrollCellIntoView(td) {
            const container = document.getElementById('tableContainer');
            if (!container || !container.getBoundingClientRect || !td.getBoundingClientRect) return;

            const cell = td.getBoundingClientRect();
            const view = container.getBoundingClientRect();

            const header = document.getElementById('tableHead');
            const headerHeight = header && header.getBoundingClientRect
                ? header.getBoundingClientRect().height
                : 0;
            const tr = td.closest ? td.closest('tr') : null;
            const rowNumberCell = tr && tr.children ? tr.children[0] : null;
            const rowNumberWidth = rowNumberCell && rowNumberCell.getBoundingClientRect
                ? rowNumberCell.getBoundingClientRect().width
                : 0;

            const top = view.top + headerHeight;
            const left = view.left + rowNumberWidth;

            if (cell.top < top) {
                container.scrollTop -= top - cell.top;
            } else if (cell.bottom > view.bottom) {
                container.scrollTop += cell.bottom - view.bottom;
            }

            if (cell.left < left) {
                container.scrollLeft -= left - cell.left;
            } else if (cell.right > view.right) {
                container.scrollLeft += cell.right - view.right;
            }
        }

        function setCellCursor(actualRowIndex, columnPath, scrollIntoView) {
            if (actualRowIndex === undefined || actualRowIndex === null || !columnPath) return;
            cursorActualRowIndex = actualRowIndex;
            cursorColumnPath = columnPath;
            // The cursor's row is the selected row: one highlight, one story
            selectRow(actualRowIndex);
            applyCursorHighlight(scrollIntoView);
        }

        function clearCellCursor() {
            cursorActualRowIndex = null;
            cursorColumnPath = null;
            applyCursorHighlight(false);
        }

        // Display coordinates -> stored cursor
        function setCursorPosition(position, scrollIntoView) {
            if (!position) return;
            const actualRowIndex = (currentData.rowIndices || [])[position.row];
            const column = getVisibleColumns()[position.column];
            if (actualRowIndex === undefined || !column) return;
            setCellCursor(actualRowIndex, column.path, scrollIntoView);
        }

        // Render enough chunks for a display position to have a row element
        function ensureRowRendered(position) {
            let guard = 0;
            while (tableRenderState.renderedRows <= position &&
                   tableRenderState.renderedRows < tableRenderState.totalRows &&
                   guard++ < 10000) {
                renderTableChunk();
            }
        }

        // How far Page Up/Down jumps: one screenful of rows, less one for overlap
        function getTablePageSize() {
            const container = document.getElementById('tableContainer');
            const tbody = document.getElementById('tableBody');
            const firstRow = tbody && tbody.children ? tbody.children[0] : null;
            const height = container && container.clientHeight ? container.clientHeight : 0;
            const rowHeight = firstRow && firstRow.getBoundingClientRect
                ? firstRow.getBoundingClientRect().height
                : 0;
            if (!height || !rowHeight) return DEFAULT_PAGE_ROWS;
            return Math.max(1, Math.floor(height / rowHeight) - 1);
        }

        // Move the cell cursor one step and keep it on screen
        function moveCellCursor(move) {
            if (currentView !== 'table') return null;
            const rowCount = (currentData.rows || []).length;
            const columnCount = getVisibleColumns().length;
            if (rowCount === 0 || columnCount === 0) return null;

            const current = getCursorPosition();
            let next;
            if (current) {
                next = moveGridCursor(current, move, rowCount, columnCount, getTablePageSize());
            } else {
                // Entering the grid: land on the selected row if there is one,
                // else the first cell - the first keystroke doesn't also move
                const selectedRow = selectedRowActualIndex !== null
                    ? (currentData.rowIndices || []).indexOf(selectedRowActualIndex)
                    : -1;
                next = { row: selectedRow === -1 ? 0 : selectedRow, column: 0 };
            }
            if (!next) return null;

            ensureRowRendered(next.row);
            setCursorPosition(next, true);
            return next;
        }

        // Enter/F2 on the cursor cell. Objects and arrays have no inline editor,
        // so there the equivalent action is the one double-click does: expand
        function editCursorCell() {
            const td = getCursorCell();
            if (!td || !td.classList || td.classList.contains('editing')) return;
            if (td.classList.contains('expandable-cell')) {
                vscode.postMessage({ type: 'expandColumn', columnPath: cursorColumnPath });
                return;
            }
            editCell(null, td, cursorActualRowIndex, cursorColumnPath);
        }

        // Grid keys are ignored while another surface owns the keystroke: another
        // view, a cell editor, a modal, an open context menu, or a text field
        function isGridNavigationActive() {
            if (currentView !== 'table') return false;
            if (document.querySelector('td.editing')) return false;
            if (document.querySelector('.column-manager-modal.show')) return false;
            const columnMenu = document.getElementById('contextMenu');
            const rowMenu = document.getElementById('rowContextMenu');
            if ((columnMenu && columnMenu.style.display === 'block') ||
                (rowMenu && rowMenu.style.display === 'block')) {
                return false;
            }
            const active = document.activeElement;
            if (active && active !== document.body) {
                const tag = (active.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
                if (active.isContentEditable) return false;
            }
            return true;
        }

        // Enter presses whatever has focus, so a focused button or link keeps it.
        // Arrow keys are safe to take either way - they activate nothing.
        function isActivationKeyOwnedByFocus() {
            const active = document.activeElement;
            if (!active || active === document.body) return false;
            const tag = (active.tagName || '').toLowerCase();
            return tag === 'button' || tag === 'a';
        }

        // Apply an update that was deferred because a cell edit was in progress
        function flushDeferredUpdate() {
            if (!deferredUpdatePending) return;
            deferredUpdatePending = false;
            rebuildTable();
        }

        // Merge an appendRows delta (background chunk loading) into currentData.
        // Already-rendered rows and the scroll position are left untouched; lazy
        // chunk rendering picks the new rows up as the user scrolls
        function appendRows(data) {
            if (!data || !Array.isArray(data.rows)) return;

            // Out of sync with the extension (e.g. a message was dropped while
            // the webview was hidden) - recover with a full update
            if (!Array.isArray(currentData.rows) || !Array.isArray(currentData.rowIndices) ||
                data.baseRowCount !== currentData.rows.length) {
                vscode.postMessage({ type: 'requestFullUpdate' });
                return;
            }

            const base = currentData.rows.length;
            for (let i = 0; i < data.rows.length; i++) {
                currentData.rows.push(data.rows[i]);
                currentData.rowIndices.push(base + i);
            }
            if (Array.isArray(currentData.allRows) && currentData.allRows !== currentData.rows) {
                for (let i = 0; i < data.rows.length; i++) {
                    currentData.allRows.push(data.rows[i]);
                }
            }
            if (Array.isArray(data.parsedLines)) {
                if (!Array.isArray(currentData.parsedLines)) {
                    currentData.parsedLines = [];
                }
                for (let i = 0; i < data.parsedLines.length; i++) {
                    currentData.parsedLines.push(data.parsedLines[i]);
                }
            }

            currentData.loadingProgress = data.loadingProgress;
            updateLoadingBanner(data.loadingProgress);
            if (typeof data.errorCount === 'number') {
                currentData.errorCount = data.errorCount;
                updateErrorBadge(data.errorCount);
            }

            tableRenderState.totalRows = currentData.rows.length;
            jsonRenderState.totalRows = currentData.rows.length;
            rawRenderState.totalLines = currentData.parsedLines ? currentData.parsedLines.length : 0;

            if (Array.isArray(data.columns)) {
                currentData.columns = data.columns;
                // A new column crossed the auto-detect threshold - existing rows
                // are missing its cells, so this (rare) case needs a full rebuild
                if (computeVisibleColumnsKey(data.columns) !== lastRenderedColumnsKey) {
                    if (document.querySelector('#tableBody td.editing')) {
                        deferredUpdatePending = true;
                    } else {
                        rebuildTable();
                    }
                }
            }

            // Deltas are the only update during chunk loading, so the stats
            // would otherwise sit at the initial chunk's counts until it ends
            renderFileInfo();

            if (currentView === 'table') {
                if (followMode) {
                    requestAnimationFrame(followScrollToBottom);
                } else {
                    requestAnimationFrame(ensureTableViewportFilled);
                }
            } else if (currentView === 'json') {
                requestAnimationFrame(ensureJsonViewportFilled);
            } else if (currentView === 'raw') {
                requestAnimationFrame(ensureRawViewportFilled);
            }
        }

        function followScrollToBottom() {
            if (!followMode || currentView !== 'table') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            // Chunked rendering grows scrollHeight lazily, so render all
            // remaining chunks before pinning the scroll to the bottom
            if (tableRenderState.renderedRows < tableRenderState.totalRows) {
                renderTableChunk();
                requestAnimationFrame(followScrollToBottom);
            } else {
                tableContainer.scrollTop = tableContainer.scrollHeight;
            }
        }

        function resetJsonRenderingState() {
            jsonRenderState.totalRows = currentData.rows.length;
            jsonRenderState.renderedRows = 0;
            jsonRenderState.isRendering = false;

            if (currentView !== 'json') {
                const jsonView = document.getElementById('jsonView');
                if (jsonView) {
                    jsonView.innerHTML = '';
                }
            }
        }

        function renderJsonChunk(reset = false) {
            const jsonView = document.getElementById('jsonView');
            if (!jsonView) return;

            if (reset) {
                jsonRenderState.totalRows = currentData.rows.length;
                jsonRenderState.renderedRows = 0;
                jsonRenderState.isRendering = false;
                jsonView.innerHTML = '';
            }

            if (jsonRenderState.isRendering) return;
            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            jsonRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = jsonRenderState.renderedRows;
            const end = Math.min(start + JSON_CHUNK_SIZE, currentData.rows.length);

            for (let index = start; index < end; index++) {
                const row = currentData.rows[index];
                const lineDiv = document.createElement('div');
                lineDiv.className = 'json-line';

                const lineNumber = document.createElement('div');
                lineNumber.className = 'line-number';
                lineNumber.textContent = (index + 1).toString().padStart(4, ' ');

                const jsonContent = document.createElement('textarea');
                jsonContent.className = 'json-content-editable';
                const jsonString = JSON.stringify(row, null, 2);
                jsonContent.value = jsonString;
                jsonContent.setAttribute('data-row-index', index);

                function autoResize(textarea) {
                    textarea.style.height = 'auto';
                    textarea.style.height = textarea.scrollHeight + 'px';
                }

                setTimeout(() => {
                    autoResize(jsonContent);
                }, 10);

                setTimeout(() => {
                    if (jsonContent.scrollHeight > jsonContent.offsetHeight) {
                        jsonContent.style.height = jsonContent.scrollHeight + 'px';
                    }
                }, 100);

                jsonContent.addEventListener('input', function() {
                    autoResize(this);
                    try {
                        const parsed = JSON.parse(this.value);
                        this.classList.remove('json-error');
                        this.classList.add('json-valid');
                    } catch (e) {
                        this.classList.remove('json-valid');
                        this.classList.add('json-error');
                    }
                });

                jsonContent.addEventListener('blur', function() {
                    const rowIndex = parseInt(this.getAttribute('data-row-index'));
                    try {
                        const parsed = JSON.parse(this.value);
                        currentData.rows[rowIndex] = parsed;

                        vscode.postMessage({
                            type: 'documentChanged',
                            rowIndex: rowIndex,
                            newData: parsed
                        });

                        this.classList.remove('json-error');
                        this.classList.add('json-valid');
                    } catch (e) {
                        console.error('Invalid JSON on line', rowIndex + 1, ':', e.message);
                    }
                });

                lineDiv.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                lineDiv.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                lineNumber.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                lineNumber.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                jsonContent.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                // Add cursor-based navigation for JSON textareas
                jsonContent.addEventListener('keydown', function(e) {
                    // Only handle arrow keys when not in the middle of editing
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        const cursorPosition = this.selectionStart;
                        const textLength = this.value.length;
                        
                        // Check if cursor is at the beginning (for Up arrow) or end (for Down arrow)
                        const isAtBeginning = cursorPosition === 0;
                        const isAtEnd = cursorPosition === textLength;
                        
                        if ((e.key === 'ArrowUp' && isAtBeginning) || (e.key === 'ArrowDown' && isAtEnd)) {
                            e.preventDefault();
                            
                            const currentRowIndex = parseInt(this.getAttribute('data-row-index'));

                            const jsonView = document.getElementById('jsonView');

                            let targetRowIndex;
                            if (e.key === 'ArrowUp') {
                                // Go to previous row
                                targetRowIndex = Math.max(0, currentRowIndex - 1);
                            } else {
                                // Go to next row
                                targetRowIndex = Math.min(currentData.rows.length - 1, currentRowIndex + 1);
                            }

                            // Find the target textarea by its data-row-index attribute
                            const targetTextarea = jsonView.querySelector('.json-content-editable[data-row-index="' + targetRowIndex + '"]');

                            if (targetTextarea) {
                                
                                // Try multiple focus methods to ensure it works
                                setTimeout(() => {
                                    // Method 1: Standard focus
                                    targetTextarea.focus();
                                    
                                    // Method 2: Force focus with click simulation
                                    targetTextarea.click();
                                    
                                    // Method 3: Set focus with explicit tabIndex
                                    targetTextarea.tabIndex = 0;
                                    targetTextarea.focus();
                                    
                                    // Position cursor at the beginning for Up arrow, end for Down arrow
                                    if (e.key === 'ArrowUp') {
                                        targetTextarea.setSelectionRange(targetTextarea.value.length, targetTextarea.value.length);
                                    } else {
                                        targetTextarea.setSelectionRange(0, 0);
                                    }

                                    // Simple scroll to make sure target is visible
                                    targetTextarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                }, 10);
                            } else {
                                // Target row not rendered yet, ensure it's rendered and try again
                                const jsonView = document.getElementById('jsonView');
                                
                                // Force render more chunks to ensure target row is available
                                while (jsonRenderState.renderedRows <= targetRowIndex && jsonRenderState.renderedRows < jsonRenderState.totalRows) {
                                    renderJsonChunk();
                                }

                                // Use requestAnimationFrame for better timing with DOM updates
                                requestAnimationFrame(() => {
                                    const updatedTargetTextarea = jsonView.querySelector('.json-content-editable[data-row-index="' + targetRowIndex + '"]');

                                    if (updatedTargetTextarea) {
                                        // Focus the textarea
                                        updatedTargetTextarea.focus();
                                        
                                        // Position cursor at the beginning for Up arrow, end for Down arrow
                                        if (e.key === 'ArrowUp') {
                                            updatedTargetTextarea.setSelectionRange(updatedTargetTextarea.value.length, updatedTargetTextarea.value.length);
                                        } else {
                                            updatedTargetTextarea.setSelectionRange(0, 0);
                                        }
                                        
                                        // Only scroll if the target is not visible in the viewport
                                        const targetRect = updatedTargetTextarea.parentElement.getBoundingClientRect();
                                        const jsonViewRect = jsonView.getBoundingClientRect();
                                        
                                        if (targetRect.top < jsonViewRect.top || targetRect.bottom > jsonViewRect.bottom) {
                                            // Target is not visible, scroll it into view gently
                                            updatedTargetTextarea.parentElement.scrollIntoView({
                                                behavior: 'smooth',
                                                block: 'nearest',
                                                inline: 'nearest'
                                            });
                                        }
                                    }
                                });
                            }
                        }
                    }
                });

                jsonContent.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                // Add context menu support for Pretty Print view
                lineDiv.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showRowContextMenu(e, index);
                });

                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(jsonContent);
                fragment.appendChild(lineDiv);
            }

            jsonView.appendChild(fragment);
            jsonRenderState.renderedRows = end;
            jsonRenderState.isRendering = false;

            if (currentView === 'json') {
                requestAnimationFrame(ensureJsonViewportFilled);
            }
        }

        function ensureJsonViewportFilled() {
            if (currentView !== 'json') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderJsonChunk();
            }
        }

        function ensureJsonScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderJsonChunk();
                requestAnimationFrame(() => ensureJsonScrollCapacity(targetScroll));
            }
        }

        function resetRawRenderingState() {
            rawRenderState.totalLines = currentData.parsedLines ? currentData.parsedLines.length : 0;
            rawRenderState.renderedLines = 0;
            rawRenderState.isRendering = false;

            if (currentView !== 'raw') {
                const rawContent = document.getElementById('rawContent');
                if (rawContent) {
                    rawContent.innerHTML = '';
                }
            }
        }

        function renderRawChunk(reset = false) {
            const rawContent = document.getElementById('rawContent');
            if (!rawContent) return;

            if (reset) {
                rawRenderState.totalLines = currentData.parsedLines ? currentData.parsedLines.length : 0;
                rawRenderState.renderedLines = 0;
                rawRenderState.isRendering = false;
                rawContent.innerHTML = '';
            }

            if (rawRenderState.isRendering) return;
            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            rawRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = rawRenderState.renderedLines;
            const end = Math.min(start + RAW_CHUNK_SIZE, rawRenderState.totalLines);

            for (let index = start; index < end; index++) {
                const line = currentData.parsedLines[index];
                const lineDiv = document.createElement('div');
                lineDiv.className = 'raw-line';
                
                if (line.error) {
                    lineDiv.classList.add('error');
                }

                const lineNumber = document.createElement('div');
                lineNumber.className = 'raw-line-number';
                lineNumber.textContent = line.lineNumber.toString().padStart(4, ' ');

                const lineContent = document.createElement('div');
                lineContent.className = 'raw-line-content';
                lineContent.textContent = line.rawLine || '';

                // Add context menu support for Raw view
                lineDiv.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showRowContextMenu(e, index);
                });

                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(lineContent);
                fragment.appendChild(lineDiv);
            }

            rawContent.appendChild(fragment);
            rawRenderState.renderedLines = end;
            rawRenderState.isRendering = false;

            if (currentView === 'raw') {
                requestAnimationFrame(ensureRawViewportFilled);
            }
        }

        function ensureRawViewportFilled() {
            if (currentView !== 'raw') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderRawChunk();
            }
        }

        function ensureRawScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderRawChunk();
                requestAnimationFrame(() => ensureRawScrollCapacity(targetScroll));
            }
        }

        function attachScrollListener() {
            if (containerScrollListenerAttached) return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            tableContainer.addEventListener('scroll', handleContainerScroll);
            containerScrollListenerAttached = true;
        }

        function handleContainerScroll() {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            scrollPositions[currentView] = tableContainer.scrollTop;

            // Don't trigger re-render during navigation

            const nearBottom = tableContainer.scrollTop + tableContainer.clientHeight >= tableContainer.scrollHeight - 200;
            if (!nearBottom) return;

            if (currentView === 'table') {
                renderTableChunk();
            } else if (currentView === 'json') {
                renderJsonChunk();
            } else if (currentView === 'raw') {
                renderRawChunk();
            }
        }

        function restoreScrollPosition(viewType) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            const targetScroll = scrollPositions[viewType] || 0;
            tableContainer.scrollTop = targetScroll;

            if (viewType === 'table') {
                ensureTableScrollCapacity(targetScroll);
            } else if (viewType === 'json') {
                ensureJsonScrollCapacity(targetScroll);
            } else if (viewType === 'raw') {
                ensureRawScrollCapacity(targetScroll);
            }
        }

        function getNestedValue(obj, path) {
            if (!obj || !path) return undefined;
            
            // Handle null/undefined object
            if (obj === null || obj === undefined) {
                return undefined;
            }
            
            // Handle special case for primitive values with "(value)" path
            if (path === '(value)' && (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean' || obj === null || Array.isArray(obj))) {
                return obj;
            }
            
            const parts = path.split('.');
            let current = obj;
            
            for (const part of parts) {
                if (current === null || current === undefined) {
                    break;
                }
                
                if (part.includes('[') && part.includes(']')) {
                    const [key, indexStr] = part.split('[');
                    const index = parseInt(indexStr.replace(']', ''));
                    if (isNaN(index)) return undefined;
                    current = current[key];
                    if (Array.isArray(current)) {
                        current = current[index];
                    } else {
                        return undefined;
                    }
                } else {
                    current = current[part];
                }
                
                if (current === undefined || current === null) break;
            }
            
            return current;
        }
        
        function getSampleValue(rows, columnPath) {
            for (const row of rows) {
                const value = getNestedValue(row, columnPath);
                if (value !== undefined && value !== null) {
                    return value;
                }
            }
            return null;
        }
        
        // The event argument is null when the edit was started from the keyboard
        // rather than by double-clicking the cell
        function editCell(event, td, rowIndex, columnPath) {
            // Prevent any default behavior
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }

            // However the edit started, that cell is now the cursor, so Enter
            // and Tab afterwards move on from here
            setCellCursor(rowIndex, columnPath, false);

            const originalValue = td.textContent;
            
            // Create input element
            const input = document.createElement('input');
            input.value = originalValue;
            input.style.width = '100%';
            input.style.height = '100%';
            input.style.border = 'none';
            input.style.outline = 'none';
            input.style.backgroundColor = 'var(--vscode-input-background)';
            input.style.color = 'var(--vscode-input-foreground)';
            input.style.padding = '6px 8px';
            input.style.fontSize = 'inherit';
            input.style.fontFamily = 'inherit';
            input.style.boxSizing = 'border-box';
            
            // Replace cell content with input
            td.innerHTML = '';
            td.appendChild(input);
            td.classList.add('editing');
            
            // Focus and select text
            input.focus();
            input.select();
            
            // Save and cancel both detach the input; the guard keeps a trailing
            // blur from re-running an edit that a key already finished
            let editFinished = false;

            // Handle save on blur or enter
            function saveEdit() {
                if (editFinished) return;
                editFinished = true;
                const newValue = input.value;
                td.classList.remove('editing');
                td.textContent = newValue;
                td.title = newValue;
                // Keep the raw value in sync so Find/Replace sees the edit immediately
                td.dataset.rawValue = newValue;

                // A sorted view may reorder around this edit - track where it goes
                watchSortJump(rowIndex, columnPath);

                // Send update message
                vscode.postMessage({
                    type: 'updateCell',
                    rowIndex: rowIndex,
                    columnPath: columnPath,
                    value: newValue
                });

                flushDeferredUpdate();
            }
            
            // Handle cancel on escape
            function cancelEdit() {
                if (editFinished) return;
                editFinished = true;
                td.classList.remove('editing');
                td.textContent = originalValue;
                td.title = originalValue;

                flushDeferredUpdate();
            }

            input.addEventListener('blur', saveEdit);
            input.addEventListener('keydown', (e) => {
                // Spreadsheet convention: Enter commits and steps down a row,
                // Tab commits and steps to the next cell, Escape reverts.
                // Each stops propagating: the edit ends the moment the key is
                // handled, so the grid's own document-level handler would
                // otherwise see the same keystroke and act on it a second time.
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveEdit();
                    moveCellCursor(e.shiftKey ? 'up' : 'down');
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveEdit();
                    moveCellCursor(e.shiftKey ? 'previous' : 'next');
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelEdit();
                    applyCursorHighlight(true);
                }
            });
        }
        
        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    updateTable(message.data);
                    break;
                case 'appendRows':
                    appendRows(message.data);
                    break;
                case 'clipboardValidationResult':
                    const pasteAboveMenuItem = document.getElementById('pasteAboveMenuItem');
                    const pasteBelowMenuItem = document.getElementById('pasteBelowMenuItem');
                    if (message.isValidJson) {
                        pasteAboveMenuItem.classList.remove('disabled');
                        pasteBelowMenuItem.classList.remove('disabled');
                    } else {
                        pasteAboveMenuItem.classList.add('disabled');
                        pasteBelowMenuItem.classList.add('disabled');
                    }
                    break;
                case 'settingsLoaded': {
                    const warningElement = document.getElementById('apiKeyWarning');
                    const loaded = message.settings || {};

                    if (loaded.provider && AI_PROVIDER_META[loaded.provider]) {
                        settingsState.provider = loaded.provider;
                    }
                    Object.keys(AI_PROVIDER_META).forEach(function(p) {
                        if (loaded.keys && typeof loaded.keys[p] === 'string') {
                            settingsState.keys[p] = loaded.keys[p];
                            settingsState.loadedKeys[p] = loaded.keys[p];
                        }
                        if (loaded.models && loaded.models[p]) {
                            settingsState.models[p] = loaded.models[p];
                        }
                        if (loaded.availableModels && Array.isArray(loaded.availableModels[p]) && loaded.availableModels[p].length > 0) {
                            settingsState.availableModels[p] = loaded.availableModels[p];
                        }
                    });
                    if (typeof loaded.localBaseUrl === 'string' && loaded.localBaseUrl) {
                        settingsState.localBaseUrl = loaded.localBaseUrl;
                    }
                    renderSettingsForm();

                    // Update warning visibility based on whether the active provider is usable
                    if (warningElement) {
                        const activeProviderMeta = AI_PROVIDER_META[settingsState.provider] || AI_PROVIDER_META.openai;
                        const hasAPIKey = !!activeProviderMeta.keyOptional || (settingsState.keys[settingsState.provider] || '').trim().length > 0;
                        warningElement.style.display = hasAPIKey ? 'none' : 'block';
                    }
                    break;
                }
                case 'modelsLoaded': {
                    const statusElement = document.getElementById('modelFetchStatus');
                    if (message.error) {
                        if (statusElement) {
                            statusElement.textContent = 'Could not fetch models: ' + message.error;
                        }
                    } else if (Array.isArray(message.models) && message.models.length > 0 && AI_PROVIDER_META[message.provider]) {
                        settingsState.availableModels[message.provider] = message.models;
                        if (message.provider === settingsState.provider) {
                            stashSettingsInputs();
                            renderModelOptions();
                            if (statusElement) {
                                statusElement.textContent = message.models.length + ' models loaded from ' + AI_PROVIDER_META[message.provider].label + '.';
                            }
                        }
                    }
                    break;
                }
                case 'recentEnumValuesLoaded':
                    recentEnumValues = message.recentValues || [];
                    break;
                case 'openSettings':
                    openSettingsModal();
                    break;
                case 'columnSuggestions':
                    handleAISuggestions(message.suggestions, message.error);
                    break;
            }
        });
        
        // Fallback: if no message is received within 5 seconds, show error
        setTimeout(() => {
            if (currentData.isIndexing) {
                updateTable({
                    rows: [],
                    columns: [],
                    isIndexing: false,
                    searchTerm: '',
                    useRegex: false,
                    parsedLines: [{
                        data: null,
                        lineNumber: 1,
                        rawLine: '',
                        error: 'Extension failed to load data. Please try reloading the file.'
                    }],
                    rawContent: '',
                    errorCount: 1,
                    loadingProgress: {
                        loadedLines: 0,
                        totalLines: 0,
                        loadingChunks: false,
                        progressPercent: 100,
                        memoryOptimized: false,
                        displayedRows: 0
                    }
                });
            }
        }, 5000);
        
        // View control functions
        // persistPreference is false for programmatic switches (preference restore,
        // error fallback) so they don't overwrite the user's saved choice
        function switchView(viewType, persistPreference = true) {
            // Don't switch if already on the same view
            if (currentView === viewType) {
                return;
            }
            
            // Hide any open context menus when switching views
            hideContextMenu();
            
            // Hide Find/Replace bar when switching views (only shown in table view)
            if (currentView === 'table' && viewType !== 'table') {
                closeFindReplaceBar();
            }
            
            // Flush pending edits when switching away from pretty print view (without saving).
            // Only if the user actually edited, so merely visiting the view never dirties the document.
            if (currentView === 'json' && viewType !== 'json' && prettyEditor && prettyEditorModified) {
                clearTimeout(window.prettyEditTimeout);
                vscode.postMessage({
                    type: 'prettyContentChanged',
                    newContent: prettyEditor.getValue()
                });
            }

            // Update data model when switching away from raw view (without saving),
            // only if the user actually edited
            if (currentView === 'raw' && viewType !== 'raw' && rawEditor && rawEditorModified) {
                clearTimeout(window.rawEditTimeout);
                vscode.postMessage({
                    type: 'rawContentChanged',
                    newContent: rawEditor.getValue()
                });
            }
            
            // Save current scroll position
            const tableContainer = document.getElementById('tableContainer');
            if (tableContainer) {
                scrollPositions[currentView] = tableContainer.scrollTop;
            }
            
            currentView = viewType;

            // Persist view preference globally
            if (persistPreference) {
                vscode.postMessage({
                    type: 'setViewPreference',
                    viewType: viewType
                });
            }
            
            // Show animated gazelle during view switch
            const logo = document.getElementById('logo');
            const logoAnimation = document.getElementById('logoAnimation');
            const loadingState = document.getElementById('loadingState');
            logo.style.display = 'none';
            if (logoAnimation) logoAnimation.style.display = 'block';
            loadingState.style.display = 'flex';
            document.getElementById('loadingLabel').textContent = 'Switching view...';
            document.getElementById('loadingProgress').innerHTML = '';
            
            // Hide search container during view switch
            
            // Update segmented control
            document.querySelectorAll('.segmented-control button').forEach(button => {
                button.classList.toggle('active', button.dataset.view === viewType);
            });
            
            // Hide all view containers
            document.getElementById('tableViewContainer').style.display = 'none';
            document.getElementById('jsonViewContainer').style.display = 'none';
            document.getElementById('rawViewContainer').style.display = 'none';

            // The stats popover would hover over the incoming view
            toggleFileInfo(true);
            
            // Show/hide the controls that only apply to the table view
            const columnManagerBtn = document.getElementById('columnManagerBtn');
            const findReplaceBtn = document.getElementById('findReplaceBtn');
            const settingsBtn = document.getElementById('settingsBtn');
            const followBtn = document.getElementById('followBtn');
            // Follow mode auto-scrolls the table view only; refresh works everywhere
            followBtn.style.display = viewType === 'table' ? 'flex' : 'none';

            // Show selected view container
            switch (viewType) {
                case 'table':
                    document.getElementById('tableViewContainer').style.display = 'block';
                    document.getElementById('dataTable').style.display = 'table';
                    // Show column controls for table view
                    columnManagerBtn.style.display = 'flex';
                    findReplaceBtn.style.display = 'flex';
                    settingsBtn.style.display = 'flex';
                    // Hide loading state immediately for table view (already rendered)
                    logo.style.display = 'block';
                    const logoAnimation = document.getElementById('logoAnimation');
                    if (logoAnimation) logoAnimation.style.display = 'none';
                    loadingState.style.display = 'none';
                    // Re-render table to apply any active search filters
                    renderTableChunk(true);
                    break;
                case 'json':
                    document.getElementById('jsonViewContainer').style.display = 'block';
                    document.getElementById('jsonViewContainer').classList.add('isolated');
                    // Hide column controls for json view
                    columnManagerBtn.style.display = 'none';
                    settingsBtn.style.display = 'none';
                    // Show find button (triggers Monaco's find widget)
                    findReplaceBtn.style.display = 'flex';

                    // Add event isolation to prevent bubbling
                    const jsonContainer = document.getElementById('jsonViewContainer');
                    jsonContainer.addEventListener('dblclick', function(e) {
                        e.stopPropagation();
                    });
                    jsonContainer.addEventListener('click', function(e) {
                        e.stopPropagation();
                    });

                    // Use setTimeout to allow the loading animation to show before rendering
                    // Longer delay for larger datasets to ensure smooth animation
                    const jsonDelay = currentData.rows.length > 1000 ? 100 : 50;
                    setTimeout(() => {
                        updatePrettyView();
                        // Hide loading state after pretty view is rendered
                        logo.style.display = 'block';
                        const logoAnimation = document.getElementById('logoAnimation');
                        if (logoAnimation) logoAnimation.style.display = 'none';
                        loadingState.style.display = 'none';
                    }, jsonDelay);
                    break;
                case 'raw':
                    document.getElementById('rawViewContainer').style.display = 'block';
                    // Hide column controls for raw view
                    columnManagerBtn.style.display = 'none';
                    settingsBtn.style.display = 'none';
                    // Show find button (triggers Monaco's find widget)
                    findReplaceBtn.style.display = 'flex';
                    // Use setTimeout to allow the loading animation to show before rendering
                    // Longer delay for larger datasets to ensure smooth animation
                    const rawDelay = currentData.rawContent && currentData.rawContent.length > 100000 ? 100 : 50;
                    setTimeout(() => {
                        updateRawView();
                        // Hide loading state after raw view is rendered
                        logo.style.display = 'block';
                        const logoAnimation = document.getElementById('logoAnimation');
                        if (logoAnimation) logoAnimation.style.display = 'none';
                        loadingState.style.display = 'none';

                        // Automatically open file in VS Code editor
                        vscode.postMessage({
                            type: 'openInEditor'
                        });
                    }, rawDelay);
                    break;
            }
            
            // Restore scroll position
            setTimeout(() => {
                restoreScrollPosition(viewType);
            }, 0);
        }
        
        let prettyEditor = null;

        function getMonacoTheme() {
            const body = document.body;

            if (body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast')) {
                return 'vs-dark';
            }

            return 'vs';
        }

        // Shared options so the Pretty Print and Raw editors look identical
        // (and match the table view's monospace font)
        function getSharedEditorOptions() {
            // Monaco can't resolve CSS variables (it measures text on a canvas),
            // so read the concrete editor font from the webview's CSS variables
            const editorFontFamily = getComputedStyle(document.body)
                .getPropertyValue('--vscode-editor-font-family').trim() ||
                'Menlo, Monaco, "Courier New", monospace';

            return {
                theme: getMonacoTheme(),
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                wordWrap: document.getElementById('wrapTextCheckbox').checked ? 'on' : 'off',
                folding: true,
                fontSize: 12,
                fontFamily: editorFontFamily,
                padding: { top: 8, bottom: 8 },
                lineNumbersMinChars: 3
            };
        }

        function updatePrettyView() {
            const editorContainer = document.getElementById('prettyEditor');
            if (!editorContainer) return;

            // Initialize Monaco Editor for Pretty Print
            require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
            require(['vs/editor/editor.main'], function () {
                if (prettyEditor) {
                    prettyEditor.dispose();
                }

                // Use pre-formatted pretty content from Extension Host
                const prettyContent = currentData.prettyContent || '';
                const lineMapping = currentData.prettyLineMapping || [];

                prettyEditor = monaco.editor.create(editorContainer, Object.assign(getSharedEditorOptions(), {
                    value: prettyContent,
                    language: 'json',
                    lineNumbers: lineMapping.length > 0 ? (lineNumber) => {
                        // Use custom line numbers based on mapping
                        if (lineNumber <= lineMapping.length) {
                            const mappedNumber = lineMapping[lineNumber - 1];
                            // If mappedNumber is 0, don't show line number (empty string)
                            return mappedNumber === 0 ? '' : mappedNumber.toString();
                        }
                        return lineNumber.toString();
                    } : 'on'
                }));

                // Disable JSON validation for JSONL files
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                    validate: false,
                    allowComments: true,
                    schemas: []
                });

                // Additionally disable validation for current model
                const model = prettyEditor.getModel();
                if (model) {
                    monaco.editor.setModelMarkers(model, 'json', []);
                }

                // Editor was recreated with fresh content; no user edits yet
                prettyEditorModified = false;

                // Add change listener with debounce
                prettyEditor.onDidChangeModelContent(() => {
                    prettyEditorModified = true;
                    clearTimeout(window.prettyEditTimeout);
                    window.prettyEditTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'prettyContentChanged',
                            newContent: prettyEditor.getValue()
                        });
                    }, 500);
                });

                // Handle Ctrl+S
                prettyEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                    vscode.postMessage({
                        type: 'prettyContentSave',
                        newContent: prettyEditor.getValue()
                    });
                });

                const navigatePrettyEntry = (direction) => {
                    if (!prettyEditor || !Array.isArray(lineMapping) || lineMapping.length === 0) {
                        return;
                    }

                    const currentPosition = prettyEditor.getPosition();
                    if (!currentPosition) {
                        return;
                    }

                    let targetLine = currentPosition.lineNumber;

                    if (direction > 0) {
                        for (let line = currentPosition.lineNumber + 1; line <= lineMapping.length; line++) {
                            if (lineMapping[line - 1] > 0) {
                                targetLine = line;
                                break;
                            }
                        }
                    } else {
                        for (let line = currentPosition.lineNumber - 1; line >= 1; line--) {
                            if (lineMapping[line - 1] > 0) {
                                targetLine = line;
                                break;
                            }
                        }
                    }

                    if (targetLine === currentPosition.lineNumber) {
                        return;
                    }

                    const model = prettyEditor.getModel();
                    const targetColumn = model ? model.getLineFirstNonWhitespaceColumn(targetLine) : 1;

                    prettyEditor.setPosition({
                        lineNumber: targetLine,
                        column: targetColumn > 0 ? targetColumn : 1
                    });
                    prettyEditor.revealLineInCenterIfOutsideViewport(targetLine);
                    prettyEditor.focus();
                };

                // Navigate between JSONL entries in Pretty Print view
                // Ctrl/Cmd+Alt+Up/Down is chosen to avoid conflicts with common line-editing shortcuts.
                prettyEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
                    navigatePrettyEntry(-1);
                });

                prettyEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => {
                    navigatePrettyEntry(1);
                });
            });
        }

        let rawEditor = null;
        
        function updateRawView() {
            const editorContainer = document.getElementById('rawEditor');
            if (!editorContainer) return;
            
            // Initialize Monaco Editor
            require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
            require(['vs/editor/editor.main'], function () {
                if (rawEditor) {
                    rawEditor.dispose();
                }
                
                rawEditor = monaco.editor.create(editorContainer, Object.assign(getSharedEditorOptions(), {
                    value: currentData.rawContent || '',
                    language: 'json',
                    lineNumbers: 'on'
                }));
                
                // Disable JSON validation for JSONL files
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                    validate: false,
                    allowComments: true,
                    schemas: []
                });
                
                // Additionally disable validation for current model
                const model = rawEditor.getModel();
                if (model) {
                    monaco.editor.setModelMarkers(model, 'json', []);
                }
                
                // Editor was recreated with fresh content; no user edits yet
                rawEditorModified = false;

                // Handle content changes
                rawEditor.onDidChangeModelContent(() => {
                    rawEditorModified = true;
                    clearTimeout(window.rawEditTimeout);
                    window.rawEditTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'rawContentChanged',
                            newContent: rawEditor.getValue()
                        });
                    }, 500);
                });
                
                // Handle Ctrl+S
                rawEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                    vscode.postMessage({
                        type: 'rawContentSave',
                        newContent: rawEditor.getValue()
                    });
                });

                const navigateRawLine = (direction) => {
                    if (!rawEditor) {
                        return;
                    }

                    const currentPosition = rawEditor.getPosition();
                    const model = rawEditor.getModel();
                    if (!currentPosition || !model) {
                        return;
                    }

                    const lineCount = model.getLineCount();
                    if (lineCount <= 1) {
                        return;
                    }

                    const targetLine = Math.min(
                        lineCount,
                        Math.max(1, currentPosition.lineNumber + direction)
                    );

                    if (targetLine === currentPosition.lineNumber) {
                        return;
                    }

                    const targetMaxColumn = model.getLineMaxColumn(targetLine);
                    rawEditor.setPosition({
                        lineNumber: targetLine,
                        column: Math.min(currentPosition.column, targetMaxColumn)
                    });
                    rawEditor.revealLineInCenterIfOutsideViewport(targetLine);
                    rawEditor.focus();
                };

                // Navigate line-to-line in Raw view without triggering Monaco's line move command.
                rawEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
                    navigateRawLine(-1);
                });

                rawEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => {
                    navigateRawLine(1);
                });
            });
        }
        
        
        function expandCell(event, td, rowIndex, columnPath) {
            event.preventDefault();
            event.stopPropagation();

            const value = getNestedValue(currentData.allRows[rowIndex], columnPath);
            if (typeof value !== 'object' || value === null) return;
            
            // Create expanded content
            const expandedContent = document.createElement('div');
            expandedContent.className = 'expanded-content';
            
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    const div = document.createElement('div');
                    const strong = document.createElement('strong');
                    strong.textContent = index + ':';
                    div.appendChild(strong);
                    div.appendChild(document.createTextNode(' ' + JSON.stringify(item)));
                    expandedContent.appendChild(div);
                });
            } else {
                Object.entries(value).forEach(([key, val]) => {
                    const div = document.createElement('div');
                    const strong = document.createElement('strong');
                    strong.textContent = key + ':';
                    div.appendChild(strong);
                    div.appendChild(document.createTextNode(' ' + JSON.stringify(val)));
                    expandedContent.appendChild(div);
                });
            }
            
            // Position and show
            td.appendChild(expandedContent);
            
            // Hide on click outside
            setTimeout(() => {
                document.addEventListener('click', function hideExpanded() {
                    expandedContent.remove();
                    document.removeEventListener('click', hideExpanded);
                });
            }, 0);
        }
        
        // Add event listeners for view controls
        document.querySelectorAll('.segmented-control button').forEach(button => {
            button.addEventListener('click', (e) => switchView(e.currentTarget.dataset.view));
        });
        
        // "Row moved" notice: follow the row, or dismiss the notice
        document.getElementById('sortJumpGoBtn').addEventListener('click', () => {
            const actualRowIndex = parseInt(document.getElementById('sortJumpNotice').dataset.targetRow, 10);
            hideSortJumpNotice();
            if (isNaN(actualRowIndex)) return;

            const position = (currentData.rowIndices || []).indexOf(actualRowIndex);
            if (position !== -1) {
                jumpToDisplayRow(position);
            }
        });
        document.getElementById('sortJumpCloseBtn').addEventListener('click', hideSortJumpNotice);

        // Add event listeners for context menus
        document.getElementById('contextMenu').addEventListener('click', handleContextMenu);
        document.getElementById('rowContextMenu').addEventListener('click', handleRowContextMenu);
        document.getElementById('unhideColumnsMenuItem').addEventListener('mouseenter', positionUnhideColumnsSubmenu);
        document.getElementById('sortMenuItem').addEventListener('mouseenter', positionSortSubmenu);
        
        // Hide context menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu') && !e.target.closest('.row-context-menu')) {
                hideContextMenu();
            }
            // The button's own handler toggles, so ignore clicks inside the control
            if (!e.target.closest('.file-info-control')) {
                toggleFileInfo(true);
            }
        });
        
`;
