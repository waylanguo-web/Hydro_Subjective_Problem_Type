import { addPage, NamedPage } from '@hydrooj/ui-default';
import './subjective.css';

function mountUpload() {
    const form = document.querySelector('[data-subjective-upload]');
    if (!form || form.dataset.mounted) return;
    form.dataset.mounted = 'true';
    const input = form.elements.attachments;
    const drop = form.querySelector('[data-subjective-drop]');
    const list = form.querySelector('[data-subjective-files]');
    const size = form.querySelector('[data-subjective-size]');
    const progress = form.querySelector('[data-subjective-progress]');
    const error = form.querySelector('[data-subjective-error]');
    const submit = form.querySelector('button[type="submit"]');
    let files = [];
    let busy = false;

    const totalBytes = () => files.reduce((total, file) => total + file.size, 0);
    const formatBytes = (bytes) => `${bytes.toLocaleString()} B`;
    const validate = () => {
        if (files.length < 1 || files.length > Number(form.dataset.maxFiles)) return form.dataset.fileLimit;
        if (totalBytes() > Number(form.dataset.maxBytes)) return form.dataset.sizeLimit;
        return '';
    };
    function refresh() {
        list.textContent = '';
        for (const [index, file] of files.entries()) {
            const item = document.createElement('li');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'link';
            remove.textContent = form.dataset.remove;
            remove.setAttribute('aria-label', `${form.dataset.remove} ${file.name}`);
            remove.disabled = busy;
            remove.addEventListener('click', () => {
                files.splice(index, 1);
                refresh();
            });
            item.append(document.createTextNode(`${file.name} · ${formatBytes(file.size)} `), remove);
            list.append(item);
        }
        size.textContent = `${formatBytes(totalBytes())} / 20 MB · ${files.length} / ${form.dataset.maxFiles}`;
        error.textContent = files.length ? validate() : '';
        submit.disabled = busy || !!validate();
        input.disabled = busy;
    }

    input.required = false;
    input.addEventListener('change', () => {
        files.push(...input.files);
        input.value = '';
        refresh();
    });
    drop.addEventListener('dragover', (event) => event.preventDefault());
    drop.addEventListener('drop', (event) => {
        event.preventDefault();
        if (!busy) {
            files.push(...event.dataTransfer.files);
            refresh();
        }
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (busy || validate()) return;
        const body = new FormData(form);
        body.delete('attachments');
        for (const file of files) body.append('attachments', file);
        busy = true;
        progress.hidden = false;
        progress.value = 0;
        refresh();
        const request = new XMLHttpRequest();
        request.open('POST', form.action);
        request.setRequestHeader('Accept', 'application/json');
        request.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) progress.value = (100 * event.loaded) / event.total;
        });
        const retry = (message) => {
            busy = false;
            progress.hidden = true;
            refresh();
            error.textContent = message || form.dataset.uploadError;
        };
        request.addEventListener('load', () => {
            let result;
            try { result = JSON.parse(request.responseText); } catch { /* A proxy may return an HTML error. */ }
            if (request.status >= 200 && request.status < 300 && typeof result?.url === 'string') {
                window.location.assign(result.url);
            } else if (request.status === 413) retry(form.dataset.sizeLimit);
            else retry(result?.error?.message);
        });
        request.addEventListener('error', () => retry());
        request.addEventListener('abort', () => retry());
        request.send(body);
    });
    refresh();
}

addPage(new NamedPage('subjective_submit', mountUpload));
