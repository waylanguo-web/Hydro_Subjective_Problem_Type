const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_BYTES, MAX_FILES, normalizeFiles, gradeInput, equalToken } = require('../lib/rules');

function file(size, name = '作业.txt') {
    return { size, originalFilename: name, filepath: '/temp/upload' };
}

test('accepts ten files of arbitrary format at the exact aggregate byte limit', () => {
    const fields = { attachments: Array.from({ length: MAX_FILES }, () => file(MAX_BYTES / MAX_FILES, '答题.html')) };
    const result = normalizeFiles(fields);
    assert.equal(result.length, 10);
    assert.equal(result.reduce((sum, item) => sum + item.size, 0), 20_000_000);
    assert.equal(result[0].name, '答题.html');
});

test('rejects missing files, extra upload fields, an eleventh file and one extra byte', () => {
    assert.throws(() => normalizeFiles());
    assert.throws(() => normalizeFiles({ attachments: [], file: file(1) }));
    assert.throws(() => normalizeFiles({ attachments: Array.from({ length: 11 }, () => file(1)) }));
    assert.throws(() => normalizeFiles({ attachments: [file(MAX_BYTES), file(1)] }));
});

test('accepts an empty attachment and preserves safe Unicode names', () => {
    assert.deepEqual(normalizeFiles({ attachments: file(0, 'folder\\试题\r\n ①.zip') }),
        [{ path: '/temp/upload', name: '试题 ①.zip', size: 0 }]);
});

test('requires a revision and an integer from 0 to 100', () => {
    assert.deepEqual(gradeInput({ revision: '0', score: '0', comment: '  评语  ' }), { revision: 0, score: 0, comment: '评语' });
    assert.deepEqual(gradeInput({ revision: 2, score: 100 }), { revision: 2, score: 100, comment: '' });
    for (const score of ['', '95.2', '101', '1e1', -1, null, [100]]) assert.throws(() => gradeInput({ revision: 0, score }));
    assert.throws(() => gradeInput({ revision: -1, score: 90 }));
    assert.throws(() => gradeInput({ revision: 0, score: 90, comment: 'A'.repeat(4001) }));
    assert.equal(equalToken('123', '123'), true);
    assert.equal(equalToken('123', '１２３'), false);
});
