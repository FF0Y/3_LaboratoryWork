import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CATEGORIES, exportLibrary, LibraryStore, MAX_FILE_BYTES, Parameter, parseLibrary, renderTemplate, syncParameters, Template } from './library';
import { TEMPLATE_SCHEME, TemplateFileSystem } from './templateFileSystem';

const PREFIX = 'my-first-extension';
type Choice = vscode.QuickPickItem & { template: Template };

async function input(title: string, value = '', max = 150, optional = false): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({ title, value, ignoreFocusOut: true,
        validateInput: v => (!optional && !v.trim()) ? 'Введите значение.' : v.length > max ? `Не более ${max} символов.` : undefined });
    return result?.trim();
}
async function category(store: LibraryStore, current?: string): Promise<string | undefined> {
    const categories = [...new Set([...DEFAULT_CATEGORIES, ...store.read().templates.map(t => t.category)])];
    const picked = await vscode.window.showQuickPick([
        { label: '$(add) Новая категория…', value: undefined },
        ...categories.sort((a, b) => a.localeCompare(b)).map(value => ({ label: value, value, description: value === current ? 'текущая' : '' }))
    ], { title: 'Категория шаблона', placeHolder: 'Выберите категорию или создайте свою', ignoreFocusOut: true });
    if (!picked) { return undefined; }
    return picked.value ?? input('Название новой категории', '', 100);
}
async function keywords(current: string[] = []): Promise<string[] | undefined> {
    const value = await input('Ключевые слова через запятую (можно оставить пустым)', current.join(', '), 5000, true);
    return value === undefined ? undefined : [...new Set(value.split(',').map(k => k.trim()).filter(Boolean))];
}
async function parameterSettings(parameters: Parameter[]): Promise<Parameter[] | undefined> {
    if (parameters.length > 32) { throw new Error('Допускается до 32 разных параметров в шаблоне.'); }
    const result: Parameter[] = [];
    for (const p of parameters) {
        const label = await input(`Подсказка для {{${p.name}}}`, p.label, 200);
        if (label === undefined) { return undefined; }
        const defaultValue = await vscode.window.showInputBox({ title: `Значение по умолчанию: ${label} (можно пустое)`,
            value: p.defaultValue, ignoreFocusOut: true, validateInput: v => v.length > 10_000 ? 'Не более 10000 символов.' : undefined });
        if (defaultValue === undefined) { return undefined; }
        result.push({ name: p.name, label, defaultValue });
    }
    return result;
}
async function pick(store: LibraryStore, title: string, onlyCategory?: string): Promise<Template | undefined> {
    const templates = store.read().templates.filter(t => onlyCategory === undefined || t.category === onlyCategory);
    if (!templates.length) {
        void vscode.window.showInformationMessage('Библиотека пуста. Выделите код и выполните «Шаблоны кода: Сохранить выделение».');
        return undefined;
    }
    const items: Choice[] = templates.sort((a, b) => a.name.localeCompare(b.name)).map(template => ({
        label: template.name, description: template.category,
        detail: `${template.language} · ${template.keywords.join(', ')}${template.parameters.length ? ` · параметров: ${template.parameters.length}` : ''}`,
        template
    }));
    const selected = await vscode.window.showQuickPick(items, { title, placeHolder: 'Название, категория или ключевое слово',
        matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
    return selected?.template;
}
async function saveSelection(store: LibraryStore): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { void vscode.window.showInformationMessage('Сначала выделите код, который хотите сохранить.'); return; }
    const body = editor.document.getText(editor.selection);
    const language = editor.document.languageId;
    const name = await input('Название шаблона');
    if (name === undefined) { return; }
    const chosenCategory = await category(store);
    if (chosenCategory === undefined) { return; }
    const words = await keywords();
    if (words === undefined) { return; }
    const parameters = await parameterSettings(syncParameters(body));
    if (parameters === undefined) { return; }
    await store.add({ id: randomUUID(), name, category: chosenCategory, keywords: words, language, body, parameters });
    void vscode.window.showInformationMessage(`Шаблон «${name}» сохранён.`);
}
async function insert(store: LibraryStore, byCategory = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showInformationMessage('Откройте файл и поставьте курсор в место вставки.'); return; }
    const version = editor.document.version;
    const selection = editor.selection;
    let selectedCategory: string | undefined;
    if (byCategory) {
        const categories = [...new Set(store.read().templates.map(t => t.category))].sort((a, b) => a.localeCompare(b));
        if (!categories.length) { await pick(store, 'Вставить шаблон'); return; }
        selectedCategory = await vscode.window.showQuickPick(categories, { title: 'Выберите категорию', ignoreFocusOut: true });
        if (selectedCategory === undefined) { return; }
    }
    const template = await pick(store, 'Найти и вставить шаблон', selectedCategory);
    if (!template) { return; }
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [i, p] of template.parameters.entries()) {
        const value = await vscode.window.showInputBox({ title: `${template.name}: ${p.label} (${i + 1}/${template.parameters.length})`,
            prompt: `Значение для {{${p.name}}}`, value: p.defaultValue, ignoreFocusOut: true,
            validateInput: v => v.length > 10_000 ? 'Не более 10000 символов.' : undefined });
        if (value === undefined) { return; }
        values[p.name] = value;
    }
    if (editor.document.isClosed || editor.document.version !== version) { throw new Error('Файл изменился во время выбора шаблона. Повторите вставку.'); }
    const body = renderTemplate(template, values).replace(/\r\n|\r|\n/g, editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const applied = await editor.edit(builder => builder.replace(selection, body), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) { throw new Error('Не удалось вставить код. Проверьте, доступен ли файл для редактирования.'); }
}
async function editCode(template: Template): Promise<void> {
    const uri = vscode.Uri.from({ scheme: TEMPLATE_SCHEME, path: `/${template.id}/template` });
    let document = await vscode.workspace.openTextDocument(uri);
    if ((await vscode.languages.getLanguages()).includes(template.language)) {
        document = await vscode.languages.setTextDocumentLanguage(document, template.language);
    }
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(`Редактирование «${template.name}». Ctrl+S сохраняет код в библиотеку. Новые параметры: {{имя}}.`);
}
async function rename(store: LibraryStore, template?: Template): Promise<void> {
    template ??= await pick(store, 'Переименовать шаблон');
    if (!template) { return; }
    const name = await input('Новое название шаблона', template.name);
    if (name === undefined) { return; }
    await store.update(template.id, current => ({ ...current, name }));
    void vscode.window.showInformationMessage(`Шаблон переименован в «${name}».`);
}
function dirtyTemplate(id?: string): boolean {
    return vscode.workspace.textDocuments.some(d => d.uri.scheme === TEMPLATE_SCHEME && d.isDirty && (id === undefined || d.uri.path.split('/')[1] === id));
}
async function remove(store: LibraryStore, template?: Template): Promise<void> {
    template ??= await pick(store, 'Удалить шаблон');
    if (!template) { return; }
    if (dirtyTemplate(template.id)) { throw new Error('У шаблона есть несохранённые правки. Сначала сохраните или закройте его вкладку.'); }
    const answer = await vscode.window.showWarningMessage(`Удалить шаблон «${template.name}» из категории «${template.category}»?`, { modal: true }, 'Удалить');
    if (answer !== 'Удалить') { return; }
    await store.remove(template.id);
    void vscode.window.showInformationMessage('Шаблон удалён.');
}
async function manage(store: LibraryStore): Promise<void> {
    const template = await pick(store, 'Редактировать шаблон');
    if (!template) { return; }
    const choice = await vscode.window.showQuickPick([
        { label: 'Редактировать код', action: 'code' }, { label: 'Переименовать', action: 'rename' },
        { label: 'Изменить категорию', action: 'category' }, { label: 'Изменить ключевые слова', action: 'keywords' },
        { label: 'Настроить параметры', action: 'parameters' }, { label: 'Удалить', action: 'delete' }
    ], { title: template.name, ignoreFocusOut: true });
    if (!choice) { return; }
    switch (choice.action) {
        case 'code': await editCode(template); break;
        case 'rename': await rename(store, template); break;
        case 'delete': await remove(store, template); break;
        case 'category': {
            const value = await category(store, template.category);
            if (value !== undefined) { await store.update(template.id, current => ({ ...current, category: value })); }
            break;
        }
        case 'keywords': {
            const value = await keywords(template.keywords);
            if (value !== undefined) { await store.update(template.id, current => ({ ...current, keywords: value })); }
            break;
        }
        case 'parameters': {
            if (!template.parameters.length) { void vscode.window.showInformationMessage('В коде нет параметров. Добавьте метку, например {{functionName}}, и сохраните код.'); break; }
            const value = await parameterSettings(template.parameters);
            if (value !== undefined) { await store.update(template.id, current => ({ ...current, parameters: value })); }
            break;
        }
    }
}
async function exportFile(store: LibraryStore): Promise<void> {
    if (dirtyTemplate()) { throw new Error('Сначала сохраните или закройте вкладки шаблонов с несохранёнными правками.'); }
    const uri = await vscode.window.showSaveDialog({ title: 'Экспорт библиотеки шаблонов', filters: { JSON: ['json'] }, saveLabel: 'Экспортировать' });
    if (!uri) { return; }
    if (uri.scheme === TEMPLATE_SCHEME) { throw new Error('Выберите обычный JSON-файл для экспорта.'); }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(exportLibrary(store.read()), 'utf8'));
    void vscode.window.showInformationMessage('Библиотека экспортирована.');
}
async function importFile(store: LibraryStore): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ title: 'Импорт библиотеки шаблонов', canSelectMany: false, filters: { JSON: ['json'] } });
    if (!uris?.length) { return; }
    if ((await vscode.workspace.fs.stat(uris[0])).size > MAX_FILE_BYTES) { throw new Error('Файл превышает 5 МБ.'); }
    const library = parseLibrary(Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8'));
    const action = await vscode.window.showQuickPick([
        { label: 'Добавить новые шаблоны', description: 'Совпадения по названию и категории будут пропущены', replace: false },
        { label: 'Заменить всю библиотеку', description: 'Текущие шаблоны будут удалены', replace: true }
    ], { title: `Импорт: ${library.templates.length} шаблонов`, ignoreFocusOut: true });
    if (!action) { return; }
    if (action.replace) {
        if (dirtyTemplate()) { throw new Error('Сначала сохраните или закройте вкладки шаблонов с несохранёнными правками.'); }
        const answer = await vscode.window.showWarningMessage(`Заменить всю библиотеку (${store.read().templates.length} шаблонов) содержимым файла (${library.templates.length})?`, { modal: true }, 'Заменить');
        if (answer !== 'Заменить') { return; }
    }
    const result = await store.import(library, action.replace);
    void vscode.window.showInformationMessage(`Импорт завершён. Загружено: ${result.added}. Пропущено: ${result.skipped}.`);
}
export function activate(context: vscode.ExtensionContext): void {
    const store = new LibraryStore(context.globalState);
    const provider = new TemplateFileSystem(store);
    context.subscriptions.push(provider, vscode.workspace.registerFileSystemProvider(TEMPLATE_SCHEME, provider, { isCaseSensitive: true }));
    const commands: Record<string, () => Promise<unknown>> = {
        saveTemplate: () => saveSelection(store), insertTemplate: () => insert(store), searchTemplates: () => insert(store),
        browseCategories: () => insert(store, true), editTemplate: () => manage(store), renameTemplate: () => rename(store),
        deleteTemplate: () => remove(store), exportTemplates: () => exportFile(store), importTemplates: () => importFile(store),
        helloWorld: async () => { void vscode.window.showInformationMessage('Привет из моего первого расширения!'); }
    };
    for (const [name, callback] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, async () => {
            try { await callback(); provider.refresh(); }
            catch (error) { void vscode.window.showErrorMessage(`Шаблоны кода: ${error instanceof Error ? error.message : String(error)}`); }
        }));
    }
}
export function deactivate(): void {}
