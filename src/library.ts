import { randomUUID } from 'node:crypto';

export const STORAGE_KEY = 'algorithmTemplates.library.v1';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CATEGORIES = ['Сортировки', 'Графы', 'Динамическое программирование', 'Структуры данных', 'Другое'];
export interface Parameter { name: string; label: string; defaultValue: string; }
export interface Template {
    id: string;
    name: string;
    category: string;
    keywords: string[];
    language: string;
    body: string;
    parameters: Parameter[];
}
export interface Library { schemaVersion: 1; templates: Template[]; }
export interface State {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Ожидается объект JSON.');
    }
    return value as Record<string, unknown>;
}
function text(value: unknown, field: string, limit: number, empty = false): string {
    if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) {
        throw new Error(`Поле «${field}» должно быть строкой ${empty ? '' : 'с непустым значением '}длиной до ${limit} символов.`);
    }
    return value;
}
export function parameterNames(body: string): string[] {
    const names = new Set<string>();
    for (const match of body.matchAll(/(\\)?\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
        if (!match[1]) { names.add(match[2]); }
    }
    return [...names];
}
export function syncParameters(body: string, previous: Parameter[] = []): Parameter[] {
    return parameterNames(body).map(name => previous.find(p => p.name === name)
        ?? { name, label: name, defaultValue: '' });
}
export function renderTemplate(template: Template, values: Record<string, string>): string {
    // A replacement callback keeps $, backslashes and nested placeholders literal.
    return template.body.replace(/(\\)?\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (whole, escape: string, name: string) => {
        if (escape) { return whole.slice(1); }
        if (!Object.hasOwn(values, name)) { throw new Error(`Не задан параметр «${name}».`); }
        return values[name];
    });
}
export function validateTemplate(value: unknown): Template {
    const v = object(value);
    const id = text(v.id, 'id', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { throw new Error('Недопустимый идентификатор шаблона.'); }
    if (!Array.isArray(v.keywords) || v.keywords.length > 50) { throw new Error('Укажите до 50 ключевых слов.'); }
    const keywords = [...new Set(v.keywords.map(k => text(k, 'ключевое слово', 100).trim()))];
    const body = text(v.body, 'код', 200_000);
    if (!Array.isArray(v.parameters) || v.parameters.length > 32) { throw new Error('Допускается до 32 параметров.'); }
    const parameters = v.parameters.map(item => {
        const p = object(item);
        const name = text(p.name, 'имя параметра', 100);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { throw new Error(`Недопустимое имя параметра: ${name}`); }
        return { name, label: text(p.label, 'подсказка параметра', 200).trim(), defaultValue: text(p.defaultValue, 'значение параметра', 10_000, true) };
    });
    const expected = parameterNames(body);
    if (parameters.length !== expected.length || new Set(parameters.map(p => p.name)).size !== parameters.length
        || parameters.some(p => !expected.includes(p.name))) {
        throw new Error('Список parameters должен соответствовать меткам {{имя}} в коде без повторений.');
    }
    return { id, name: text(v.name, 'название', 150).trim(), category: text(v.category, 'категория', 100).trim(),
        keywords, language: text(v.language, 'язык', 100).trim(), body, parameters };
}
function key(t: Template): string { return JSON.stringify([t.category.toLowerCase(), t.name.toLowerCase()]); }
export function validateLibrary(value: unknown): Library {
    const v = object(value);
    if (v.schemaVersion !== 1) { throw new Error('Неизвестная версия библиотеки. Ожидается schemaVersion: 1.'); }
    if (!Array.isArray(v.templates) || v.templates.length > 1000) { throw new Error('Библиотека должна содержать массив templates (до 1000 шаблонов).'); }
    const templates = v.templates.map(validateTemplate);
    if (new Set(templates.map(t => t.id)).size !== templates.length) { throw new Error('В библиотеке повторяются идентификаторы.'); }
    if (new Set(templates.map(key)).size !== templates.length) { throw new Error('В одной категории не может быть двух шаблонов с одинаковым названием.'); }
    const result: Library = { schemaVersion: 1, templates };
    if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n', 'utf8') > MAX_FILE_BYTES) { throw new Error('Библиотека превышает 5 МБ.'); }
    return result;
}
export function parseLibrary(json: string): Library {
    if (Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) { throw new Error('Файл превышает 5 МБ.'); }
    let data: unknown;
    try { data = JSON.parse(json.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Файл содержит некорректный JSON. Библиотека не изменена.'); }
    return validateLibrary(data);
}
export function exportLibrary(library: Library): string {
    return JSON.stringify(validateLibrary(library), null, 2) + '\n';
}
export function mergeLibraries(current: Library, incoming: Library): { library: Library; added: number; skipped: number } {
    const result = validateLibrary(current);
    const names = new Set(result.templates.map(key));
    const ids = new Set(result.templates.map(t => t.id));
    let added = 0;
    let skipped = 0;
    for (const template of validateLibrary(incoming).templates) {
        if (names.has(key(template))) { skipped++; continue; }
        let id = template.id;
        while (ids.has(id)) { id = randomUUID(); }
        result.templates.push({ ...template, id });
        ids.add(id); names.add(key(template)); added++;
    }
    return { library: validateLibrary(result), added, skipped };
}

export class LibraryStore {
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private readonly state: State) {}
    read(): Library {
        const raw = this.state.get<unknown>(STORAGE_KEY);
        return raw === undefined ? { schemaVersion: 1, templates: [] } : validateLibrary(raw);
    }
    private write<T>(operation: (library: Library) => { library: Library; result: T }): Promise<T> {
        const next = this.pending.then(async () => {
            const { library, result } = operation(this.read());
            await this.state.update(STORAGE_KEY, validateLibrary(library));
            return result;
        });
        this.pending = next.catch(() => undefined);
        return next;
    }
    add(template: Template): Promise<void> {
        return this.write(library => ({ library: { ...library, templates: [...library.templates, template] }, result: undefined }));
    }
    update(id: string, change: (current: Template) => Template): Promise<void> {
        return this.write(library => {
            if (!library.templates.some(t => t.id === id)) { throw new Error('Шаблон уже удалён.'); }
            return { library: { ...library, templates: library.templates.map(t => t.id === id ? { ...change(t), id } : t) }, result: undefined };
        });
    }
    remove(id: string): Promise<void> {
        return this.write(library => ({ library: { ...library, templates: library.templates.filter(t => t.id !== id) }, result: undefined }));
    }
    import(incoming: Library, replace: boolean): Promise<{ added: number; skipped: number }> {
        const checked = validateLibrary(incoming);
        return this.write(current => {
            const result = replace ? { library: checked, added: checked.templates.length, skipped: 0 } : mergeLibraries(current, checked);
            return { library: result.library, result: { added: result.added, skipped: result.skipped } };
        });
    }
}
