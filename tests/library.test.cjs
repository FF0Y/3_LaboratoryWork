const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { LibraryStore, STORAGE_KEY, parseLibrary, exportLibrary, validateLibrary, syncParameters, renderTemplate, mergeLibraries } = require('../.test-dist/library.cjs');

function template(overrides = {}) {
    const body = overrides.body ?? 'function {{name}}(x: {{type}}) { return x; } // {{name}}';
    return { id: 'sample', name: 'Алгоритм', category: 'Графы', keywords: ['dfs', 'поиск'], language: 'typescript', body, parameters: syncParameters(body), ...overrides };
}
function library(templates = [template()]) { return { schemaVersion: 1, templates }; }
function state() {
    return { data: undefined, fail: false, get() { return this.data; }, async update(_key, value) {
        if (this.fail) { throw new Error('disk full'); }
        this.data = structuredClone(value);
    } };
}
test('Unicode export/import preserves code, parameters and metadata', () => {
    const value = library();
    assert.deepEqual(parseLibrary(exportLibrary(value)), value);
    assert.deepEqual(parseLibrary('\uFEFF' + exportLibrary(value)), value);
});
test('parameters are unique and escaped braces are literal', () => {
    const t = template({ body: '{{name}} {{name}} \\{{literal}} {{type}}' });
    assert.deepEqual(syncParameters(t.body).map(p => p.name), ['name', 'type']);
    assert.equal(renderTemplate(t, { name: '$&\\hello{{type}}', type: 'number' }), '$&\\hello{{type}} $&\\hello{{type}} {{literal}} number');
});
test('missing parameter fails; empty string is allowed', () => {
    assert.throws(() => renderTemplate(template(), { name: 'f' }), /type/);
    assert.equal(renderTemplate(template({ body: '{{name}}' }), { name: '' }), '');
});
test('object prototype names cannot inject values', () => {
    const t = template({ body: '{{__proto__}} {{constructor}}' });
    assert.throws(() => renderTemplate(t, {}), /__proto__/);
    assert.equal(renderTemplate(t, JSON.parse('{"__proto__":"safe","constructor":"value"}')), 'safe value');
});
test('code edits preserve known defaults and discover new parameters', () => {
    assert.deepEqual(syncParameters('{{old}} {{new}}', [{ name: 'old', label: 'Old', defaultValue: 'x' }, { name: 'removed', label: 'Gone', defaultValue: '' }]),
        [{ name: 'old', label: 'Old', defaultValue: 'x' }, { name: 'new', label: 'new', defaultValue: '' }]);
});
test('invalid imports are rejected before mutation', () => {
    for (const value of [null, [], {}, { schemaVersion: 2, templates: [] }, library([{ ...template(), body: 42 }]), library([{ ...template(), parameters: [] }]),
        library([{ ...template(), id: '../x' }]), library([{ ...template(), keywords: 'dfs' }])]) {
        assert.throws(() => validateLibrary(value));
    }
    assert.throws(() => parseLibrary('{bad json'), /JSON/);
    assert.throws(() => parseLibrary(' '.repeat(5 * 1024 * 1024 + 1)), /5 МБ/);
});
test('duplicate IDs and category/name pairs are rejected', () => {
    assert.throws(() => validateLibrary(library([template(), template({ name: 'Other' })])), /идентификаторы/);
    assert.throws(() => validateLibrary(library([template(), template({ id: 'other', name: 'алгоритм', category: 'графы' })])), /названием/);
    assert.equal(validateLibrary(library([template(), template({ id: 'other', category: 'Другое' })])).templates.length, 2);
});
test('merge skips same name/category and remaps colliding IDs without overwriting', () => {
    const original = library();
    const result = mergeLibraries(original, library([template({ body: 'changed', parameters: [] }), template({ id: 'new', name: 'Other' })]));
    assert.equal(result.added, 1); assert.equal(result.skipped, 1);
    assert.equal(result.library.templates[0].body, original.templates[0].body);
    const collision = mergeLibraries(original, library([template({ name: 'New name' })]));
    assert.notEqual(collision.library.templates[1].id, 'sample');
    assert.equal(original.templates.length, 1);
});
test('CRUD persists across store instances', async () => {
    const memory = state();
    const store = new LibraryStore(memory);
    await store.add(template());
    await store.update('sample', t => ({ ...t, name: 'Новое имя', category: 'Сортировки' }));
    const reopened = new LibraryStore(memory);
    assert.equal(reopened.read().templates[0].name, 'Новое имя');
    await reopened.remove('sample');
    assert.deepEqual(store.read(), library([]));
});
test('queued saves do not lose templates', async () => {
    const store = new LibraryStore(state());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(template({ id: `id-${i}`, name: `Name ${i}` }))));
    assert.equal(store.read().templates.length, 20);
});
test('failed writes do not report successful persistence; later writes recover', async () => {
    const memory = state(); const store = new LibraryStore(memory);
    memory.fail = true;
    await assert.rejects(store.add(template()), /disk full/);
    assert.equal(store.read().templates.length, 0);
    memory.fail = false;
    await store.add(template());
    assert.equal(store.read().templates.length, 1);
});
test('failed validation and duplicate rename preserve existing data', async () => {
    const store = new LibraryStore(state());
    await store.add(template()); await store.add(template({ id: 'second', name: 'Second' }));
    const before = store.read();
    await assert.rejects(store.update('second', t => ({ ...t, name: 'Алгоритм' })));
    assert.deepEqual(store.read(), before);
    await assert.rejects(store.update('missing', t => t), /удалён/);
});
test('replace and empty-library import are explicit and persistent', async () => {
    const store = new LibraryStore(state()); await store.add(template());
    assert.deepEqual(await store.import(library([template({ id: 'new', name: 'New' })]), true), { added: 1, skipped: 0 });
    assert.equal(store.read().templates[0].id, 'new');
    await store.import(library([]), true);
    assert.equal(store.read().templates.length, 0);
});
test('corrupt persisted library is not silently overwritten', async () => {
    const memory = state(); memory.data = { broken: true };
    const store = new LibraryStore(memory);
    assert.throws(() => store.read());
    await assert.rejects(store.add(template()));
    assert.deepEqual(memory.data, { broken: true });
    assert.equal(STORAGE_KEY, 'algorithmTemplates.library.v1');
});
test('example algorithms import, render and return correct results', () => {
    const examples = parseLibrary(fs.readFileSync('examples/algorithms.json', 'utf8'));
    assert.equal(examples.templates.length, 4);
    const source = examples.templates.map(t => renderTemplate(t, Object.fromEntries(t.parameters.map(p => [p.name, p.defaultValue])))).join('\n');
    const code = esbuild.transformSync(source + `\nJSON.stringify({
        sorted: insertionSort([3, 1, 2, 1]),
        empty: insertionSort([]),
        graph: bfs(new Map([['a', ['b']], ['b', ['a', 'c']]]), 'a'),
        fib: String(fibonacci(10)),
        zero: String(fibonacci(0)),
        stack: (() => { const s = new Stack(); s.push(4); s.push(7); return [s.pop(), s.peek(), s.size]; })()
    })`, { loader: 'ts', target: 'es2022' }).code;
    assert.deepEqual(JSON.parse(vm.runInNewContext(code, {}, { timeout: 1000 })),
        { sorted: [1, 1, 2, 3], empty: [], graph: ['a', 'b', 'c'], fib: '55', zero: '0', stack: [7, 4, 1] });
});
