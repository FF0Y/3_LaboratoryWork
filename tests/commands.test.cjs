const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-mock.cjs');
const { activate } = require('../.test-dist/extension.cjs');
const { LibraryStore, syncParameters, exportLibrary, parseLibrary } = require('../.test-dist/library.cjs');
const { registered, providers, answers, messages, files } = vscode._test;
let state, store;
const command = name => registered.get(`my-first-extension.${name}`)();
const first = items => items[0];
function sample(overrides = {}) {
    const body = overrides.body ?? 'function {{name}}() { return "$1"; }';
    return { id: 'sample', name: 'DFS', category: 'Графы', keywords: ['обход'], language: 'typescript', body, parameters: syncParameters(body), ...overrides };
}
function editor(body = 'selected') {
    const result = { inserted: undefined, selection: { isEmpty: false }, document: { version: 1, isClosed: false, languageId: 'typescript', eol: 1, getText: () => body },
        async edit(fn) { fn({ replace(_selection, content) { result.inserted = content; } }); return true; } };
    vscode.window.activeTextEditor = result; return result;
}
beforeEach(() => {
    vscode._test.reset();
    state = { data: undefined, get() { return this.data; }, async update(_key, data) { this.data = structuredClone(data); } };
    store = new LibraryStore(state);
    activate({ globalState: state, subscriptions: [] });
});
test('all manifest commands register and the library starts empty', () => {
    const manifest = require('../package.json');
    for (const { command: id } of manifest.contributes.commands) { assert.ok(registered.has(id), id); }
    assert.equal(store.read().templates.length, 0);
});
test('save selection captures category, keywords and parameter defaults', async () => {
    editor('function {{name}}() {}');
    answers.input.push('Новый шаблон', 'dfs, граф, dfs', 'Имя функции', 'walk');
    answers.pick.push(items => items.find(i => i.value === 'Графы'));
    await command('saveTemplate');
    const saved = store.read().templates[0];
    assert.equal(saved.category, 'Графы'); assert.deepEqual(saved.keywords, ['dfs', 'граф']);
    assert.equal(saved.parameters[0].defaultValue, 'walk'); assert.deepEqual(messages.error, []);
});
test('cancel save or insert does not mutate library or document', async () => {
    const target = editor(); answers.input.push(undefined); await command('saveTemplate');
    assert.equal(store.read().templates.length, 0);
    await store.add(sample()); answers.pick.push(first); answers.input.push(undefined);
    await command('insertTemplate'); assert.equal(target.inserted, undefined);
});
test('search enables name, category and keyword matching, parameters remain literal', async () => {
    await store.add(sample()); const target = editor();
    answers.pick.push(items => { assert.equal(items[0].description, 'Графы'); assert.match(items[0].detail, /обход/); return items[0]; });
    answers.input.push('$&{{other}}');
    await command('searchTemplates');
    assert.equal(target.inserted, 'function $&{{other}}() { return "$1"; }');
    assert.equal(messages.pickOptions[0].matchOnDescription, true); assert.equal(messages.pickOptions[0].matchOnDetail, true);
});
test('category picker filters the template list', async () => {
    await store.add(sample()); await store.add(sample({ id: 'other', name: 'Sort', category: 'Сортировки' })); editor();
    answers.pick.push(items => items.find(i => i === 'Сортировки'), items => { assert.equal(items.length, 1); assert.equal(items[0].label, 'Sort'); return items[0]; });
    answers.input.push('sort'); await command('browseCategories');
    assert.deepEqual(messages.error, []);
});
test('document changes during parameter prompt abort insertion', async () => {
    await store.add(sample()); const target = editor(); answers.pick.push(first);
    answers.input.push(() => { target.document.version++; return 'walk'; });
    await command('insertTemplate'); assert.equal(target.inserted, undefined); assert.match(messages.error[0], /изменился/);
});
test('rename persists and deletion requires confirmation', async () => {
    await store.add(sample()); answers.pick.push(first); answers.input.push('Поиск'); await command('renameTemplate');
    assert.equal(store.read().templates[0].name, 'Поиск');
    answers.pick.push(first); answers.warning.push(undefined); await command('deleteTemplate'); assert.equal(store.read().templates.length, 1);
    answers.pick.push(first); answers.warning.push('Удалить'); await command('deleteTemplate'); assert.equal(store.read().templates.length, 0);
});
test('virtual editor saves code and auto-discovers added parameters', async () => {
    await store.add(sample()); const provider = providers.get('algorithm-template');
    const uri = vscode.Uri.from({ scheme: 'algorithm-template', path: '/sample/template' });
    assert.match(Buffer.from(provider.readFile(uri)).toString(), /function/);
    await provider.writeFile(uri, Buffer.from('{{name}} {{type}}'));
    assert.deepEqual(store.read().templates[0].parameters.map(p => p.name), ['name', 'type']);
    await assert.rejects(provider.writeFile(uri, Buffer.from('')), /непустым/);
    assert.equal(store.read().templates[0].body, '{{name}} {{type}}');
});
test('stale editor cannot overwrite replaced template', async () => {
    await store.add(sample()); const provider = providers.get('algorithm-template');
    const uri = vscode.Uri.from({ scheme: 'algorithm-template', path: '/sample/template' });
    provider.readFile(uri);
    await store.import({ schemaVersion: 1, templates: [sample({ body: 'imported' })] }, true);
    await assert.rejects(provider.writeFile(uri, Buffer.from('old edit')), /изменился/);
    assert.equal(store.read().templates[0].body, 'imported');
});
test('export and import preserve templates; malformed import leaves state intact', async () => {
    await store.add(sample()); const address = vscode.Uri.from({ scheme: 'file', path: '/library.json' });
    answers.save.push(address); await command('exportTemplates');
    assert.deepEqual(parseLibrary(Buffer.from(files.get(address.toString())).toString()), store.read());
    answers.open.push([address]); answers.pick.push(first); await command('importTemplates');
    assert.equal(store.read().templates.length, 1); assert.match(messages.info.at(-1), /Пропущено: 1/);
    files.set(address.toString(), Buffer.from('{"invalid":true}'));
    answers.open.push([address]); await command('importTemplates');
    assert.equal(store.read().templates.length, 1); assert.equal(messages.error.length, 1);
});
test('replacement import cancellation and dirty editor protect library', async () => {
    await store.add(sample()); const address = vscode.Uri.from({ scheme: 'file', path: '/empty.json' });
    files.set(address.toString(), Buffer.from(exportLibrary({ schemaVersion: 1, templates: [] })));
    answers.open.push([address]); answers.pick.push(items => items[1]); answers.warning.push(undefined);
    await command('importTemplates'); assert.equal(store.read().templates.length, 1);
    vscode.workspace.textDocuments.push({ uri: vscode.Uri.from({ scheme: 'algorithm-template', path: '/sample/template' }), isDirty: true });
    answers.open.push([address]); answers.pick.push(items => items[1]); await command('importTemplates');
    assert.equal(store.read().templates.length, 1); assert.match(messages.error[0], /несохранёнными/);
});
