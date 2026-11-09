const esbuild = require('esbuild');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function main() {
    await esbuild.build({ entryPoints: ['src/library.ts', 'src/extension.ts'], outdir: '.test-dist',
        outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs',
        plugins: [{ name: 'test-vscode', setup(build) {
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.resolve('tests/vscode-mock.cjs'), external: true }));
        } }] });
    const result = spawnSync(process.execPath, ['--test', 'tests/library.test.cjs', 'tests/commands.test.cjs'], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
