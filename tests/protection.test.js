const assert = require('node:assert/strict');
const test = require('node:test');
const { protectManualRecords } = require('..');

test('native reset and judge preserve regular batches while excluding manual records', async () => {
    const records = {
        a: { _id: 'a', pid: 1, lang: 'cc' },
        b: { _id: 'b', pid: 1, lang: 'subjective' },
        c: { _id: 'c', pid: 2, lang: 'cc' },
    };
    const calls = [];
    const reset = async (...args) => calls.push(['reset', ...args]);
    const judge = async (...args) => calls.push(['judge', ...args]);
    const model = {
        reset, judge,
        get: async (_domain, id) => records[id],
        getMulti(_domain, { _id, lang }) {
            return { project: () => ({ toArray: async () => _id.$in.map((id) => records[id]).filter((doc) => doc?.lang === lang) }) };
        },
    };
    let dispose;
    protectManualRecords({ effect: (cb) => { dispose = cb(); } }, model,
        { get: async (_domain, pid) => ({ config: { type: pid === 1 ? 'default' : 'subjective' } }) });
    await model.reset('site', ['a', 'b'], true);
    await model.judge('site', ['a', 'b'], 42);
    await model.reset('site', 'b', true);
    await model.judge('site', records.b, 42);
    await model.judge('site', 'c', 42);
    assert.deepEqual(calls, [['reset', 'site', ['a'], true], ['judge', 'site', ['a'], 42]]);
    dispose();
    assert.equal(model.reset, reset);
    assert.equal(model.judge, judge);
});
