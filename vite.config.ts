/// <reference types="vitest/config" />
/// <reference types="vite/client" />

// Configure Vitest (https://vitest.dev/config/) and Vite (https://vitejs.dev/config/)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type LibraryOptions, type BuildOptions, type UserConfig, type ConfigEnv } from 'vite';
import { viteStaticCopy, type Target } from 'vite-plugin-static-copy';
// Importing Vitest's config type for explicit typing if needed, though UserConfig from Vite includes 'test'
import type { InlineConfig as VitestInlineConfig } from 'vitest/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(({ mode, command }: ConfigEnv): UserConfig => {
    const isProduction = mode === 'production';

    // Vite Build Configuration
    const libOptions: LibraryOptions = {
        entry: {
            extension: resolve(__dirname, 'src/extension.ts'),
            'workers/embeddingGeneratorWorker': resolve(__dirname, 'src/workers/embeddingGeneratorWorker.ts'),
        },
        formats: ['cjs'],
        fileName: (_format, entryName) => `${entryName}.js`,
    };

    const staticCopyTargets: Target[] = [
        {
            src: 'node_modules/onnxruntime-node/',
            dest: 'node_modules',
        },
        {
            src: 'node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node',
            dest: '.',
        },
        {
            src: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-*.wasm',
            dest: 'grammars',
        },
        {
            src: 'node_modules/web-tree-sitter/tree-sitter.wasm',
            dest: '.',
        },
        {
            src: 'models/',
            dest: '.',
        },
    ];

    const buildConfig: BuildOptions = {
        lib: libOptions,
        outDir: resolve(__dirname, 'dist'),
        sourcemap: !isProduction,
        minify: isProduction,
        target: 'es2024',
        rollupOptions: {
            output: {
                exports: 'named'
            },
            external: ['vscode', 'onnxruntime-node', 'piscina', 'hnswlib-node', '@vscode/sqlite3'],
        },
        ssr: true, // Signal that this is an SSR/Node.js build
        emptyOutDir: true,
    };

    // Vitest Configuration (from existing setup)
    const testConfig: VitestInlineConfig = {
        globals: true,
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        mockReset: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
        },
    };

    // Vite Resolve Configuration (from existing setup)
    const resolveConfig = {
        alias: {
            'vscode': resolve(__dirname, './__mocks__/vscode.js')
        }
    };

    // Base configuration shared between serve and build
    let config: UserConfig = {
        test: testConfig,
        resolve: resolveConfig,
    };

    if (command === 'build') {
        config = {
            ...config,
            build: buildConfig,
            plugins: [
                viteStaticCopy({
                    targets: staticCopyTargets,
                }),
            ],
        };
    }
    // 'serve' command (used by `vitest` or `vite dev`) will use the base config
    // which already includes test and resolve options.
    // Additional serve-specific options or plugins could be added here if needed.

    return config;
});
