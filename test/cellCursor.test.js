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
    setTimeout: () => 1,
    setInterval: () => {},
    clearTimeout: () => {},
    console,
    navigator: { clipboard: {} },
    require: undefined
};

const posted = [];

const harness = scripts + `
;return {
    setCurrentData: data => { currentData = data; },
    setCurrentView: view => { currentView = view; },
    renderRows: () => renderTableChunk(true),
    getCursor: () => ({ row: cursorActualRowIndex, column: cursorColumnPath }),
    getCursorPosition: getCursorPosition,
    getCursorCell: getCursorCell,
    getSelectedRow: () => selectedRowActualIndex,
    setCellCursor: setCellCursor,
    jumpToDisplayRow: jumpToDisplayRow
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
keydown('ArrowUp');
keydown('ArrowLeft');
assert.deepStrictEqual(webview.getCursor(), { row: 0, column: 'a' }, 'the cursor stops at the grid edge');

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

console.log('cellCursor tests passed');
