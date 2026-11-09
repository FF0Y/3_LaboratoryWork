import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LibraryStore, State, syncParameters } from '../library';
import { TemplateFileSystem } from '../templateFileSystem';

suite('Algorithm templates in VS Code', () => {
    test('extension activates and exposes every command', async () => {
        const extension = vscode.extensions.getExtension('FF0Y.my-first-extension');
        assert.ok(extension, 'Extension is loaded from the project');
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        for (const name of ['saveTemplate', 'insertTemplate', 'searchTemplates', 'browseCategories', 'editTemplate', 'renameTemplate', 'deleteTemplate', 'importTemplates', 'exportTemplates']) {
            assert.ok(commands.includes(`my-first-extension.${name}`), name);
        }
    });
    test('writable template document saves through real VS Code file API', async () => {
        let data: unknown;
        const state: State = { get<T>() { return data as T | undefined; }, async update(_key, value) { data = structuredClone(value); } };
        const store = new LibraryStore(state);
        const body = 'function {{name}}() {}';
        await store.add({ id: 'integration-test', name: 'Тест', category: 'Графы', keywords: [], language: 'typescript', body, parameters: syncParameters(body) });
        const provider = new TemplateFileSystem(store);
        const registration = vscode.workspace.registerFileSystemProvider('algorithm-template-test', provider, { isCaseSensitive: true });
        try {
            const uri = vscode.Uri.from({ scheme: 'algorithm-template-test', path: '/integration-test/template' });
            const document = await vscode.workspace.openTextDocument(uri);
            assert.equal(document.getText(), body);
            const editor = await vscode.window.showTextDocument(document);
            const replacement = 'function {{name}}(value: {{type}}) { return value; }';
            assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(body.length)), replacement)), true);
            assert.equal(await document.save(), true);
            assert.equal(store.read().templates[0].body, replacement);
            assert.deepEqual(store.read().templates[0].parameters.map(p => p.name), ['name', 'type']);
            assert.equal(new LibraryStore(state).read().templates[0].body, replacement);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } finally { registration.dispose(); provider.dispose(); }
    });
});
