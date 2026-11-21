const { timingSafeEqual } = require('node:crypto');

const TYPE = 'subjective';
const MAX_FILES = 10;
const MAX_BYTES = 20_000_000;
const MAX_COMMENT = 4000;

function equalToken(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(actual);
    return left.length === right.length && timingSafeEqual(left, right);
}

function fileName(value) {
    const safe = (value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return (safe === '.' || safe === '..' ? '' : [...safe].slice(0, 150).join('')) || 'attachment';
}

function normalizeFiles(fields) {
    const files = Object.values(fields || {}).flat();
    if (!files.length || files.length > MAX_FILES || !Object.hasOwn(fields, 'attachments') || Object.keys(fields).length !== 1) {
        throw new Error('请选择 1–10 个文件。');
    }
    let size = 0;
    for (const file of files) {
        if (!Number.isSafeInteger(file?.size) || file.size < 0 || typeof file.filepath !== 'string') throw new Error('附件无效。');
        size += file.size;
    }
    if (size > MAX_BYTES) throw new Error('所有附件合计不能超过 20 MB。');
    return files.map((file) => ({ path: file.filepath, name: fileName(file.originalFilename), size: file.size }));
}

function gradeInput({ revision, score, comment }) {
    const numeric = (value) => typeof value === 'string' || typeof value === 'number';
    if (!numeric(revision) || !/^(0|[1-9]\d*)$/.test(String(revision)) || !Number.isSafeInteger(+revision)) {
        throw new Error('评分版本无效，请刷新后重试。');
    }
    if (!numeric(score) || !/^(0|[1-9]\d?|100)$/.test(String(score))) throw new Error('请输入 0–100 的整数分。');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > MAX_COMMENT)) {
        throw new Error('评语最多 4000 个字符。');
    }
    return { revision: +revision, score: +score, comment: (comment || '').trim() };
}

module.exports = { TYPE, MAX_FILES, MAX_BYTES, MAX_COMMENT, equalToken, normalizeFiles, gradeInput };
