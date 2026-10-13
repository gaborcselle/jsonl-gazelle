const assert = require('assert');
const { scripts } = require('../out/webview/scripts');

// Table-view Find/Replace lives in the webview script string. Drive it against
// a stub DOM with a stand-in for the extension: apply the edits it posts, then
// send the update back the way the extension does.

function makeElement(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        children: [],
        dataset: {},
        style: {},
        textContent: '',
        title: '',
        value: '',
        checked: false,
        disabled: false,
        offsetWidth: 1,
        clientHeight: 0,
        scrollHeight: 0,
        scrollTop: 0,
        scrollLeft: 0,
        handlers: {},
        parent: null,
        classList: {
            names: new Set(),
            add(...names) { names.forEach(name => this.names.add(name)); },
            remove(...names) { names.forEach(name => this.names.delete(name)); },
            contains(name) { return this.names.has(name); },
            toggle(name, force) {
                const on = force === undefined ? !this.names.has(name) : !!force;
                if (on) { this.names.add(name); } else { this.names.delete(name); }
            }
        },
        appendChild(child) {
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
        insertBefore(child) { return this.appendChild(child); },
        addEventListener(type, handler) { (this.handlers[type] = this.handlers[type] || []).push(handler); },
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { width: 1, height: 20, top: 0, left: 0, right: 1, bottom: 20 }; },
        closest(selector) {
            const wanted = selector.replace('.', '');
            let node = this;
            while (node) {
                if (node.tagName === wanted.toUpperCase() || (node.classList && node.classList.contains(wanted))) return node;
                node = node.parent;
            }
            return null;
        },
        remove() {},
        setAttribute() {},
        removeAttribute() {},
        focus() {},
        select() {},
        scrollIntoView() {}
    };
    Object.defineProperty(el, 'parentNode', { get() { return this.parent; } });
    Object.defineProperty(el, 'innerHTML', {
        get() { return this.html || ''; },
        set(value) { this.html = value; if (value === '') this.children = []; }
    });
    return el;
}

const elementsById = {};
const posted = [];
const stubDocument = {
    body: makeElement('body'),
    getElementById: id => elementsById[id] || (elementsById[id] = Object.assign(makeElement('div'), { id })),
    createElement: makeElement,
    createDocumentFragment: () => { const fragment = makeElement('fragment'); fragment.isFragment = true; return fragment; },
    createTextNode: text => ({ textContent: text, children: [], classList: { contains: () => false } }),
    querySelector: () => null,
    querySelectorAll: selector => {
        if (selector === '.find-highlight, .find-highlight-current') {
            return elementsById.tableBody.children.reduce((cells, tr) => cells.concat(tr.children), []);
        }
        return [];
    },
    addEventListener: () => {}
};
stubDocument.activeElement = stubDocument.body;

const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState: () => null, setState: () => {} }),
    document: stubDocument,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    requestAnimationFrame: () => {},
    setTimeout: () => 0,
    setInterval: () => {},
    clearTimeout: () => {},
    console,
    navigator: { clipboard: {} },
    require: undefined,
    Event: function (type) { this.type = type; },
    getComputedStyle: () => ({ getPropertyValue: () => '' })
};

const webview = new Function(...Object.keys(sandbox), scripts + `
;return {
    setCurrentView: view => { currentView = view; },
    updateTable,
    openFindReplaceBar, replaceCurrent, replaceAll,
    findState: () => findReplaceState,
    renderedRows: () => tableRenderState.renderedRows
};`)(...Object.values(sandbox));
const $ = id => stubDocument.getElementById(id);

// --- a stand-in extension -----------------------------------------------------

let file = [];
let sortColumn = null;
const columns = paths => paths.map(path => ({ path, displayName: path, visible: true }));
let fileColumns = [];

function sendUpdate() {
    const indices = file.map((_, i) => i);
    if (sortColumn) {
        indices.sort((a, b) => String(file[a][sortColumn]).localeCompare(String(file[b][sortColumn])));
    }
    webview.updateTable({
        rows: indices.map(i => file[i]),
        allRows: file,
        rowIndices: indices,
        columns: fileColumns,
        errorCount: 0,
        loadingProgress: { loadingChunks: false }
    });
}

// What JsonlViewerProvider.updateCells does with each edit
function applyPostedEdits() {
    const messages = posted.splice(0);
    messages.filter(m => m.type === 'updateCells').forEach(m => {
        m.edits.forEach(edit => {
            let value = edit.value;
            if (value.trim() === '') {
                value = null;
            } else {
                try { value = JSON.parse(value); } catch { /* stays a string */ }
            }
            file[edit.rowIndex][edit.columnPath] = value;
        });
    });
    return messages;
}

function load(rows, paths, sortBy) {
    file = rows;
    fileColumns = columns(paths);
    sortColumn = sortBy || null;
    posted.length = 0;
    sendUpdate();
}

function find(text, replaceWith) {
    $('findInput').value = text;
    $('replaceInput').value = replaceWith === undefined ? '' : replaceWith;
    $('regexCheckbox').checked = false;
    $('caseSensitiveCheckbox').checked = false;
    $('wholeWordCheckbox').checked = false;
    $('findReplaceBar').style.display = 'none';
    webview.openFindReplaceBar(true);
}

webview.setCurrentView('table');

// --- every row is searched, rendered or not -----------------------------------

{
    load(Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'foo' + i })), ['id', 'name']);
    assert.ok(webview.renderedRows() < 1000, 'the table renders in chunks');
    find('foo', 'bar');
    assert.strictEqual(webview.findState().matches.length, 1000);
    webview.replaceAll();
    const messages = applyPostedEdits();
    assert.strictEqual(messages.length, 1, 'Replace All is one batched message');
    assert.strictEqual(messages[0].edits.length, 1000);
    assert.ok(file.every((row, i) => row.name === 'bar' + i));
}

// --- the row-number column is not data ----------------------------------------

{
    load([{ a: 'x' }, { a: 'y' }], ['a']);
    find('2', 'Q');
    assert.strictEqual(webview.findState().matches.length, 0, 'row number "2" is not a match');
}

// --- Replace after the view re-sorted hits the right row ---------------------

{
    // Sorted by name: bill, bob, carl. Replacing "b" in "bill" re-sorts the
    // view; the next Replace must reach "bob", not whatever sits in its old slot
    load([{ name: 'bob' }, { name: 'bill' }, { name: 'carl' }], ['name'], 'name');
    find('b', 'z');
    webview.replaceCurrent();
    applyPostedEdits();
    sendUpdate();
    webview.replaceCurrent();
    applyPostedEdits();
    sendUpdate();
    assert.deepStrictEqual(file.map(row => row.name), ['zob', 'zill', 'carl']);
}

// --- a second Replace waits for the first one's update ------------------------

{
    load([{ s: 'a-b-c' }], ['s']);
    find('-', '+');
    webview.replaceCurrent();
    webview.replaceCurrent(); // before the update: would undo the first replacement
    const messages = applyPostedEdits();
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(file[0].s, 'a+b-c');
    sendUpdate();
    webview.replaceCurrent();
    applyPostedEdits();
    assert.strictEqual(file[0].s, 'a+b+c');
}

// --- values keep their meaning --------------------------------------------------

{
    load([{ s: 'bob', n: 100, path: 'C:\\temp\\x', q: 'say "hi"', o: { bob: 1 } }], ['s', 'n', 'path', 'q', 'o']);

    find('bob', 'say "hi"');
    // The object cell matches too, but is left alone
    assert.strictEqual(webview.findState().matches.length, 2);
    webview.replaceAll();
    applyPostedEdits();
    assert.strictEqual(file[0].s, 'say "hi"', 'quotes in the replacement stay text');
    assert.deepStrictEqual(file[0].o, { bob: 1 }, 'objects are not replaced into');
    sendUpdate();

    // Strings are searched without their JSON quotes and escapes
    find('C:\\temp');
    assert.strictEqual(webview.findState().matches.length, 1);
    find('say "hi"');
    assert.strictEqual(webview.findState().matches.length, 2);

    // A string that comes to look like a number is still a string
    find('say "hi"', '42');
    webview.replaceAll();
    applyPostedEdits();
    assert.strictEqual(file[0].s, '42');
    assert.strictEqual(file[0].q, '42');
    sendUpdate();

    // A number stays a number while the text still is one...
    find('100', '250');
    webview.replaceAll();
    applyPostedEdits();
    assert.strictEqual(file[0].n, 250);
    sendUpdate();
    // ...and becomes text once it isn't
    find('250', 'n/a');
    webview.replaceAll();
    applyPostedEdits();
    assert.strictEqual(file[0].n, 'n/a');
}

// --- bare values: falsy rows are rows -------------------------------------------

{
    load([0, 'zero', false], ['(value)']);
    find('0', '5');
    assert.strictEqual(webview.findState().matches.length, 1);
    assert.strictEqual(webview.findState().matches[0].actualRowIndex, 0);
}

// --- Ctrl/Cmd+F style opening never closes an open bar -------------------------

{
    find('x');
    webview.openFindReplaceBar(true);
    assert.strictEqual($('findReplaceBar').style.display, 'block');
    webview.openFindReplaceBar(false); // the toolbar button toggles
    assert.strictEqual($('findReplaceBar').style.display, 'none');
}

console.log('findReplace tests passed');
