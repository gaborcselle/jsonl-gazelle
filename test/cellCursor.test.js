const assert = require('assert');
const { scripts } = require('../out/webview/scripts');

// The spreadsheet cell cursor only exists inside the webview script string, so
// it is driven here against a stub DOM: render a table body, press keys at the
// document the way the browser would, and look at what the cells end up as.

function makeElement(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        children: [],
        dataset: {},
        style: {},
        textContent: '',
        title: '',
        value: '',
        offsetWidth: 1,
        clientHeight: 0,
        scrollTop: 0,
        scrollLeft: 0,
        handlers: {},
        parent: null,
        classList: {
            names: new Set(),
            add(name) { this.names.add(name); },
            remove(name) { this.names.delete(name); },
            contains(name) { return this.names.has(name); },
            toggle(name, force) {
                const on = force === undefined ? !this.names.has(name) : !!force;
                if (on) { this.names.add(name); } else { this.names.delete(name); }
            }
        },
        appendChild(child) {
            // A fragment hands over its children rather than itself
            if (child && child.isFragment) {
                child.children.forEach(grandChild => { grandChild.parent = this; });
                this.children = this.children.concat(child.children);
                child.children = [];
                return child;
            }
            child.parent = this;
            this.children.push(child);
            return child;
        },
        addEventListener(type, handler) {
            (this.handlers[type] = this.handlers[type] || []).push(handler);
        },
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { width: 1, height: 20, top: 0, left: 0, right: 1, bottom: 20 }; },
        closest(selector) {
            const wanted = selector.replace('.', '');
            let node = this;
            while (node) {
                if (node.tagName === wanted.toUpperCase() || node.classList.contains(wanted)) return node;
                node = node.parent;
            }
            return null;
        },
        remove() {},
        setAttribute() {},
        focus() {},
        select() {},
        scrollIntoView() { this.scrolledIntoView = true; }
    };
    // Clearing innerHTML is how the real code empties a container
    Object.defineProperty(el, 'innerHTML', {
        get() { return this.html || ''; },
        set(value) {
            this.html = value;
            if (value === '') this.children = [];
        }
    });
    return el;
}

function fire(element, type, event) {
    (element.handlers[type] || []).forEach(handler => handler(event || {}));
}

const elementsById = {};
const documentHandlers = {};
const body = makeElement('body');

const stubDocument = {
    body: body,
    activeElement: body,
    getElementById: id => elementsById[id] || (elementsById[id] = makeElement('div')),
    createElement: makeElement,
    createDocumentFragment: () => {
        const fragment = makeElement('fragment');
        fragment.isFragment = true;
        return fragment;
    },
    createTextNode: text => ({ textContent: text, children: [], classList: { contains: () => false } }),
    querySelector: selector => {
        if (selector === 'td.editing') {
            return allCells().find(td => td.classList.contains('editing')) || null;
        }
        return null;
    },
    querySelectorAll: selector => {
        if (selector === '#tableBody tr.selected') {
            return rows().filter(tr => tr.classList.contains('selected'));
        }
        return [];
    },
    addEventListener: (type, handler) => {
        (documentHandlers[type] = documentHandlers[type] || []).push(handler);
    }
};

const sandbox = {
    acquireVsCodeApi: () => ({
        postMessage: message => posted.push(message),
        getState: () => null,
        setState: () => {}
    }),
    document: stubDocument,
    window: {
        innerWidth: 1000,
        innerHeight: 800,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    },
    requestAnimationFrame: () => {},
    // Timers are recorded rather than run, so a test can fire the one it means
    // to (the hint's fade) without also firing everything else that is pending
    setTimeout: (fn, ms) => {
        pendingTimeouts.push({ id: ++timeoutId, fn: fn, ms: ms });
        return timeoutId;
    },
    setInterval: () => {},
    clearTimeout: id => {
        const at = pendingTimeouts.findIndex(t => t.id === id);
        if (at !== -1) pendingTimeouts.splice(at, 1);
    },
    console,
    navigator: { clipboard: {} },
    require: undefined
};

const posted = [];
let timeoutId = 0;
const pendingTimeouts = [];

// Run every pending timeout registered for exactly `ms`, oldest first
function fireTimeouts(ms) {
    const due = pendingTimeouts.filter(t => t.ms === ms);
    due.forEach(t => {
        pendingTimeouts.splice(pendingTimeouts.indexOf(t), 1);
        t.fn();
    });
    return due.length;
}

const harness = scripts + `
;return {
    setCurrentData: data => { currentData = data; },
    setCurrentView: view => { currentView = view; },
    renderRows: () => renderTableChunk(true),
    renderHeader: () => buildTableHeader(currentData),
    getCursor: () => ({ row: cursorActualRowIndex, column: cursorColumnPath }),
    getCursorPosition: getCursorPosition,
    getCursorCell: getCursorCell,
    getSelectedRow: () => selectedRowActualIndex,
    setCellCursor: setCellCursor,
    jumpToDisplayRow: jumpToDisplayRow,
    cursorZone: cursorZone,
    HEADER_ROW: HEADER_ROW_INDEX,
    ROW_HEADER_COLUMN: ROW_HEADER_COLUMN_PATH,
    HINT_TIMEOUT_MS: CURSOR_HINT_TIMEOUT_MS
};`;
const webview = new Function(...Object.keys(sandbox), harness)(...Object.values(sandbox));

const tbody = stubDocument.getElementById('tableBody');
const rows = () => tbody.children;
const allCells = () => rows().reduce((cells, tr) => cells.concat(tr.children), []);

// A keystroke at `target` (or at the document when there is none). Events
// bubble the way the browser bubbles them: a key handled by the cell editor
// reaches the document's grid handler too unless the editor stops it.
function dispatchKeydown(target, key, options) {
    let defaultPrevented = false;
    let propagationStopped = false;
    const event = Object.assign({
        key: key,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault() { defaultPrevented = true; },
        stopPropagation() { propagationStopped = true; }
    }, options);
    if (target) fire(target, 'keydown', event);
    if (!propagationStopped) {
        (documentHandlers.keydown || []).forEach(handler => handler(event));
    }
    return defaultPrevented;
}

function keydown(key, options) {
    return dispatchKeydown(null, key, options);
}

function tableData(overrides) {
    const allRows = [
        { a: 1, b: 'x', c: { k: 1 } },
        { a: 2, b: 'y', c: { k: 2 } },
        { a: 3, b: 'z', c: { k: 3 } }
    ];
    return Object.assign({
        rows: allRows,
        allRows: allRows,
        rowIndices: [0, 1, 2],
        columns: [
            { path: 'a', displayName: 'a', visible: true },
            { path: 'b', displayName: 'b', visible: true },
            { path: 'c', displayName: 'c', visible: true }
        ],
        displaySort: null
    }, overrides);
}

// The cell a given file row / column path renders into, for assertions
function cellAt(displayRow, visibleColumn) {
    return rows()[displayRow].children[visibleColumn + 1]; // +1 for the row-number cell
}

function cursorCells() {
    return allCells().filter(td => td.classList.contains('cell-cursor'));
}

const HEADER_ROW = webview.HEADER_ROW;
const ROW_HEADER_COLUMN = webview.ROW_HEADER_COLUMN;
const hintElement = () => stubDocument.getElementById('cursorHint');
const hintKeys = () => hintElement().children.filter(c => c.tagName === 'KBD').map(c => c.textContent);
const hintText = () => hintElement().children.filter(c => c.tagName === 'SPAN').map(c => c.textContent).join(' ');

webview.setCurrentData(tableData());
webview.renderRows();
assert.strictEqual(rows().length, 3, 'the stub table must render every row');

// --- Entering the grid --------------------------------------------------

assert.deepStrictEqual(webview.getCursor(), { row: null, column: null }, 'no cursor before any key');
assert.ok(keydown('ArrowDown'), 'an arrow key in the table view must be consumed');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' },
    'the first arrow key lands on the first cell rather than also moving');
assert.strictEqual(webview.getSelectedRow(), 0, 'the cursor row is the selected row');
assert.strictEqual(cursorCells().length, 1, 'exactly one cell carries the cursor');
assert.strictEqual(cursorCells()[0], cellAt(0, 0), 'the cursor is on the first cell');

// --- Arrow keys ---------------------------------------------------------

keydown('ArrowDown');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'a' }, 'down moves a row');
keydown('ArrowRight');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'b' }, 'right moves a column');
assert.strictEqual(cursorCells()[0], cellAt(1, 1), 'the highlight follows the cursor');
assert.strictEqual(webview.getSelectedRow(), 1, 'the row highlight follows the cursor');
assert.ok(rows()[1].classList.contains('selected'), 'the cursor row is marked selected');
assert.ok(!rows()[0].classList.contains('selected'), 'the row left behind is deselected');

keydown('ArrowUp');
keydown('ArrowLeft');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' }, 'up and left move back');

// Off the top and off the left are the two header bands, not a wall
keydown('ArrowUp');
assert.deepStrictEqual(webview.getCursor(), { row: HEADER_ROW, column: 'a' },
    'up out of the first row lands on the column header');
keydown('ArrowLeft');
assert.deepStrictEqual(webview.getCursor(), { row: HEADER_ROW, column: 'a' },
    'the column header does not reach the row-number corner');
keydown('ArrowDown');
keydown('ArrowLeft');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: ROW_HEADER_COLUMN },
    'left out of the first column lands on the row number');
keydown('ArrowUp');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: ROW_HEADER_COLUMN },
    'the row-number column does not reach the corner either');
keydown('ArrowRight');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' }, 'right comes back into the grid');

keydown('End');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'c' }, 'End goes to the last column');
keydown('Home');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' }, 'Home goes back to the first');
keydown('PageDown');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'a' }, 'PageDown clamps at the last row');

// --- Tab ----------------------------------------------------------------

webview.setCellCursor(0, 'a', false);
assert.ok(keydown('Tab'), 'Tab with an active cursor must be consumed');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'b' }, 'Tab advances a column');
keydown('Tab');
keydown('Tab');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'a' }, 'Tab off the end wraps to the next row');
keydown('Tab', { shiftKey: true });
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'c' }, 'Shift+Tab wraps back');

// --- Keys that are not ours --------------------------------------------

const cursorBefore = webview.getCursor();
assert.ok(!keydown('ArrowDown', { altKey: true }), 'Alt+Arrow belongs to the line-move shortcut');
assert.ok(!keydown('ArrowDown', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+Arrow belongs to entry navigation');
assert.deepStrictEqual(webview.getCursor(), cursorBefore, 'modified arrows must not move the cursor');

stubDocument.activeElement = Object.assign(makeElement('input'), { id: 'findInput' });
assert.ok(!keydown('ArrowDown'), 'arrows belong to whatever input has focus');
assert.deepStrictEqual(webview.getCursor(), cursorBefore, 'typing in the find box must not move the cursor');
stubDocument.activeElement = body;

webview.setCurrentView('raw');
assert.ok(!keydown('ArrowDown'), 'the grid only claims keys in the table view');
assert.deepStrictEqual(webview.getCursor(), cursorBefore, 'the cursor must not move from another view');
webview.setCurrentView('table');

// An open context menu sits over the table and is driven by clicks
stubDocument.getElementById('rowContextMenu').style.display = 'block';
assert.ok(!keydown('ArrowDown'), 'keys belong to an open context menu');
assert.deepStrictEqual(webview.getCursor(), cursorBefore, 'the cursor must not move behind a context menu');
stubDocument.getElementById('rowContextMenu').style.display = 'none';

// Enter presses whatever has focus, so a focused button keeps it - but arrows
// activate nothing, so the grid may still have those
webview.setCellCursor(0, 'a', false);
stubDocument.activeElement = makeElement('button');
assert.ok(!keydown('Enter'), 'Enter belongs to the focused button');
assert.strictEqual(stubDocument.querySelector('td.editing'), null, 'a focused button must not open a cell editor');
assert.ok(keydown('ArrowDown'), 'arrows still drive the grid while a button has focus');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'a' }, 'the arrow key still moved the cursor');
stubDocument.activeElement = body;
// The same Enter, with focus back on the page, does open the editor
assert.ok(keydown('Enter'), 'Enter opens the editor once no control has focus');
assert.ok(stubDocument.querySelector('td.editing'), 'the cursor cell is now being edited');
dispatchKeydown(stubDocument.querySelector('td.editing').children[0], 'Escape');

// --- Clicking a cell ----------------------------------------------------

fire(cellAt(2, 1), 'click');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'b' }, 'clicking a cell moves the cursor to it');
assert.strictEqual(webview.getSelectedRow(), 2, 'clicking a cell selects its row');

// An object cell stops the click from bubbling to expand itself; the cursor
// still has to follow, or the keyboard and the mouse disagree about where it is
fire(cellAt(0, 2), 'click', { preventDefault() {}, stopPropagation() {} });
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'c' }, 'clicking an object cell moves the cursor too');

// --- The cursor survives a rebuild -------------------------------------

webview.setCellCursor(1, 'b', false);
webview.renderRows();
assert.strictEqual(cursorCells().length, 1, 'the rebuilt table carries exactly one cursor');
assert.strictEqual(cursorCells()[0], cellAt(1, 1), 'the cursor is re-applied to the same cell after a rebuild');
assert.ok(rows()[1].classList.contains('selected'), 'the row selection is re-applied after a rebuild');

// Clearing has to act on the cells the rebuild produced, not the detached ones
// the cursor was pointing at before it
keydown('Escape');
assert.strictEqual(cursorCells().length, 0, 'Escape after a rebuild removes the cursor highlight');
assert.strictEqual(rows().filter(tr => tr.classList.contains('selected')).length, 0,
    'Escape after a rebuild removes the row highlight');

// --- Editing ------------------------------------------------------------

posted.length = 0;
webview.setCellCursor(1, 'b', false);
assert.ok(keydown('Enter'), 'Enter with a cursor must be consumed');
let editing = stubDocument.querySelector('td.editing');
assert.strictEqual(editing, cellAt(1, 1), 'Enter opens the editor on the cursor cell');
let input = editing.children[0];
assert.strictEqual(input.tagName, 'INPUT', 'the editor is an input');
assert.strictEqual(input.value, '"y"', 'the editor starts from the cell value');

assert.ok(!keydown('ArrowDown'), 'arrows belong to the editor while a cell is being edited');
assert.strictEqual(stubDocument.querySelector('td.editing'), editing, 'an arrow key must not close the editor');

// Enter commits and steps down a row, the way a spreadsheet does
input.value = '"edited"';
dispatchKeydown(input, 'Enter');
assert.deepStrictEqual(posted[posted.length - 1], {
    type: 'updateCell', rowIndex: 1, columnPath: 'b', value: '"edited"'
}, 'Enter saves the edited value against the file row');
assert.strictEqual(stubDocument.querySelector('td.editing'), null, 'Enter closes the editor');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'b' }, 'Enter steps down a row');

// Tab commits and steps to the next cell
posted.length = 0;
webview.setCellCursor(0, 'a', false);
keydown('Enter');
input = stubDocument.querySelector('td.editing').children[0];
input.value = '42';
dispatchKeydown(input, 'Tab');
assert.deepStrictEqual(posted[posted.length - 1], {
    type: 'updateCell', rowIndex: 0, columnPath: 'a', value: '42'
}, 'Tab saves the edited value');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'b' }, 'Tab steps to the next cell');

// Escape reverts and writes nothing
posted.length = 0;
webview.setCellCursor(2, 'a', false);
keydown('Enter');
editing = stubDocument.querySelector('td.editing');
input = editing.children[0];
input.value = '999';
dispatchKeydown(input, 'Escape');
assert.deepStrictEqual(posted, [], 'Escape must not save anything');
assert.strictEqual(editing.textContent, '3', 'Escape restores the original value');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'a' }, 'Escape leaves the cursor where it was');

// A trailing blur after the key already finished the edit must not save twice
posted.length = 0;
webview.setCellCursor(0, 'a', false);
keydown('Enter');
input = stubDocument.querySelector('td.editing').children[0];
input.value = '7';
dispatchKeydown(input, 'Enter');
fire(input, 'blur');
assert.strictEqual(posted.filter(m => m.type === 'updateCell').length, 1, 'a finished edit must save exactly once');

// Object and array cells have no inline editor - Enter expands the column,
// which is what double-clicking one does
posted.length = 0;
webview.setCellCursor(0, 'c', false);
keydown('Enter');
assert.strictEqual(stubDocument.querySelector('td.editing'), null, 'an object cell must not open a text editor');
assert.deepStrictEqual(posted, [{ type: 'expandColumn', columnPath: 'c' }],
    'Enter on an object cell expands the column');

// --- Escape clears the cursor ------------------------------------------

webview.setCellCursor(1, 'b', false);
keydown('Escape');
assert.deepStrictEqual(webview.getCursor(), { row: null, column: null }, 'Escape clears the cell cursor');
assert.strictEqual(webview.getSelectedRow(), null, 'Escape clears the row selection');
assert.strictEqual(cursorCells().length, 0, 'Escape removes the cursor highlight');

// --- Hidden columns -----------------------------------------------------

const withHiddenColumn = tableData();
withHiddenColumn.columns[2].visible = false;
webview.setCurrentData(withHiddenColumn);
webview.renderRows();
webview.setCellCursor(0, 'b', false);
keydown('Tab');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'a' },
    'Tab skips hidden columns and wraps at the last visible one');

// A cursor left on a column that has since been hidden is not on screen, so it
// re-enters the grid rather than moving from a cell nobody can see
webview.setCellCursor(0, 'c', false);
assert.strictEqual(webview.getCursorPosition(), null, 'a hidden column has no cursor position');
assert.strictEqual(webview.getCursorCell(), null, 'a hidden column has no cursor cell');
keydown('ArrowDown');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' }, 'the cursor re-enters the grid at the top');

// --- A filtered view ----------------------------------------------------

// Search keeps only file rows 2 and 0; the cursor is stored by file row, so it
// has to name the file row the user is actually looking at
const filtered = tableData();
filtered.rows = [filtered.allRows[2], filtered.allRows[0]];
filtered.rowIndices = [2, 0];
webview.setCurrentData(filtered);
webview.renderRows();
webview.setCellCursor(2, 'a', false);
assert.deepStrictEqual(webview.getCursorPosition(), { row: 0, column: 0 },
    'the cursor resolves to its position in the filtered view');
keydown('ArrowDown');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' },
    'moving down in a filtered view follows the display order, not the file order');

// --- The cursor follows a whole-row selection ---------------------------

// The row-number cell is the one cell with no cursor handler of its own, so a
// click on it only reaches the row. The cursor has to come along, or the row
// highlight and the cell highlight end up on different rows and the next arrow
// key jumps back to the row the user just left.
webview.setCurrentData(tableData());
webview.renderRows();
webview.setCellCursor(0, 'b', false);
fire(rows()[2], 'click'); // a click on the row-number cell bubbles to the row
assert.strictEqual(webview.getSelectedRow(), 2, 'clicking the row number selects that row');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'b' },
    'the cursor moves to the clicked row and keeps its column');
assert.strictEqual(cursorCells().length, 1, 'exactly one cell carries the cursor');
assert.strictEqual(cursorCells()[0], cellAt(2, 1), 'the one cursor is on the clicked row');
keydown('ArrowDown');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'b' },
    'the next arrow key moves on from the clicked row, not from the old cursor');

// Clicking a data cell still names its own column: the cell handler runs first
// and the row handler it bubbles into must not drag the cursor back
webview.setCellCursor(0, 'a', false);
fire(cellAt(1, 1), 'click');
fire(rows()[1], 'click');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'b' },
    'a cell click keeps the column it named');

// The sort-jump notice's "Jump to row" selects a row the same way
webview.setCellCursor(0, 'b', false);
webview.jumpToDisplayRow(2);
assert.strictEqual(webview.getSelectedRow(), 2, 'jumping to a row selects it');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: 'b' },
    'jumping to a row brings the cursor with it');

// A column that has since been hidden cannot hold the cursor - it falls back
// to the first visible one rather than landing off screen
const jumpHidden = tableData();
jumpHidden.columns[1].visible = false;
webview.setCurrentData(jumpHidden);
webview.renderRows();
webview.setCellCursor(0, 'b', false);
fire(rows()[1], 'click');
assert.deepStrictEqual(webview.getCursor(), { row: 1, column: 'a' },
    'a hidden column falls back to the first visible one');

// --- Falsy rows ---------------------------------------------------------

// A bare-value file: every line is a JSON scalar, so there is one "(value)"
// column. 0, false and "" are rows like any other - dropping one would shift
// every later row up, and the cursor reaches a row by its position in tbody.
const bareRows = [10, 0, 30, false, ''];
webview.setCurrentData({
    rows: bareRows,
    allRows: bareRows,
    rowIndices: [0, 1, 2, 3, 4],
    columns: [{ path: '(value)', displayName: '(value)', visible: true }],
    displaySort: null
});
webview.renderRows();
assert.strictEqual(rows().length, 5, 'a falsy row still gets a row element');
assert.deepStrictEqual(rows().map(tr => tr.dataset.actualIndex), ['0', '1', '2', '3', '4'],
    'the rendered rows line up with the file rows');
assert.deepStrictEqual(allCells().filter(td => !td.classList.contains('row-header')).map(td => td.textContent),
    ['10', '0', '30', 'false', '""'], 'a falsy bare value renders as itself, not as an empty cell');

// The cursor now resolves to the row it names, and an edit is written there
webview.setCellCursor(2, '(value)', false);
assert.strictEqual(webview.getCursorCell(), cellAt(2, 0), 'the cursor is on the row it names');
posted.length = 0;
keydown('Enter');
editing = stubDocument.querySelector('td.editing');
assert.strictEqual(editing, cellAt(2, 0), 'the editor opens on the cursor cell');
assert.strictEqual(editing.children[0].value, '30', 'the editor starts from that row\'s value');
editing.children[0].value = '999';
dispatchKeydown(editing.children[0], 'Enter');
assert.deepStrictEqual(posted[posted.length - 1], {
    type: 'updateCell', rowIndex: 2, columnPath: '(value)', value: '999'
}, 'the edit is written to the row the cursor was on');

// --- The column header ---------------------------------------------------

webview.setCurrentData(tableData());
webview.renderRows();
webview.renderHeader();
const headerCells = () => stubDocument.getElementById('tableHead').children[0].children;
const headerCellFor = visibleColumn => headerCells()[visibleColumn + 1]; // +1 for the row-number header

webview.setCellCursor(0, 'b', false);
keydown('ArrowUp');
assert.strictEqual(webview.cursorZone(), 'columnHeader', 'up out of the top row reaches the column header');
assert.strictEqual(webview.getCursorCell(), headerCellFor(1), 'the cursor is on that column\'s header cell');
assert.ok(headerCellFor(1).classList.contains('cell-cursor'), 'the header cell carries the cursor highlight');
assert.strictEqual(webview.getSelectedRow(), null, 'the header row is not a row of the file to select');

// The hint tells the user what the cell under the cursor is good for
assert.strictEqual(hintElement().style.display, 'flex', 'a header cursor shows a hint');
assert.strictEqual(hintElement().dataset.hint, 'columnHeader', 'the hint is the column-header one');
assert.deepStrictEqual(hintKeys(), ['S'], 'the column-header hint names the S key');
assert.ok(/sort/.test(hintText()), 'the column-header hint says what S does');

// ...and then gets out of the way
assert.strictEqual(fireTimeouts(webview.HINT_TIMEOUT_MS), 1, 'the hint is on a timer');
assert.strictEqual(hintElement().style.display, 'none', 'the hint hides itself after a while');

// Moving within the header brings it back, moving back to a cell does not
keydown('ArrowRight');
assert.strictEqual(hintElement().style.display, 'flex', 'moving along the header shows the hint again');
keydown('ArrowDown');
assert.strictEqual(webview.cursorZone(), 'cell', 'down comes back out of the header');
assert.strictEqual(hintElement().style.display, 'none', 'a data cell has no hint');
assert.strictEqual(pendingTimeouts.filter(t => t.ms === webview.HINT_TIMEOUT_MS).length, 0,
    'leaving the header cancels the pending fade');

// S cycles the display sort: off -> ascending -> descending -> off
posted.length = 0;
fire(headerCellFor(0), 'click');
assert.strictEqual(webview.cursorZone(), 'columnHeader', 'clicking a header puts the cursor on it');
assert.deepStrictEqual(webview.getCursor(), { row: HEADER_ROW, column: 'a' }, 'on the column that was clicked');

assert.ok(keydown('s'), 'S on a column header is consumed');
assert.deepStrictEqual(posted[posted.length - 1],
    { type: 'setDisplaySort', columnPath: 'a', direction: 'asc' }, 'S sorts ascending first');

const sortedAsc = tableData({ displaySort: { columnPath: 'a', direction: 'asc' } });
webview.setCurrentData(sortedAsc);
keydown('S');
assert.deepStrictEqual(posted[posted.length - 1],
    { type: 'setDisplaySort', columnPath: 'a', direction: 'desc' }, 'S again sorts descending');

webview.setCurrentData(tableData({ displaySort: { columnPath: 'a', direction: 'desc' } }));
keydown('s');
assert.deepStrictEqual(posted[posted.length - 1],
    { type: 'setDisplaySort', columnPath: null, direction: null }, 'S a third time clears the sort');

// The header is rebuilt whenever the columns change, so the cursor has to be
// re-applied by the rebuild itself, not just painted on when it moves
webview.setCurrentData(tableData());
webview.renderRows();
webview.setCellCursor(HEADER_ROW, 'b', false);
webview.renderHeader();
assert.strictEqual(webview.getCursorCell(), headerCellFor(1), 'the cursor survives a header rebuild');
assert.ok(headerCellFor(1).classList.contains('cell-cursor'), 'and so does its highlight');
assert.strictEqual(headerCells().filter(th => th.classList.contains('cell-cursor')).length, 1,
    'the rebuilt header carries exactly one cursor');

// A column header holds a name, not file data, so Enter must not edit it
posted.length = 0;
keydown('Enter');
assert.strictEqual(stubDocument.querySelector('td.editing'), null, 'Enter must not open an editor on a header');
assert.deepStrictEqual(posted, [], 'and must not send anything either');

// S only belongs to the column header
webview.setCellCursor(1, 'b', false);
posted.length = 0;
assert.ok(!keydown('s'), 'S in a data cell is not the grid\'s key');
assert.deepStrictEqual(posted, [], 'and sorts nothing');

// --- The row-number column ------------------------------------------------

webview.setCellCursor(1, 'a', false);
keydown('ArrowLeft');
assert.strictEqual(webview.cursorZone(), 'rowHeader', 'left out of the first column reaches the row number');
assert.strictEqual(webview.getCursorCell(), rows()[1].children[0], 'the cursor is on that row\'s number cell');
assert.strictEqual(webview.getSelectedRow(), 1, 'the row is still the selected one');
assert.strictEqual(hintElement().dataset.hint, 'rowHeader', 'the row-number hint is showing');
assert.deepStrictEqual(hintKeys(), ['U', 'D', 'Delete'], 'it names the move and delete keys');
assert.ok(/move this row/.test(hintText()) && /delete this row/.test(hintText()),
    'and says what each of them does');

// The tbody is rebuilt on every update, so the row-number cursor has to be
// re-applied by the rebuild the same way a data cell's is
webview.renderRows();
assert.strictEqual(webview.getCursorCell(), rows()[1].children[0],
    'the row-number cursor survives a rebuild');
assert.ok(rows()[1].children[0].classList.contains('cell-cursor'), 'and keeps its highlight');
assert.strictEqual(cursorCells().length, 1, 'the rebuilt table carries exactly one cursor');

// U hands the row to the reorder the drag uses, and follows it
posted.length = 0;
assert.ok(keydown('u'), 'U on a row number is consumed');
assert.deepStrictEqual(posted, [{ type: 'reorderRows', fromIndex: 1, toIndex: 0 }],
    'U moves the row one place up the file');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: ROW_HEADER_COLUMN },
    'the cursor follows the row to where it lands');

// D is sent as "pull the row below this one up over it" - dropping a row onto
// its own next neighbour would be a no-op
webview.setCellCursor(1, ROW_HEADER_COLUMN, false);
posted.length = 0;
keydown('D');
assert.deepStrictEqual(posted, [{ type: 'reorderRows', fromIndex: 2, toIndex: 1 }],
    'D moves the row one place down the file, upper case too');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: ROW_HEADER_COLUMN },
    'the cursor follows it down too');

// Neither end of the file has anywhere to go
webview.setCellCursor(0, ROW_HEADER_COLUMN, false);
posted.length = 0;
keydown('u');
assert.deepStrictEqual(posted, [], 'the first row cannot move up');
webview.setCellCursor(2, ROW_HEADER_COLUMN, false);
keydown('d');
assert.deepStrictEqual(posted, [], 'the last row cannot move down');

// Arrow keys still move the cursor, never the row
webview.setCellCursor(1, ROW_HEADER_COLUMN, false);
posted.length = 0;
keydown('ArrowDown');
assert.deepStrictEqual(posted, [], 'an arrow key moves nothing in the file');
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: ROW_HEADER_COLUMN }, 'it moves the cursor');

// U and D only bind on a row number - a data cell must not reorder the file
webview.setCellCursor(1, 'b', false);
posted.length = 0;
assert.ok(!keydown('u'), 'U in a data cell is not the grid\'s key');
assert.ok(!keydown('d'), 'nor is D');
assert.deepStrictEqual(posted, [], 'and neither moves anything');

// Delete asks the extension to remove the row (which confirms before it does)
webview.setCellCursor(2, ROW_HEADER_COLUMN, false);
posted.length = 0;
assert.ok(keydown('Delete'), 'Delete on a row number is consumed');
assert.deepStrictEqual(posted, [{ type: 'deleteRow', rowIndex: 2 }], 'Delete removes the cursor row');
posted.length = 0;
keydown('Backspace');
assert.deepStrictEqual(posted, [{ type: 'deleteRow', rowIndex: 2 }], 'Backspace does the same');

// Delete only belongs to the row number - a data cell must not lose its row
webview.setCellCursor(1, 'b', false);
posted.length = 0;
assert.ok(!keydown('Delete'), 'Delete in a data cell is not the grid\'s key');
assert.deepStrictEqual(posted, [], 'and deletes nothing');

// A cursor whose row or column has been filtered away is not on screen, and a
// key must not act on a cell the user cannot see
const hiddenSort = tableData();
hiddenSort.columns[0].visible = false;
webview.setCurrentData(hiddenSort);
webview.setCellCursor(HEADER_ROW, 'a', false);
posted.length = 0;
keydown('s');
assert.deepStrictEqual(posted, [], 'S must not sort a column that has been hidden');

const filteredOut = tableData();
filteredOut.rows = [filteredOut.allRows[0]];
filteredOut.rowIndices = [0];
webview.setCurrentData(filteredOut);
webview.renderRows();
webview.setCellCursor(2, ROW_HEADER_COLUMN, false);
posted.length = 0;
keydown('Delete');
assert.deepStrictEqual(posted, [], 'Delete must not remove a row the search has filtered away');
keydown('u');
assert.deepStrictEqual(posted, [], 'and it must not be moved either');

// A display sort makes screen order and file order disagree, so there is no
// honest answer to "move this row up" - the same reason drag-reorder is off
const sortedRows = tableData({ displaySort: { columnPath: 'a', direction: 'asc' } });
webview.setCurrentData(sortedRows);
webview.renderRows();
webview.setCellCursor(1, ROW_HEADER_COLUMN, false);
assert.deepStrictEqual(hintKeys(), ['Delete'], 'a sorted view offers only the delete key');
assert.ok(/clear the sort/.test(hintText()), 'and says why the move keys are gone');
posted.length = 0;
keydown('u');
assert.deepStrictEqual(posted, [], 'a sorted view must not reorder the file');

// --- Clicking the row number ----------------------------------------------

webview.setCurrentData(tableData());
webview.renderRows();
webview.setCellCursor(0, 'b', false);
fire(rows()[2].children[0], 'click');
fire(rows()[2], 'click'); // the click bubbles on to the row
assert.deepStrictEqual(webview.getCursor(), { row: 2, column: ROW_HEADER_COLUMN },
    'clicking a row number parks the cursor there rather than on a data cell');
assert.strictEqual(webview.getSelectedRow(), 2, 'and selects the row');

// Escape puts the cursor and its hint away together
keydown('Escape');
assert.strictEqual(webview.cursorZone(), null, 'Escape clears a header cursor too');
assert.strictEqual(hintElement().style.display, 'none', 'and takes the hint with it');
assert.strictEqual(cursorCells().length, 0, 'no cell is left highlighted');

console.log('cellCursor tests passed');
