/// <reference types="vitest/config" />
/// <reference types="vite/client" />

// Configure Vitest (https://vitest.dev/config/) and Vite (https://vitejs.dev/config/)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type LibraryOptions, type BuildOptions, type UserConfig, type ConfigEnv } from 'vite';
import { viteStaticCopy, type Target } from 'vite-plugin-static-copy';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// Importing Vitest's config type for explicit typing if needed, though UserConfig from Vite includes 'test'
import type { InlineConfig as VitestInlineConfig } from 'vitest/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// External dependencies function for different entry points
const isExternalDependency = (source: string, importer: string | undefined, isResolved: boolean): boolean => {
    // For webview entry, only externalize vscode
    if (importer && importer.includes('src/webview/')) {
        return source === 'vscode';
    }

    // For extension and workers, externalize these Node.js packages
    return ['vscode', 'onnxruntime-node', 'hnswlib-node', '@vscode/sqlite3', '@tailwindcss/vite'].includes(source);
};

export default defineConfig(({ mode, command }: ConfigEnv): UserConfig => {
    const isProduction = mode === 'production';

    // Vite Build Configuration
    const libOptions: LibraryOptions = {
        entry: {
            extension: resolve(__dirname, 'src/extension.ts'),
            'workers/embeddingGeneratorWorker': resolve(__dirname, 'src/workers/embeddingGeneratorWorker.ts'),
            'webview/main': resolve(__dirname, 'src/webview/main.tsx'),
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
        {
            src: 'node_modules/diff2html/bundles/css/diff2html.min.css',
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
            external: isExternalDependency,
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
            'vscode': resolve(__dirname, './__mocks__/vscode.js'),
            '@': resolve(__dirname, './src')
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
                react(),
                tailwindcss(),
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
