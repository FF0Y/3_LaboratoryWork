const registered = new Map();
const providers = new Map();
const answers = { input: [], pick: [], warning: [], open: [], save: [] };
const messages = { error: [], info: [], pickOptions: [] };
class Disposable { constructor(fn = () => {}) { this.fn = fn; } dispose() { this.fn(); } }
class EventEmitter {
    listeners = [];
    event = fn => { this.listeners.push(fn); return new Disposable(); };
    fire(value) { for (const fn of this.listeners) { fn(value); } }
    dispose() { this.listeners = []; }
}
function uri(scheme, path) { return { scheme, path, toString() { return `${scheme}:${path}`; } }; }
function next(queue, ...args) { const answer = queue.shift(); return typeof answer === 'function' ? answer(...args) : answer; }
const files = new Map();
const api = {
    Disposable, EventEmitter,
    Uri: { from: ({ scheme, path }) => uri(scheme, path), parse: value => uri(value.split(':')[0], value.slice(value.indexOf(':') + 1)) },
    FileType: { File: 1 }, FileChangeType: { Changed: 1, Deleted: 3 }, EndOfLine: { LF: 1, CRLF: 2 },
    FileSystemError: Object.fromEntries(['FileNotFound', 'NoPermissions', 'Unavailable'].map(key => [key, value => new Error(`${key}: ${value}`)])),
    commands: { registerCommand(id, fn) { registered.set(id, fn); return new Disposable(() => registered.delete(id)); } },
    window: {
        activeTextEditor: undefined,
        async showInputBox(options) { return next(answers.input, options); },
        async showQuickPick(items, options) { messages.pickOptions.push(options); return next(answers.pick, items, options); },
        async showWarningMessage(...args) { return next(answers.warning, ...args); },
        async showInformationMessage(message) { messages.info.push(message); },
        async showErrorMessage(message) { messages.error.push(message); },
        async showOpenDialog() { return next(answers.open); },
        async showSaveDialog() { return next(answers.save); },
        async showTextDocument(document) { return { document }; }
    },
    workspace: {
        textDocuments: [],
        registerFileSystemProvider(scheme, provider) { providers.set(scheme, provider); return new Disposable(); },
        async openTextDocument(address) { return { uri: address, languageId: 'plaintext' }; },
        fs: {
            async stat(address) { return { size: files.get(address.toString()).length }; },
            async readFile(address) { return files.get(address.toString()); },
            async writeFile(address, bytes) { files.set(address.toString(), bytes); }
        }
    },
    languages: { async getLanguages() { return ['typescript', 'javascript']; }, async setTextDocumentLanguage(document, languageId) { return { ...document, languageId }; } },
    _test: { registered, providers, answers, messages, files,
        reset() {
            registered.clear(); providers.clear(); files.clear();
            for (const values of Object.values(answers)) { values.length = 0; }
            for (const values of Object.values(messages)) { values.length = 0; }
            api.window.activeTextEditor = undefined; api.workspace.textDocuments = [];
        }
    }
};
module.exports = api;
