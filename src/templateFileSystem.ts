import * as vscode from 'vscode';
import { LibraryStore, syncParameters, Template } from './library';

export const TEMPLATE_SCHEME = 'algorithm-template';
export class TemplateFileSystem implements vscode.FileSystemProvider {
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changes.event;
    private readonly opened = new Map<string, string>();
    private revision = Date.now();
    constructor(private readonly store: LibraryStore) {}
    dispose(): void { this.changes.dispose(); }
    watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
    refresh(): void {
        const templates = this.store.read().templates;
        const events: vscode.FileChangeEvent[] = [];
        for (const [address, body] of this.opened) {
            const uri = vscode.Uri.parse(address);
            const current = templates.find(t => t.id === uri.path.split('/')[1]);
            if (!current) { events.push({ uri, type: vscode.FileChangeType.Deleted }); }
            else if (current.body !== body) { events.push({ uri, type: vscode.FileChangeType.Changed }); }
        }
        if (events.length) {
            this.revision = Math.max(Date.now(), this.revision + 1);
            this.changes.fire(events);
        }
    }
    private template(uri: vscode.Uri): Template {
        const template = this.store.read().templates.find(t => t.id === uri.path.split('/')[1]);
        if (!template) { throw vscode.FileSystemError.FileNotFound(uri); }
        return template;
    }
    stat(uri: vscode.Uri): vscode.FileStat {
        const template = this.template(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: this.revision, size: Buffer.byteLength(template.body, 'utf8') };
    }
    readFile(uri: vscode.Uri): Uint8Array {
        const template = this.template(uri);
        this.opened.set(uri.toString(), template.body);
        return Buffer.from(template.body, 'utf8');
    }
    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const body = Buffer.from(content).toString('utf8');
        const template = this.template(uri);
        const baseline = this.opened.get(uri.toString());
        try {
            await this.store.update(template.id, current => {
                if (baseline === undefined || current.body !== baseline) {
                    throw new Error('Шаблон изменился после открытия. Скопируйте свои правки и откройте шаблон заново.');
                }
                return { ...current, body, parameters: syncParameters(body, current.parameters) };
            });
        } catch (error) {
            throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
        }
        this.opened.set(uri.toString(), body);
        this.revision = Math.max(Date.now(), this.revision + 1);
        this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }
    readDirectory(): [string, vscode.FileType][] { return []; }
    createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Используйте команды «Шаблоны кода».'); }
    delete(): void { throw vscode.FileSystemError.NoPermissions('Удаляйте шаблоны через команду «Удалить шаблон».'); }
    rename(): void { throw vscode.FileSystemError.NoPermissions('Переименовывайте шаблоны через команду «Переименовать шаблон».'); }
}
