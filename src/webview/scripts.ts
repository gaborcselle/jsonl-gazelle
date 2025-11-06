/**
 * Webview JavaScript code
 */

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
            errorCount: 0
        };
        
        let contextMenuColumn = null;
        let contextMenuRow = null;
        let currentView = 'table';
        let isResizing = false;
        let resizeData = null;
        let isNavigating = false; // Flag to prevent re-render during navigation
        let scrollPositions = {
            table: 0,
            json: 0,
            raw: 0
        };
        let savedColumnWidths = {}; // Store column widths by column path
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

            // Escape: Close Find/Replace bar or Column Manager modal
            if (e.key === 'Escape') {
                if (document.getElementById('findReplaceBar').style.display === 'block') {
                    closeFindReplaceBar();
                } else if (document.getElementById('columnManagerModal').classList.contains('show')) {
                    closeColumnManager();
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

        // Event listeners
        document.getElementById('logo').addEventListener('click', () => {
            vscode.postMessage({
                type: 'openUrl',
                url: 'https://github.com/gaborcselle/jsonl-gazelle'
            });
        });

        // Find/Replace Button
        document.getElementById('findReplaceBtn').addEventListener('click', openFindReplaceBar);

        // Column Manager Modal
        document.getElementById('columnManagerBtn').addEventListener('click', openColumnManager);
        document.getElementById('modalCloseBtn').addEventListener('click', closeColumnManager);
        document.getElementById('columnManagerModal').addEventListener('click', (e) => {
            if (e.target.id === 'columnManagerModal') {
                closeColumnManager();
            }
        });
        
        // Wrap Text Toggle
        document.getElementById('wrapTextCheckbox').addEventListener('change', (e) => {
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            const thead = table.querySelector('thead tr');
            
            if (e.target.checked) {
                // Freeze current column widths before applying wrap
                if (colgroup && thead) {
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
                }
                
                // Apply fixed layout to prevent recalculation
                table.style.tableLayout = 'fixed';
                
                // Add wrap class
                table.classList.add('text-wrap');
            } else {
                // Remove wrap but KEEP widths and fixed layout
                table.classList.remove('text-wrap');
                // Note: We intentionally do NOT remove table-layout or col widths
                // so the column sizes remain stable
            }
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
            
            dropdown.innerHTML = valuesToShow.map(value => 
                \`<div class="enum-history-item">\${value}</div>\`
            ).join('');
            
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
            const openaiKey = document.getElementById('openaiKey').value;
            const openaiModel = document.getElementById('openaiModel').value;

            // Store callback and args before they're cleared
            const callback = pendingModalCallback;
            const args = pendingModalArgs;

            vscode.postMessage({
                type: 'saveSettings',
                settings: {
                    openaiKey: openaiKey,
                    openaiModel: openaiModel
                },
                // Include callback info if available
                openOriginalModal: !!callback
            });

            closeSettingsModal();

            // If there was a pending modal callback and key was provided, wait for confirmation
            if (callback && openaiKey && openaiKey.trim()) {
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
        
        
        
        
        
        
        function showContextMenu(event, columnPath) {
            event.preventDefault();
            contextMenuColumn = columnPath;
            
            const menu = document.getElementById('contextMenu');
            const unstringifyMenuItem = document.getElementById('unstringifyMenuItem');
            
            // Check if this column contains stringified JSON
            const hasStringifiedJson = checkColumnForStringifiedJson(columnPath);
            unstringifyMenuItem.style.display = hasStringifiedJson ? 'block' : 'none';
            
            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
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
        
        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
            document.getElementById('rowContextMenu').style.display = 'none';
            contextMenuColumn = null;
            contextMenuRow = null;
        }
        
        function handleContextMenu(event) {
            const action = event.target.closest('.context-menu-item')?.dataset.action;
            if (!action || !contextMenuColumn) return;

            switch (action) {
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
            
            currentData = data;
            
            // Handle loading state in header
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');
            const loadingProgress = document.getElementById('loadingProgress');
            
            if (data.isIndexing) {
                // Initial loading - show animated logo and hide controls
                logo.style.display = 'none';
                const logoAnimation = document.getElementById('logoAnimation');
                if (logoAnimation) logoAnimation.style.display = 'block';
                loadingState.style.display = 'flex';
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'none';
                return;
            }
            
            // Show loading progress if chunks are still loading
            if (data.loadingProgress && data.loadingProgress.loadingChunks) {
                logo.style.display = 'none';
                const logoAnimation = document.getElementById('logoAnimation');
                if (logoAnimation) logoAnimation.style.display = 'block';
                loadingState.style.display = 'flex';
                
                const memoryInfo = data.loadingProgress.memoryOptimized ? 
                    \`<div style="font-size: 11px; color: var(--vscode-warningForeground); margin-top: 5px;">
                        Memory optimized: Showing \${data.loadingProgress.displayedRows.toLocaleString()} of \${data.loadingProgress.loadedLines.toLocaleString()} loaded rows
                    </div>\` : '';
                
                loadingProgress.innerHTML = \`
                    <div>\${data.loadingProgress.loadedLines.toLocaleString()} / \${data.loadingProgress.totalLines.toLocaleString()} lines (\${data.loadingProgress.progressPercent}%)</div>
                    \${memoryInfo}
                \`;
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            } else {
                // Loading complete - show controls and hide animated logo
                logo.style.display = 'block';
                const logoAnimation = document.getElementById('logoAnimation');
                if (logoAnimation) logoAnimation.style.display = 'none';
                loadingState.style.display = 'none';
                
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            }
            
            // Update search inputs
            
            // Update error count
            const errorCountElement = document.getElementById('errorCount');
            if (data.errorCount > 0) {
                errorCountElement.textContent = data.errorCount;
                errorCountElement.style.display = 'flex';
                // Default to raw view if there are errors
                if (currentView === 'table') {
                    switchView('raw');
                }
            } else {
                errorCountElement.style.display = 'none';
            }
            
            // Build table header and defer row rendering via virtualization
            buildTableHeader(data);
            renderTableChunk(true);

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

        function buildTableHeader(data) {
            const thead = document.getElementById('tableHead');
            const colgroup = document.getElementById('tableColgroup');
            if (!thead) return;

            thead.innerHTML = '';
            if (colgroup) colgroup.innerHTML = '';
            
            const headerRow = document.createElement('tr');

            // Add col for row number column
            if (colgroup) {
                const col = document.createElement('col');
                col.style.width = '40px';
                colgroup.appendChild(col);
            }

            // Add row number header
            const rowNumHeader = document.createElement('th');
            rowNumHeader.textContent = '#';
            rowNumHeader.style.minWidth = '40px';
            rowNumHeader.style.textAlign = 'center';
            rowNumHeader.classList.add('row-header');
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

        function createTableRow(row, rowIndex) {
            const tr = document.createElement('tr');

            // Get the actual index from the pre-computed mapping
            // rowIndex here is the filtered index (0-based position in currentData.rows)
            const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                ? currentData.rowIndices[rowIndex]
                : rowIndex; // Fallback to filtered index if mapping is unavailable

            // Store the filtered row index on the row element for Find/Replace
            tr.dataset.index = rowIndex.toString();

            // Add row number cell
            const rowNumCell = document.createElement('td');
            // Display sequential number (1, 2, 3...) for visual ordering
            rowNumCell.textContent = (rowIndex + 1).toString();
            rowNumCell.classList.add('row-header');
            // Tooltip shows the actual row number in the file
            rowNumCell.title = 'Row ' + (actualRowIndex + 1) + ' in file';
            rowNumCell.addEventListener('contextmenu', (e) => showRowContextMenu(e, actualRowIndex));
            tr.appendChild(rowNumCell);

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
            if (isNavigating) return;

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
        
        function editCell(event, td, rowIndex, columnPath) {
            // Prevent any default behavior
            event.preventDefault();
            event.stopPropagation();
            
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
            
            // Handle save on blur or enter
            function saveEdit() {
                const newValue = input.value;
                td.classList.remove('editing');
                td.textContent = newValue;
                td.title = newValue;
                
                // Send update message
                vscode.postMessage({
                    type: 'updateCell',
                    rowIndex: rowIndex,
                    columnPath: columnPath,
                    value: newValue
                });
            }
            
            // Handle cancel on escape
            function cancelEdit() {
                td.classList.remove('editing');
                td.textContent = originalValue;
                td.title = originalValue;
            }
            
            input.addEventListener('blur', saveEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
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
                case 'settingsLoaded':
                    const openaiKey = document.getElementById('openaiKey');
                    const openaiModel = document.getElementById('openaiModel');
                    const warningElement = document.getElementById('apiKeyWarning');

                    openaiKey.value = message.settings.openaiKey || '';
                    openaiModel.value = message.settings.openaiModel || 'gpt-4.1-mini';
                    
                    // Update warning visibility based on whether API key exists
                    if (warningElement) {
                        const hasAPIKey = message.settings.openaiKey && message.settings.openaiKey.trim().length > 0;
                        warningElement.style.display = hasAPIKey ? 'none' : 'block';
                    }
                    break;
                case 'recentEnumValuesLoaded':
                    recentEnumValues = message.recentValues || [];
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
        function switchView(viewType) {
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
            
            // Update data model when switching away from raw view (without saving)
            if (currentView === 'raw' && viewType !== 'raw') {
                // Get current content from Monaco editor and update data model without saving
                const rawEditor = document.getElementById('rawEditor');
                if (rawEditor && rawEditor.editor) {
                    const currentContent = rawEditor.editor.getValue();
                    vscode.postMessage({
                        type: 'rawContentChanged',
                        newContent: currentContent
                    });
                }
            }
            
            // Save current scroll position
            const tableContainer = document.getElementById('tableContainer');
            if (tableContainer) {
                scrollPositions[currentView] = tableContainer.scrollTop;
            }
            
            currentView = viewType;
            
            // Show animated gazelle during view switch
            const logo = document.getElementById('logo');
            const logoAnimation = document.getElementById('logoAnimation');
            const loadingState = document.getElementById('loadingState');
            logo.style.display = 'none';
            if (logoAnimation) logoAnimation.style.display = 'block';
            loadingState.style.display = 'flex';
            loadingState.innerHTML = '<div>Switching view...</div>';
            
            // Hide search container during view switch
            
            // Update segmented control
            document.querySelectorAll('.segmented-control button').forEach(button => {
                button.classList.toggle('active', button.dataset.view === viewType);
            });
            
            // Hide all view containers
            document.getElementById('tableViewContainer').style.display = 'none';
            document.getElementById('jsonViewContainer').style.display = 'none';
            document.getElementById('rawViewContainer').style.display = 'none';
            
            // Show/hide column manager and wrap text controls based on view
            const columnManagerBtn = document.getElementById('columnManagerBtn');
            const wrapTextControl = document.querySelector('.wrap-text-control');
            const findReplaceBtn = document.getElementById('findReplaceBtn');
            const settingsBtn = document.getElementById('settingsBtn');

            // Show selected view container
            switch (viewType) {
                case 'table':
                    document.getElementById('tableViewContainer').style.display = 'block';
                    document.getElementById('dataTable').style.display = 'table';
                    // Show column controls for table view
                    columnManagerBtn.style.display = 'flex';
                    wrapTextControl.style.display = 'flex';
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
                    wrapTextControl.style.display = 'none';
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
                    wrapTextControl.style.display = 'none';
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

                prettyEditor = monaco.editor.create(editorContainer, {
                    value: prettyContent,
                    language: 'json',
                    theme: 'vs-dark',
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    lineNumbers: lineMapping.length > 0 ? (lineNumber) => {
                        // Use custom line numbers based on mapping
                        if (lineNumber <= lineMapping.length) {
                            const mappedNumber = lineMapping[lineNumber - 1];
                            // If mappedNumber is 0, don't show line number (empty string)
                            return mappedNumber === 0 ? '' : mappedNumber.toString();
                        }
                        return lineNumber.toString();
                    } : 'on',
                    folding: true,
                    fontSize: 12,
                    fontFamily: 'var(--vscode-editor-font-family)'
                });

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

                // Add change listener with debounce
                prettyEditor.onDidChangeModelContent(() => {
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
                
                rawEditor = monaco.editor.create(editorContainer, {
                    value: currentData.rawContent || '',
                    language: 'json',
                    theme: 'vs-dark',
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    lineNumbers: 'on',
                    folding: true,
                    fontSize: 12,
                    fontFamily: 'var(--vscode-editor-font-family)'
                });
                
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
                
                // Handle content changes
                rawEditor.onDidChangeModelContent(() => {
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
        
        // Add event listeners for context menus
        document.getElementById('contextMenu').addEventListener('click', handleContextMenu);
        document.getElementById('rowContextMenu').addEventListener('click', handleRowContextMenu);
        
        // Hide context menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu') && !e.target.closest('.row-context-menu')) {
                hideContextMenu();
            }
        });
        
`;
