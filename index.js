const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const yaml = require('js-yaml');
const { TYPE, MAX_FILES, MAX_BYTES, MAX_COMMENT, equalToken, normalizeFiles, gradeInput } = require('./lib/rules');
const { synchronizer } = require('./lib/sync');

async function install(ctx, hydro) {
    const { db, Handler, PERM, PRIV, RecordModel, ProblemModel, ContestModel, SystemModel, StorageModel,
        ObjectId, CreateError, UserFacingError, ForbiddenError, NotFoundError, RecordNotFoundError, ContestNotLiveError } = hydro;
    const submissions = db.collection('subjective.submissions');
    await submissions.createIndex({ submissionKey: 1 }, { unique: true });
    await submissions.createIndex({ domainId: 1, revision: 1, _id: 1 });
    await submissions.createIndex({ dirty: 1, lastAttemptAt: 1, _id: 1 });
    const { sync, retry } = synchronizer(ctx, hydro, submissions);
    ctx.interval(() => retry().catch((error) => console.error('[subjective] Retry failed', error.message)), 15_000);

    const canGrade = (h) => h.user.hasPriv(PRIV.PRIV_USER_PROFILE)
        && (h.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN) || h.user.hasPerm(PERM.PERM_EDIT_DOMAIN));
    const csrf = (h) => h.session.subjectiveCsrf ||= randomBytes(32).toString('hex');
    const isSubjective = (pdoc) => pdoc?.config?.type === TYPE;
    const InputError = CreateError('SubjectiveInputError', UserFacingError, function () { return this.params[0]; }, 400);
    const fail = (message) => { throw new InputError(message); };
    const requireAdmin = (h) => { if (!canGrade(h)) throw new ForbiddenError(); };
    const checkCsrf = (h) => {
        if (!equalToken(h.session.subjectiveCsrf, h.args.subjectiveCsrf)) fail('表单已过期，请刷新后重试。');
    };
    const objectId = (value) => {
        if (!/^[a-f\d]{24}$/i.test(String(value))) throw new NotFoundError();
        return new ObjectId(String(value));
    };
    async function findSubmission(h, id) {
        const record = await submissions.findOne({ _id: id, domainId: h.domain._id });
        if (!record) throw new RecordNotFoundError(id);
        return record;
    }

    async function showRecord(h, entry, reviewing = false) {
        const admin = canGrade(h);
        const isOwner = h.user._id === entry.uid;
        const { domainId, pid, uid, contest, _id, latest, revision } = entry;
        const [pdoc, tdoc, udoc] = await Promise.all([
            ProblemModel.get(domainId, pid),
            contest && ContestModel.get(domainId, contest),
            hydro.UserModel.getById(domainId, uid),
        ]);
        h.response.template = 'subjective_record.html';
        h.response.body = { pdoc, tdoc, udoc, rid: _id, score: latest?.score, graded: !!latest, canGrade: admin,
            comment: admin || isOwner ? latest?.comment : undefined,
            attachments: admin || isOwner ? entry.attachments.map(({ name, size }, index) => ({ name, size,
                url: h.url('subjective_attachment', { domainId, rid: _id, index }) })) : undefined,
            revision: admin ? revision : undefined, history: admin ? entry.history.slice().reverse() : undefined,
            gradeUrl: admin ? h.url('subjective_grade', { domainId, rid: _id }) : undefined,
            subjectiveCsrf: admin ? csrf(h) : undefined, maxComment: MAX_COMMENT,
            reviewing, reviewQueueUrl: reviewing ? h.url('subjective_queue', { domainId }) : undefined,
        };
        h.response.addHeader('Cache-Control', 'private, no-store');
    }

    function ensureSubmissionContext(h) {
        if (h.pdoc.domainId !== h.domain._id) throw new ForbiddenError();
        if (h.tdoc && h.tdoc.rule !== 'homework') fail('比赛内暂不开放主观题递交。');
        if (h.tdoc && !ContestModel.isOngoing(h.tdoc, h.tsdoc)) throw new ContestNotLiveError(h.tdoc.docId);
    }

    ctx.on('problem/get', (pdoc) => {
        if (!isSubjective(pdoc)) return;
        pdoc.config = { type: TYPE, langs: ['_'], hackable: false };
        // A legacy RMJ sidecar can still exist on an imported problem. It cannot grade a manual submission.
        if (pdoc.data?.some((file) => file.name === 'rmj.yaml')) pdoc.data = pdoc.data.filter((file) => file.name !== 'rmj.yaml');
        delete pdoc.rmjTarget;
    });

    ctx.on('handler/after/ProblemSubmit#get', (h) => {
        if (!isSubjective(h.pdoc)) return;
        ensureSubmissionContext(h);
        h.response.template = 'subjective_submit.html';
        h.response.body = { ...h.response.body, page_name: 'subjective_submit', subjectiveCsrf: csrf(h),
            submissionNonce: randomUUID(), maxFiles: MAX_FILES, maxBytes: MAX_BYTES };
    });

    ctx.on('handler/before/ProblemSubmit#post', async (h) => {
        if (!isSubjective(h.pdoc)) return;
        h.checkPriv(PRIV.PRIV_USER_PROFILE);
        ensureSubmissionContext(h);
        checkCsrf(h);
        if (h.args.operation || h.args.code || h.args.pretest) fail('请选择附件并正式递交。');
        const nonce = h.args.submissionNonce;
        if (typeof nonce !== 'string' || !/^[a-f\d-]{36}$/.test(nonce)) fail('表单已过期，请刷新后重试。');
        const domainId = h.domain._id;
        const uid = h.user._id;
        const pid = h.pdoc.docId;
        const contest = h.tdoc?.docId;
        const submissionKey = createHash('sha256').update(JSON.stringify([domainId, pid, uid, contest || null, nonce])).digest('hex');
        let entry = await submissions.findOne({ submissionKey });
        if (!entry) {
            let files;
            try { files = normalizeFiles(h.request.files); } catch (e) { fail(e.message); }
            await h.limitRate('add_record', 60, SystemModel.get('limit.submission_user'), '{{user}}');
            await h.limitRate('add_record', 60, SystemModel.get('limit.submission'));
            const attempt = randomUUID();
            const attachments = files.map(({ name, size }, index) => ({ name, size, key: `subjective/${attempt}/${index}` }));
            const cleanup = () => StorageModel.del(attachments.map(({ key }) => key), uid);
            try {
                for (const [index, file] of files.entries()) await StorageModel.put(attachments[index].key, file.path, uid);
                ensureSubmissionContext(h);
                const current = await ProblemModel.get(domainId, pid);
                const source = current?.reference
                    ? await ProblemModel.get(current.reference.domainId, current.reference.pid) : current;
                if (!isSubjective(source)) fail('题型已变更，请刷新后重试。');
            } catch (error) {
                await cleanup();
                throw error;
            }
            entry = { _id: new ObjectId(), submissionKey, domainId, pid, uid, attachments,
                ...(contest ? { contest, team: h.team ?? uid } : {}),
                revision: 0, history: [], dirty: true };
            try { await submissions.insertOne(entry); }
            catch (error) {
                // A failed acknowledgement may still have committed the insert. Check before deleting anything.
                const existing = await submissions.findOne({ submissionKey });
                if (!existing?._id.equals(entry._id)) await cleanup();
                if (!existing) throw error;
                entry = existing;
            }
        }
        await sync(entry._id);
        const record = await RecordModel.get(domainId, entry._id);
        if (!record) fail('递交正在保存，请使用当前表单重试。');
        h.response.body = { rid: entry._id };
        h.response.redirect = h.url('record_detail', { domainId, rid: entry._id });
        return 'after';
    });

    ctx.on('handler/after/RecordDetail#get', async (h) => {
        if (h.rdoc?.lang !== TYPE) return;
        await showRecord(h, await findSubmission(h, h.rdoc._id));
    });

    ctx.on('handler/before-prepare/RecordDetail#get', async (h) => {
        // Domain administrators may grade submissions even when a homework is still open.
        if (!canGrade(h) || !/^[a-f\d]{24}$/i.test(String(h.args.rid))) return;
        const entry = await submissions.findOne({ _id: objectId(h.args.rid), domainId: h.domain._id });
        if (!entry) return;
        if (h.args.download) throw new NotFoundError();
        await showRecord(h, entry);
        return 'after';
    });
    ctx.on('handler/before/RecordDetail#get', (h) => {
        if (h.rdoc?.lang === TYPE && h.args.download) throw new NotFoundError();
    });

    ctx.on('handler/before-operation/RecordDetail', (h) => {
        if (h.rdoc?.lang === TYPE) fail('请通过主观题评分面板更新成绩。');
    });

    ctx.on('handler/before-operation/ProblemDetail', (h) => {
        if (isSubjective(h.pdoc) && h.args.operation === 'rejudge') fail('主观题成绩由管理员评分。');
    });

    ctx.on('handler/before/ProblemHack', (h) => {
        if (h.rdoc?.lang === TYPE) fail('主观题记录不支持 Hack。');
    });

    class SubjectiveGradeHandler extends Handler {
        async post() {
            requireAdmin(this);
            checkCsrf(this);
            const id = objectId(this.args.rid);
            let grade;
            try { grade = gradeInput(this.args); } catch (error) { fail(error.message); }
            const entry = await findSubmission(this, id);
            const reviewing = this.args.reviewing === '1';
            const latest = { score: grade.score, comment: grade.comment, by: this.user._id, at: new Date() };
            const result = await submissions.updateOne({ _id: id, domainId: entry.domainId, revision: grade.revision }, {
                $set: { latest, dirty: true }, $inc: { revision: 1 }, $push: { history: latest },
            });
            if (!result.modifiedCount) {
                const current = await findSubmission(this, id);
                const sameWrite = current.revision === grade.revision + 1 && current.latest?.by === latest.by
                    && current.latest.score === latest.score && current.latest.comment === latest.comment;
                if (!sameWrite) {
                    this.response.status = 409;
                    await showRecord(this, current, reviewing);
                    this.response.body.gradeConflict = true;
                    return;
                }
            }
            try { await sync(id); } catch (error) { console.error('[subjective] Grade synchronization pending', String(id), error.message); }
            this.response.body = { rid: id };
            this.response.redirect = this.url(reviewing ? 'subjective_review' : 'record_detail', { domainId: entry.domainId, rid: id });
        }
    }

    class SubjectiveAttachmentHandler extends Handler {
        async get() {
            const entry = await findSubmission(this, objectId(this.args.rid));
            if (entry.uid !== this.user._id && !canGrade(this)) throw new ForbiddenError();
            const index = String(this.args.index);
            const attachment = /^\d$/.test(index) && entry.attachments[Number(index)];
            if (!attachment) throw new NotFoundError();
            this.response.addHeader('X-Content-Type-Options', 'nosniff');
            this.response.addHeader('Cache-Control', 'private, no-store');
            this.response.addHeader('Content-Length', String(attachment.size));
            this.binary(await StorageModel.get(attachment.key));
            const name = encodeURIComponent(attachment.name.toWellFormed()).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
            this.response.disposition = `attachment; filename="attachment"; filename*=UTF-8''${name}`;
        }
    }

    class SubjectiveQueueHandler extends Handler {
        async get() {
            requireAdmin(this);
            const { pid, tid } = this.args;
            const domainId = this.domain._id;
            const query = { domainId, revision: 0 };
            if (pid) {
                const problem = await ProblemModel.get(domainId, pid);
                if (!problem) fail('找不到该题目。');
                query.pid = problem.docId;
            }
            if (tid) query.contest = objectId(tid);
            if (this.args.after) query._id = { $gt: objectId(this.args.after) };
            const entries = await submissions.find(query, { projection: { pid: 1, contest: 1, uid: 1 } })
                .sort({ _id: 1 }).limit(51).toArray();
            const next = entries.length > 50 ? entries[49]._id : null;
            this.response.template = 'subjective_queue.html';
            this.response.body = { page_name: 'subjective_queue', entries: entries.slice(0, 50), filterPid: pid, filterTid: tid,
                nextUrl: next && this.url('subjective_queue', { query: { ...(pid ? { pid } : {}), ...(tid ? { tid } : {}), after: next } }) };
        }
    }

    class SubjectiveReviewHandler extends Handler {
        async get() {
            requireAdmin(this);
            await showRecord(this, await findSubmission(this, objectId(this.args.rid)), true);
        }
    }

    ctx.Route('subjective_grade', '/subjective/record/:rid/grade', SubjectiveGradeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_attachment', '/subjective/record/:rid/attachment/:index', SubjectiveAttachmentHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_queue', '/domain/subjective', SubjectiveQueueHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_review', '/domain/subjective/:rid', SubjectiveReviewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_queue_legacy', '/subjective/queue', SubjectiveQueueHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('DomainManage', 'subjective_queue', { family: 'Properties', icon: 'info' }, canGrade);
    ctx.on('handler/after/RecordList#get', (h) => {
        if (canGrade(h)) h.response.body.subjectiveQueueUrl = h.url('subjective_queue', { domainId: h.domain._id });
    });

    ctx.on('handler/before-operation/ProblemFiles', async (h) => {
        if (h.args.operation !== 'upload_file' || (h.args.type && h.args.type !== 'testdata')) return;
        const file = h.request.files?.file;
        const name = String(h.args.filename || file?.originalFilename || '').toLowerCase();
        if (!file || !['config.yaml', 'config.yml', 'rmj.yaml'].includes(name)) return;
        let config;
        try { config = yaml.load(await readFile(file.filepath, 'utf8')); } catch { return; }
        if (name === 'rmj.yaml') {
            if (isSubjective(h.pdoc) && config?.enabled === true) fail('请先将主观题切换为支持 RMJ 的题型。');
            return;
        }
        if (config?.type !== TYPE) return;
        const current = await ProblemModel.get(h.domain._id, h.pdoc.docId, undefined, true);
        const currentConfig = yaml.load(current?.config || '{}');
        let enabled = !!(config.rmj?.enabled || currentConfig?.rmj?.enabled || currentConfig?.type === 'rmj' || current?.rmjTarget);
        if (!enabled && current?.data?.some((f) => f.name === 'rmj.yaml')) {
            const stream = await StorageModel.get(`problem/${current.domainId}/${current.docId}/testdata/rmj.yaml`);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            enabled = yaml.load(Buffer.concat(chunks).toString())?.enabled === true;
        }
        if (enabled) fail('请先关闭这道题的 RMJ 远程评测。');
    });

    ctx.on('handler/before/RmjConfig#post', (h) => {
        if (h.args.mode !== 'rmj') return;
        return ProblemModel.get(h.domain._id, h.args.pid).then((pdoc) => {
            if (isSubjective(pdoc)) fail('请先将主观题切换为支持 RMJ 的题型。');
        });
    });

    protectManualRecords(ctx, RecordModel, ProblemModel);
}

function protectManualRecords(ctx, RecordModel, ProblemModel) {
    const reset = RecordModel.reset;
    const judge = RecordModel.judge;
    async function allowed(domainId, input) {
        if (input?.lang === TYPE) return null;
        const ids = Array.isArray(input) ? input : [input?._id ?? input];
        if (!ids.length) return null;
        const manual = await RecordModel.getMulti(domainId, { _id: { $in: ids }, lang: TYPE }).project({ _id: 1 }).toArray();
        if (!manual.length) return input;
        const blocked = new Set(manual.map(({ _id }) => String(_id)));
        return Array.isArray(input) ? input.filter((id) => !blocked.has(String(id))) : null;
    }
    RecordModel.reset = async function (domainId, records, ...args) {
        const permitted = await allowed(domainId, records);
        if (permitted && (!Array.isArray(permitted) || permitted.length)) return reset.call(this, domainId, permitted, ...args);
        return null;
    };
    RecordModel.judge = async function (domainId, records, ...args) {
        const permitted = await allowed(domainId, records);
        if (!permitted || (Array.isArray(permitted) && !permitted.length)) return null;
        const first = Array.isArray(permitted) ? await RecordModel.get(domainId, permitted[0])
            : permitted.pid === undefined ? await RecordModel.get(domainId, permitted) : permitted;
        if (first) {
            const problem = await ProblemModel.get(domainId, first.pid);
            const source = problem?.reference ? await ProblemModel.get(problem.reference.domainId, problem.reference.pid) : problem;
            if (source?.config?.type === TYPE) return null;
        }
        return judge.call(this, domainId, permitted, ...args);
    };
    const protectedReset = RecordModel.reset;
    const protectedJudge = RecordModel.judge;
    ctx.effect(() => () => {
        if (RecordModel.reset === protectedReset) RecordModel.reset = reset;
        if (RecordModel.judge === protectedJudge) RecordModel.judge = judge;
    });
}

module.exports = { apply: (ctx) => install(ctx, require('hydrooj')), install, protectManualRecords };
