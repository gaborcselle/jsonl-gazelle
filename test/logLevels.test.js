const assert = require('assert');
const { getLogLevelCategory, isLogLevelColumn } = require('../out/jsonl/logLevels');
const { scripts } = require('../out/webview/scripts');
const { styles } = require('../out/webview/styles');

// The webview cannot import from src/jsonl, so it carries a copy of the helpers.
// Pull that copy out of the script string and run the same cases against both.
const START = '// --- shared:log-levels';
const END = '// --- end shared:log-levels';
const startIndex = scripts.indexOf(START);
const endIndex = scripts.indexOf(END);
assert.ok(startIndex !== -1 && endIndex > startIndex, 'webview scripts must contain the shared:log-levels block');

const webviewSource = scripts.slice(scripts.indexOf('\n', startIndex), endIndex);
const webview = new Function(webviewSource + '\nreturn { getLogLevelCategory, isLogLevelColumn };')();

const columnCases = [
    ['level', true],
    ['Level', true],
    ['LEVEL', true],
    ['loglevel', true],
    ['log_level', true],
    ['levelname', true],
    ['severity', true],
    ['SeverityText', true],
    ['lvl', true],
    ['log.level', true],
    ['meta.severity', true],
    ['items[0].level', true],
    ['status', false],
    ['message', false],
    ['level.name', false],
    ['levels', false],
    ['', false],
    [undefined, false]
];

const valueCases = [
    ['level', 'error', 'error'],
    ['level', 'ERROR', 'error'],
    ['level', ' Warn ', 'warn'],
    ['level', 'warning', 'warn'],
    ['level', 'info', 'info'],
    ['level', 'INFO', 'info'],
    ['level', 'notice', 'info'],
    ['level', 'debug', 'debug'],
    ['level', 'trace', 'debug'],
    ['levelname', 'CRITICAL', 'error'],
    ['severity', 'fatal', 'error'],
    ['severity', 'err', 'error'],
    // pino / bunyan numeric levels
    ['level', 10, 'debug'],
    ['level', 20, 'debug'],
    ['level', 30, 'info'],
    ['level', 40, 'warn'],
    ['level', 50, 'error'],
    ['level', 60, 'error'],
    // numbers outside the pino range are not guessed at
    ['level', 3, null],
    ['level', 0, null],
    ['level', 100, null],
    ['level', NaN, null],
    // not a level word
    ['level', 'something', null],
    ['level', '', null],
    ['level', 'constructor', null],
    ['level', 'hasOwnProperty', null],
    ['level', null, null],
    ['level', true, null],
    ['level', { name: 'error' }, null],
    ['level', ['error'], null],
    // the right word in the wrong column is left alone
    ['status', 'error', null],
    ['message', 'warning', null]
];

for (const [impl, label] of [[{ getLogLevelCategory, isLogLevelColumn }, 'src/jsonl'], [webview, 'webview']]) {
    for (const [path, expected] of columnCases) {
        assert.strictEqual(impl.isLogLevelColumn(path), expected, `${label}: isLogLevelColumn(${JSON.stringify(path)})`);
    }
    for (const [path, value, expected] of valueCases) {
        assert.strictEqual(
            impl.getLogLevelCategory(path, value),
            expected,
            `${label}: getLogLevelCategory(${JSON.stringify(path)}, ${String(value)})`
        );
    }
}

// The table must actually use the helper, and every category needs a style
assert.ok(/td\.classList\.add\('log-level-' \+ logLevel\)/.test(scripts), 'createTableRow applies the log-level class');
for (const category of ['error', 'warn', 'info', 'debug']) {
    assert.ok(styles.includes(`td.log-level-${category}`), `styles define td.log-level-${category}`);
}

console.log('logLevels tests passed');
