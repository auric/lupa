import esbuild from 'esbuild';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: [join('src', 'extension.ts')],
    bundle: true,
    external: ['vscode'],
    platform: 'node',
    outfile: join('dist', 'extension.js'),
    sourcemap: true,
    minify: process.env.NODE_ENV === 'production',
    format: 'cjs',
    target: 'es2024',
    define: {
        'process.env.NODE_ENV': `"${process.env.NODE_ENV || 'development'}"`
    },
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
