import esbuild from 'esbuild';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { nativeNodeModulesPlugin } from 'esbuild-native-node-modules-plugin';
import copyPlugin from 'esbuild-plugin-copy';

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
    entryPoints: [
        join('src', 'extension.ts'),
        join('src', 'workers', 'indexingWorker.ts'),
    ],
    outdir: './dist',
    bundle: true,
    external: ['vscode'],
    platform: 'node',
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    format: 'cjs',
    target: 'es2024',
    plugins: [
        esbuildProblemMatcherPlugin,
        nativeNodeModulesPlugin,
        copyPlugin({
            resolveFrom: "cwd",
            assets: [
                {
                    from: ["./node_modules/onnxruntime-node/bin/napi-v3/win32/x64/*"],
                    to: ["./dist/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/"],
                },
                {
                    from: ["./models/**/*"],
                    to: ["./dist/models/"],
                }
            ],
        }),
    ],
    external: ['vscode', 'onnxruntime-node'],
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
