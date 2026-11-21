const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const [ui, destination] = process.argv.slice(2);
if (!ui || !destination) throw new Error('Pass the built UI directory and an output template path.');

const { version } = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ui, 'public', 'manifest.json'), 'utf8'));
const bootstrap = new URL(manifest[`hydro-${version}.js`] || '/', 'https://hydro.invalid');
const revision = bootstrap.search.slice(1);
if (!/^[a-f\d]{6,64}$/i.test(revision)) throw new Error('The Hydro manifest is missing the bootstrap content hash.');

const template = readFileSync(join(ui, 'templates', 'layout', 'html5.html'), 'utf8')
    .replace(/\?version=dev\{% else %\}\?v=[a-f\d]{6,64}(?=\{% endif %\})/i, '?version=dev')
    .replace(/(\/lang-\{\{ _\('__id'\) \}\}\.js)\?v=\{\{ UiContext\.constantVersion \}\}/, '$1');
const original = "hydro-{{ global.Hydro.version['ui-default'] }}.js{% if process.env.DEV %}?version=dev{% endif %}";
if (template.split(original).length !== 2) throw new Error('The Hydro bootstrap script tag has changed.');
const locale = "/lang-{{ _('__id') }}.js";
if (template.split(locale).length !== 2) throw new Error('The Hydro locale script tag has changed.');
const updated = template
    .replace(original, original.replace('?version=dev', `?version=dev{% else %}?v=${revision}`))
    .replace(locale, `${locale}?v={{ UiContext.constantVersion }}`);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, updated);
