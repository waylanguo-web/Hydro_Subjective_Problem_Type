const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
if (!process.argv[2]) throw new Error('Pass the path to a built Hydro 5.1.0 source checkout.');
const upstream = path.resolve(process.argv[2]);
const plugin = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(upstream, 'package.json'));
const { MongoMemoryServer } = localRequire('mongodb-memory-server');
const request = localRequire('supertest');

(async () => {
    const testingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'test-hydro-subjective-'));
    os.homedir = () => testingHome;
    process.env.DEFAULT_STORE_PATH = path.join(testingHome, 'files');
    process.env.NODE_APP_INSTANCE = '0';
    if (process.platform === 'win32') {
        // The upstream addon builder escapes path separators but emits Windows imports as package specifiers.
        const esbuild = localRequire('esbuild');
        const esbuildPath = localRequire.resolve('esbuild');
        require.cache[esbuildPath].exports = { ...esbuild, build(options) {
            if (options.stdin?.contents) options.stdin.contents = options.stdin.contents.replace(/\\\\/g, '/');
            return esbuild.build(options);
        } };
    }
    const mongo = await MongoMemoryServer.create();
    try {
        const config = path.join(testingHome, '.hydro');
        fs.mkdirSync(config);
        const addons = [path.join(upstream, 'packages/ui-default'), process.env.HYDRO_RMJ_ADDON, plugin].filter(Boolean);
        fs.writeFileSync(path.join(config, 'addon.json'), JSON.stringify(addons));
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ url: mongo.getUri('test-subjective') }));
        const ready = new Promise((resolve) => { process.send = (message) => { if (message === 'ready') resolve(); }; });
        process.argv = [process.execPath, 'hydrooj', '--port', process.env.HYDRO_TEST_PORT || '21839'];
        localRequire('hydrooj/bin/hydrooj');
        await ready;
        const h = localRequire('hydrooj');
        const site = 'system';
        const requestTo = request(h.httpServer);
        const db = h.db;
        await h.UserModel.create('student@example.test', 'student-fixture', 'test123456', 2);
        await h.UserModel.create('reviewer@example.test', 'reviewer-fixture', 'test123456', 3);
        await h.UserModel.create('other@example.test', 'other-fixture', 'test123456', 4);
        await h.UserModel.create('peer@example.test', 'peer-fixture', 'test123456', 5);
        await h.UserModel.create('site@example.test', 'site-admin-fixture', 'test123456', 6);
        await h.UserModel.setSuperAdmin(6);
        await h.DomainModel.setUserRole(site, 2, 'default', true);
        await h.DomainModel.setUserRole(site, 3, 'root', true);
        await h.DomainModel.setUserRole(site, 4, 'default', true);
        await h.DomainModel.setUserRole(site, 5, 'default', true);
        await h.DomainModel.add('another', 4, 'Another', 'Another');
        async function cookie(uid) {
            const [token] = await h.TokenModel.add(h.TokenModel.TYPE_SESSION, 3600, { uid, scope: h.PERM.PERM_ALL.toString() });
            return `sid=${token}`;
        }
        const student = await cookie(2);
        const reviewer = await cookie(3);
        const outsider = await cookie(4);
        const peer = await cookie(5);
        const siteAdmin = await cookie(6);
        const pid = await h.ProblemModel.add(site, '', 'Subjective fixture', 'Statement', 2);
        const manual = await h.ProblemModel.get(site, pid);
        if (process.env.HYDRO_RMJ_ADDON) {
            await h.ProblemModel.addTestdata(site, manual.docId, 'rmj.yaml', Buffer.from('enabled: true\nplatform: codeforces\ntarget: 1:A\n'), 3);
            await requestTo.post(`/p/${manual.docId}/files`).set('Cookie', reviewer).set('Accept', 'application/json')
                .field('type', 'testdata').field('operation', 'upload_file').field('filename', 'config.yaml')
                .attach('file', Buffer.from('type: subjective\n'), 'config.yaml').expect(400);
            await h.ProblemModel.addTestdata(site, manual.docId, 'rmj.yaml', Buffer.from('enabled: false\n'), 3);
        }
        await requestTo.post(`/p/${manual.docId}/files`).set('Cookie', reviewer).set('Accept', 'application/json')
            .field('type', 'testdata').field('operation', 'upload_file').field('filename', 'config.yaml')
            .attach('file', Buffer.from('type: subjective\n'), 'config.yaml').expect(200);
        for (let i = 0; i < 50 && (await h.ProblemModel.get(site, manual.docId)).config.type !== 'subjective'; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal((await h.ProblemModel.get(site, manual.docId)).config.type, 'subjective');
        const editor = await requestTo.get(`/p/${manual.docId}/config`).set('Cookie', reviewer).set('Accept', 'application/json').expect(200);
        assert.match(editor.body.config, /^type: subjective/m);
        const submit = `/p/${manual.docId}/submit`;
        const getForm = (page, who) => requestTo.get(page).set('Cookie', who).set('Accept', 'application/json').expect(200);
        const multipart = (url, who, nonce, csrf, files) => {
            let pending = requestTo.post(url).set('Cookie', who).set('Accept', 'application/json')
                .field('subjectiveCsrf', csrf).field('submissionNonce', nonce);
            for (const [bytes, name] of files) pending = pending.attach('attachments', bytes, name);
            return pending;
        };
        const homework = await h.ContestModel.add(site, 'Homework fixture', '', 3, 'homework', new Date(Date.now() - 2500),
            new Date(Date.now() + 10 * 60_000), [manual.docId], false, { penaltySince: new Date(Date.now() + 300_000), penaltyRules: {} });
        const homeworkPath = `${submit}?tid=${homework}`;
        const comp = await h.ContestModel.add(site, 'Contest fixture', '', 3, 'oi', new Date(Date.now() - 2500),
            new Date(Date.now() + 10 * 60_000), [manual.docId]);
        await requestTo.get(homeworkPath).set('Cookie', student).set('Accept', 'application/json').expect(403);
        await h.ContestModel.attend(site, homework, 2, { startAt: new Date(Date.now() - 1000) });
        await h.ContestModel.attend(site, comp, 2, { startAt: new Date(Date.now() - 1000) });
        await requestTo.get(`${submit}?tid=${comp}`).set('Cookie', student).set('Accept', 'application/json').expect(400);
        const submittedFiles = [[Buffer.from('answer'), '中文.txt'], [Buffer.from('<html>'), 'answer.html']];
        const f = (await getForm(homeworkPath, student)).body;
        assert.ok(f.subjectiveCsrf && f.submissionNonce);
        const first = await multipart(homeworkPath, student, f.submissionNonce, f.subjectiveCsrf, submittedFiles).expect(200);
        assert.match(first.body.url, /^\/record\//);
        const same = await multipart(homeworkPath, student, f.submissionNonce, f.subjectiveCsrf, submittedFiles).expect(200);
        assert.equal(first.body.rid, same.body.rid);
        const resultPath = first.body.url;
        const page = (await getForm(resultPath, student)).body;
        assert.equal(page.graded, false);
        assert.deepEqual(page.attachments.map((file) => file.name).sort(), ['answer.html', '中文.txt']);
        await requestTo.get(homeworkPath).set('Cookie', student).set('Accept-Language', 'en').expect(200).expect(/data-subjective-upload/);
        await requestTo.get(resultPath).set('Cookie', student).set('Accept-Language', 'en').expect(200).expect(/Awaiting grading/);
        const download = page.attachments.find((file) => file.name === 'answer.html').url;
        await requestTo.get(download).set('Cookie', student).expect(200).expect('Content-Type', /application\/octet-stream/)
            .expect('Content-Disposition', /attachment;.*answer\.html/);
        await requestTo.get(download).set('Cookie', peer).set('Accept', 'application/json').expect(403);
        await requestTo.get(`${download}?domainId=system`).set('Cookie', outsider).set('Accept', 'application/json').expect(403);
        await requestTo.get(`/d/another${download}?domainId=system`).set('Cookie', outsider).set('Accept', 'application/json').expect(404);
        const toGrade = (await getForm(resultPath, reviewer)).body;
        assert.equal(toGrade.canGrade, true);
        assert.equal((await getForm(resultPath, siteAdmin)).body.canGrade, true);
        const gradeWith = (form, who, score, comment) => requestTo.post(form.gradeUrl).set('Cookie', who)
            .set('Accept', 'application/json').send({ subjectiveCsrf: form.subjectiveCsrf, revision: form.revision, score, comment });
        await gradeWith(toGrade, student, 100, 'bypass').expect(403);
        const queue = await getForm('/subjective/queue', reviewer);
        assert.equal(queue.body.entries[0]._id, first.body.rid);
        await requestTo.get('/record').set('Cookie', reviewer).set('Accept-Language', 'en').expect(200).expect(/Subjective grading queue/);
        await gradeWith(toGrade, reviewer, 100, 'Well done').expect(200);
        await gradeWith(toGrade, reviewer, 100, 'Well done').expect(200);
        assert.equal((await getForm(resultPath, reviewer)).body.history.length, 1);
        assert.equal((await h.ContestModel.getStatus(site, homework, 2)).score, 100);
        await gradeWith(toGrade, reviewer, 90, 'Stale').expect(409);
        const f2 = (await getForm(homeworkPath, student)).body;
        const second = await multipart(homeworkPath, student, f2.submissionNonce, f2.subjectiveCsrf, submittedFiles).expect(200);
        let state = await h.ContestModel.getStatus(site, homework, 2);
        assert.equal(state.score, 0);
        assert.equal(state.detail[manual.docId].rid.toString(), second.body.rid);
        const oldVersion = (await getForm(resultPath, reviewer)).body;
        await gradeWith(oldVersion, reviewer, 35, 'Updated old copy').expect(200);
        assert.equal((await h.ContestModel.getStatus(site, homework, 2)).score, 0);
        const newest = (await getForm(second.body.url, reviewer)).body;
        await gradeWith(newest, reviewer, 88, 'Current copy').expect(200);
        state = await h.ContestModel.getStatus(site, homework, 2);
        assert.equal(state.score, 88);
        assert.equal(state.journal.length, 2);
        await requestTo.post(resultPath).set('Cookie', reviewer).set('Accept', 'application/json').send({ operation: 'rejudge' }).expect(400);
        await requestTo.post(resultPath).set('Cookie', reviewer).set('Accept', 'application/json').send({ operation: 'cancel' }).expect(400);
        await requestTo.post(`/p/${manual.docId}`).set('Cookie', reviewer).set('Accept', 'application/json').send({ operation: 'rejudge' }).expect(400);
        assert.equal(await db.collection('task.task').countDocuments({ rid: { $in: [new h.ObjectId(first.body.rid), new h.ObjectId(second.body.rid)] } }), 0);
        const personal = (await getForm(resultPath, student)).body;
        assert.equal(personal.score, 35);
        assert.equal(personal.comment, 'Updated old copy');
        assert.equal(personal.history, undefined);
        const large = (await getForm(submit, student)).body;
        await multipart(submit, student, large.submissionNonce, large.subjectiveCsrf, [[Buffer.alloc(20_000_001), 'large.bin']])
            .expect(400);
        const countFiles = () => h.StorageModel.coll.countDocuments({ path: /^subjective\//, autoDelete: null });
        const beforeFailure = await countFiles();
        const put = h.StorageModel.put;
        h.StorageModel.put = function (key, ...args) {
            if (key.startsWith('subjective/') && key.endsWith('/1')) throw new Error('Simulated storage failure');
            return put.call(this, key, ...args);
        };
        try { await multipart(submit, student, large.submissionNonce, large.subjectiveCsrf, submittedFiles).expect(500); }
        finally { h.StorageModel.put = put; }
        assert.equal(await countFiles(), beforeFailure);
        const exact = await multipart(submit, student, large.submissionNonce, large.subjectiveCsrf,
            Array.from({ length: 10 }, (_, i) => [Buffer.alloc(2_000_000, i), `data${i}.bin`])).expect(200);
        const record = await getForm(exact.body.url, student);
        assert.equal(record.body.attachments.length, 10);
        const practiceGrade = (await getForm(exact.body.url, reviewer)).body;
        await gradeWith(practiceGrade, reviewer, 0, 'Needs revision').expect(200);
        assert.equal((await getForm(exact.body.url, student)).body.score, 0);
        await h.ContestModel.edit(site, homework, { endAt: new Date(Date.now() - 1000) });
        await requestTo.get(homeworkPath).set('Cookie', student).set('Accept', 'application/json').expect(403);
        console.log('SUBJECTIVE_SMOKE_OK');
    } finally {
        await mongo.stop({ doCleanup: true });
    }
})().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
