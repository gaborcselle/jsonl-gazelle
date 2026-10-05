const assert = require('assert');
const { formatJsonlForSave, spaceOutJson, convertSingleQuotedStrings } = require('../out/jsonl/formatOnSave');

const both = { spaceOut: true, convertSingleQuotes: true };
const spaceOnly = { spaceOut: true, convertSingleQuotes: false };
const quotesOnly = { spaceOut: false, convertSingleQuotes: true };
const off = { spaceOut: false, convertSingleQuotes: false };

// Default (both off) leaves the text exactly as written
const original = '{"id":123}\n{ "a" :1 }\n{\'x\': 1}\n';
assert.strictEqual(formatJsonlForSave(original, off), original);

// Spacing inside objects, after colons and commas
assert.strictEqual(spaceOutJson('{"id":123}'), '{ "id": 123 }');
assert.strictEqual(spaceOutJson('{"a":{"b":[1,2,{"c":null}]},"d":{}}'), '{ "a": { "b": [1, 2, { "c": null }] }, "d": {} }');
assert.strictEqual(spaceOutJson('[]'), '[]');
assert.strictEqual(spaceOutJson('  {  "a"  :  1  ,"b":true}  '), '{ "a": 1, "b": true }');
// Already spaced is stable
assert.strictEqual(spaceOutJson('{ "id": 123 }'), '{ "id": 123 }');
// Strings are untouched, including braces, colons, escaped quotes and inner whitespace
assert.strictEqual(spaceOutJson('{"s":"a:b,{c}  \\"q\\" "}'), '{ "s": "a:b,{c}  \\"q\\" " }');
// Number spellings survive (no re-serialization)
assert.strictEqual(spaceOutJson('{"n":1.0,"big":12345678901234567890,"e":1E5}'), '{ "n": 1.0, "big": 12345678901234567890, "e": 1E5 }');
// Bare values
assert.strictEqual(spaceOutJson('"hello"'), '"hello"');
assert.strictEqual(spaceOutJson('42'), '42');

// Invalid lines are left alone by spacing
assert.strictEqual(formatJsonlForSave('{"a":1\n{"b":2}', spaceOnly), '{"a":1\n{ "b": 2 }');

// Single quotes become double quotes
assert.strictEqual(convertSingleQuotedStrings("{'id': 'a'}"), '{"id": "a"}');
assert.strictEqual(formatJsonlForSave("{'id': 'a'}", quotesOnly), '{"id": "a"}');
assert.strictEqual(formatJsonlForSave("{'id':'a'}", both), '{ "id": "a" }');
// Apostrophes inside double-quoted strings stay put
assert.strictEqual(formatJsonlForSave('{"name":"it\'s"}', quotesOnly), '{"name":"it\'s"}');
assert.strictEqual(formatJsonlForSave('{\'name\': "it\'s"}', quotesOnly), '{"name": "it\'s"}');
// Double quotes inside a single-quoted string get escaped; \' is unescaped
assert.strictEqual(formatJsonlForSave("{'q': 'say \"hi\"', 'a': 'don\\'t'}", quotesOnly), '{"q": "say \\"hi\\"", "a": "don\'t"}');
assert.deepStrictEqual(JSON.parse(formatJsonlForSave("{'q': 'say \"hi\"', 'a': 'don\\'t'}", quotesOnly)), { q: 'say "hi"', a: "don't" });
// A line the conversion can't fix stays as written
assert.strictEqual(formatJsonlForSave("{id: 'a'}", quotesOnly), "{id: 'a'}");
// Valid JSON lines are never touched by the quote conversion
assert.strictEqual(formatJsonlForSave('{"a":"\'x\'"}', quotesOnly), '{"a":"\'x\'"}');

// Line endings, blank lines and the trailing newline are preserved
assert.strictEqual(formatJsonlForSave('{"a":1}\r\n\r\n{\'b\':2}\r\n', both), '{ "a": 1 }\r\n\r\n{ "b": 2 }\r\n');

console.log('formatOnSave tests passed');
