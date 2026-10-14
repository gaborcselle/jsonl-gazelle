const assert = require('assert');
const vm = require('vm');
const diff = require('../out/jsonl/diff');
const { getDiffViewHtml } = require('../out/webview/diffView');

// The diff view renders through DOM APIs only. Run its script against a
// minimal DOM, render what the extension would post, and read back the text.

class FakeNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.className = '';
        this.ownText = '';
        this.style = {};
        this.title = '';
        this.listeners = {};
        const node = this;
        this.classList = {
            toggle(name, force) {
                const names = new Set(node.className.split(' ').filter(Boolean));
                const on = force === undefined ? !names.has(name) : force;
                if (on) { names.add(name); } else { names.delete(name); }
                node.className = [...names].join(' ');
            }
        };
    }
    set textContent(text) { this.ownText = String(text); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    appendChild(child) {
        const added = child.tag === '#fragment' ? child.children.splice(0) : [child];
        for (const node of added) {
            node.parentNode = this;
            this.children.push(node);
        }
        return child;
    }
    replaceChild(child, old) {
        const added = child.tag === '#fragment' ? child.children.splice(0) : [child];
        added.forEach(node => { node.parentNode = this; });
        this.children.splice(this.children.indexOf(old), 1, ...added);
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    findAll(predicate, out = []) {
        for (const child of this.children) {
            if (predicate(child)) { out.push(child); }
            child.findAll(predicate, out);
        }
        return out;
    }
}

const html = getDiffViewHtml('NONCE');
const script = html.match(/<script nonce="NONCE">([\s\S]*?)<\/script>/)[1];
const elements = {};
const document = {
    createElement: tag => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
    getElementById: id => elements[id] || (elements[id] = new FakeNode('div'))
};
const window = { addEventListener() {} };
vm.runInNewContext(script, { document, window });

function render(oldText, newText, extra = {}) {
    const result = diff.computeJsonlDiff(oldText, newText);
    window.__renderDiff({
        leftLabel: 'old',
        rightLabel: 'new',
        note: '',
        summary: result.summary,
        rows: result.rows,
        lineEndingChanges: result.lineEndingChanges || null,
        ...extra
    });
    return elements.diffList;
}

const byClass = name => node => node.className.split(' ').includes(name);

// --- the Before/After panes keep the digits of integers beyond 2^53 and out of range literals ---
{
    window.__renderDiff({
        leftLabel: 'old', rightLabel: 'new', note: '',
        summary: { added: 0, removed: 0, modified: 1, unchanged: 0 },
        rows: [{
            type: 'modified', oldLineNumber: 1, newLineNumber: 1,
            oldText: '{"id":9007199254740993,"name":"a","v":1e400}',
            newText: '{"id":9007199254740992,"name":"b","v":-1e400}',
            fieldChanges: []
        }]
    });
    const panes = elements.diffList.findAll(node => node.tag === 'pre').map(pre => pre.textContent);
    assert.strictEqual(panes[0], '{\n  "id": 9007199254740993,\n  "name": "a",\n  "v": 1e400\n}');
    assert.strictEqual(panes[1], '{\n  "id": 9007199254740992,\n  "name": "b",\n  "v": -1e400\n}');
}

// --- ...and so do the field chips ---
{
    const list = render('{"id":9007199254740993,"name":"a","v":1e400}\n', '{"id":9007199254740992,"name":"b","v":1e400}\n');
    const row = list.findAll(byClass('modified'))[0];
    assert.ok(row, 'expected a modified row');
    const chips = row.findAll(byClass('chip')).map(chip => chip.textContent);
    assert.deepStrictEqual(chips, ['id:9007199254740993→9007199254740992', 'name:"a"→"b"']);
    const panes = row.findAll(node => node.tag === 'pre').map(pre => pre.textContent);
    assert.strictEqual(panes[0], '{\n  "id": 9007199254740993,\n  "name": "a",\n  "v": 1e400\n}');
}

// --- ordinary numbers are pretty printed as before; invalid lines shown as they are ---
{
    const list = render('{"id":1,"p":1.50,"n":"a"}\n', '{"id":1,"p":1.50,"n":"b"}\n');
    const panes = list.findAll(node => node.tag === 'pre').map(pre => pre.textContent);
    assert.strictEqual(panes[0], '{\n  "id": 1,\n  "p": 1.5,\n  "n": "a"\n}');
    window.__renderDiff({
        leftLabel: 'old', rightLabel: 'new', note: '',
        summary: { added: 0, removed: 0, modified: 1, unchanged: 0 },
        rows: [{ type: 'modified', oldLineNumber: 1, newLineNumber: 1, oldText: '{12345678901234567890:1}', newText: '{"a":1}', fieldChanges: [] }]
    });
    assert.strictEqual(elements.diffList.findAll(node => node.tag === 'pre')[0].textContent, '{12345678901234567890:1}');
}

// --- no row changed, but the texts differ: say what does ---
{
    const message = (oldText, newText) => {
        render(oldText, newText);
        assert.strictEqual(elements.diffEmpty.style.display, 'block');
        return elements.diffEmpty.textContent;
    };
    assert.match(message('{"a":1}\r\n', '{"a":1}\n'), /only the line endings differ/);
    assert.match(message('{"a":1}', '{"a":1}\n'), /only the newline at the end of the file differs/);
    assert.match(message('{"a":1}\r\n{"b":2}', '{"a":1}\n{"b":2}\n'), /only the line endings and the newline at the end of the file differ/);
    assert.match(message('{"a":1}\n', '{"a":1}\n'), /identical content/);
}

// --- the webview's copy of the number literal code matches src/jsonl/diff.ts ---
{
    const START = '// --- shared:number-literals';
    const END = '// --- end shared:number-literals';
    const startIndex = script.indexOf(START);
    const endIndex = script.indexOf(END);
    assert.ok(startIndex !== -1 && endIndex > startIndex, 'the diff view must contain the shared:number-literals block');
    const shared = new Function(script.slice(script.indexOf('\n', startIndex), endIndex) +
        '\nreturn { protectNumberLiterals: protectNumberLiterals, restoreNumberLiterals: restoreNumberLiterals };')();
    const cases = [
        '{"id":1,"name":"a"}',
        '{"id":9007199254740991}',
        '{"id":9007199254740992}',
        '{"id":-9007199254740993,"x":[12345678901234567890, 1e400, -1E+400, 1e-400, 1.5e3]}',
        '{"s":"12345678901234567890","t":"say \\"12345678901234567890\\" \\\\","n":12345678901234567890}',
        '[12345678901234567890]',
        '12345678901234567890',
        '{"a":1.0000000000000000000001,"b":100000000000000000000.0}',
        '{"a":0012345678901234567890}',
        '{"a":12345678901234567890e}',
        '{"m":"\\uE000","n":12345678901234567890}',
        '{"m":"' + String.fromCharCode(0xE000) + '","n":12345678901234567890}',
        '{"unterminated":"12345678901234567890'
    ];
    for (const text of cases) {
        const protectedText = diff.protectNumberLiterals(text);
        assert.strictEqual(shared.protectNumberLiterals(text), protectedText, 'protect: ' + text);
        assert.strictEqual(shared.restoreNumberLiterals(protectedText), diff.restoreNumberLiterals(protectedText), 'restore: ' + text);
        // Wrapping and unwrapping gives the text back
        assert.strictEqual(diff.restoreNumberLiterals(protectedText), text, 'round trip: ' + text);
    }
    // Only unsafe integers and out of range literals are wrapped
    assert.strictEqual(diff.protectNumberLiterals('{"a":9007199254740991,"b":1.5,"c":1e300}'), '{"a":9007199254740991,"b":1.5,"c":1e300}');
    assert.notStrictEqual(diff.protectNumberLiterals('{"a":9007199254740992}'), '{"a":9007199254740992}');
    // A line already holding the marker is left alone, so its strings never read as numbers
    assert.strictEqual(diff.protectNumberLiterals(cases[10]), cases[10]);
    assert.strictEqual(diff.protectNumberLiterals(cases[11]), cases[11]);
}

console.log('diffView tests passed');
