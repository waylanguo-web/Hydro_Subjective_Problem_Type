const { randomUUID } = require('node:crypto');
const { TYPE } = require('./rules');

// Keep private attachments and the grade audit trail out of native record queries and sockets.
function synchronizer(ctx, hydro, submissions) {
    const { RecordModel, ContestModel, ProblemModel, DocumentModel, STATUS } = hydro;

    async function sync(id) {
        const now = new Date();
        const owner = randomUUID();
        const submission = await submissions.findOneAndUpdate({
            _id: id, dirty: true,
            $or: [{ syncingUntil: { $exists: false } }, { syncingUntil: { $lte: now } }],
        }, { $set: { syncingUntil: new Date(+now + 120_000), syncingBy: owner } }, { returnDocument: 'after' });
        if (!submission) return;
        const { domainId, uid, pid, contest, team, latest, revision } = submission;
        const status = !latest ? STATUS.STATUS_WAITING
            : latest.score === 100 ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER;
        const native = { status, score: latest?.score ?? 0, judgeAt: latest?.at ?? null, judger: latest?.by ?? null };
        try {
            await RecordModel.coll.updateOne({ _id: id, domainId }, {
                $setOnInsert: { uid, pid, lang: TYPE, code: '', time: 0, memory: 0, judgeTexts: [], compilerTexts: [],
                    testCases: [], rejudged: false, ...(contest ? { contest } : {}) },
                $set: native,
            }, { upsert: true });

            if (contest) {
                // Hydro keys journal items by record ID and sorts them by original submission time.
                const updated = await ContestModel.updateStatus(domainId, contest, team ?? uid, id, pid, { ...native, lang: TYPE });
                if (!updated) throw new Error('Homework status changed during synchronization.');
            } else if (latest) {
                const [current, best] = await Promise.all([
                    ProblemModel.getStatus(domainId, pid, uid),
                    RecordModel.getMulti(domainId, { pid, uid, lang: TYPE, contest: null, judgeAt: { $ne: null } })
                        .sort({ score: -1, _id: -1 }).limit(1).next(),
                ]);
                const previous = current?.rid && await RecordModel.get(domainId, current.rid);
                if (best && (previous?.lang === TYPE || (current?.score ?? 0) <= best.score)) {
                    await DocumentModel.setStatus(domainId, DocumentModel.TYPE_PROBLEM, pid, uid,
                        { rid: best._id, status: best.status, score: best.score });
                }
            }

            const record = await RecordModel.get(domainId, id);
            if (record) ctx.broadcast('record/change', record);
            await submissions.updateOne({ _id: id, revision, syncingBy: owner }, { $set: { dirty: false } });
        } finally {
            await submissions.updateOne({ _id: id, syncingBy: owner }, { $unset: { syncingUntil: '', syncingBy: '' } });
        }
    }

    async function retry() {
        const now = new Date();
        const pending = await submissions.find({ dirty: true,
            $or: [{ syncingUntil: { $exists: false } }, { syncingUntil: { $lte: now } }],
        }).sort({ lastAttemptAt: 1, _id: 1 }).limit(25).toArray();
        for (const entry of pending) {
            await submissions.updateOne({ _id: entry._id, dirty: true }, { $set: { lastAttemptAt: now } });
            try { await sync(entry._id); }
            catch (error) { console.error('[subjective] Unable to synchronize record', String(entry._id), error.message); }
        }
    }

    return { sync, retry };
}

module.exports = { synchronizer };
