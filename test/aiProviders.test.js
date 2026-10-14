const assert = require('assert');
const { chatCompletion } = require('../out/aiProviders');

// The providers are plain fetch calls; stub fetch to see what is sent.

function response(status, body) {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
        clone() { return response(status, body); }
    };
}

(async () => {
    // A model that only takes its default temperature: asked again without one
    const sent = [];
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body);
        if ('temperature' in body) {
            return response(400, { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.", param: 'temperature' } });
        }
        return response(200, { choices: [{ message: { content: 'ok' } }] });
    };
    assert.strictEqual(await chatCompletion('openai', 'key', 'o4-mini', { prompt: 'hi', temperature: 0.7 }), 'ok');
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].temperature, 0.7);
    assert.ok(!('temperature' in sent[1]));

    // Any other 400 is reported, not retried
    sent.length = 0;
    global.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return response(400, { error: { message: 'Invalid schema' } });
    };
    await assert.rejects(chatCompletion('openai', 'key', 'gpt-x', { prompt: 'hi', temperature: 0.7 }), /OpenAI API error: 400/);
    assert.strictEqual(sent.length, 1);

    // A local model's code fence is stripped whatever case its language tag is in
    for (const fence of ['json', 'JSON', 'Json', '']) {
        global.fetch = async () => response(200, { choices: [{ message: { content: '```' + fence + '\n{"value":"a"}\n```' } }] });
        assert.strictEqual(
            await chatCompletion('local', '', 'llama', { prompt: 'hi', schema: { type: 'object' }, schemaName: 's' }, 'http://localhost:1234/v1'),
            '{"value":"a"}',
            'fence ' + JSON.stringify(fence)
        );
    }

    console.log('aiProviders tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
