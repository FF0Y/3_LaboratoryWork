import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
    ...(process.env.VSCODE_EXECUTABLE_PATH ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE_PATH } } : {}),
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.resolve('.vscode-test/user-data'), '--extensions-dir', path.resolve('.vscode-test/extensions')],
    mocha: { timeout: 20000 },
});
