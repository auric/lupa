import esbuild from 'esbuild';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log(`${watch ? '[watch]' : ''} build started`);
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log(`${watch ? '[watch]' : ''} build finished`);
        });
    },
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: [join('src', 'extension.ts')],
    bundle: true,
    external: ['vscode'],
    platform: 'node',
    outfile: join('dist', 'extension.js'),
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    format: 'cjs',
    target: 'es2024',
    plugins: [
        esbuildProblemMatcherPlugin
    ]
};

if (watch) {
    esbuild
        .context(buildOptions)
        .then((ctx) => {
            console.log('Watching for changes...');
            return ctx.watch();
        })
        .catch(process.exit);
} else {
    esbuild
        .build(buildOptions)
        .then(() => console.log('Build complete'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
