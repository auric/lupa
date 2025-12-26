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

    // For extension, externalize these Node.js packages
    return ['vscode', '@tailwindcss/vite'].includes(source);
};

export default defineConfig(({ mode, command }: ConfigEnv): UserConfig => {
    const isProduction = mode === 'production';

    // Node.js library configuration (extension)
    const libOptions: LibraryOptions = {
        entry: {
            extension: resolve(__dirname, 'src/extension.ts'),
        },
        formats: ['cjs'],
        fileName: (_format, entryName) => `${entryName}.js`,
    };

    // Webview entry points - exclude toolTesting from production builds
    const webviewInputs: Record<string, string> = isProduction
        ? { main: resolve(__dirname, 'src/webview/main.tsx') }
        : {
            main: resolve(__dirname, 'src/webview/main.tsx'),
            toolTesting: resolve(__dirname, 'src/webview/tool-testing/toolTesting.tsx')
        };

    // Webview app configuration (browser-like)
    const webviewBuildConfig: BuildOptions = {
        rollupOptions: {
            input: webviewInputs,
            output: {
                inlineDynamicImports: false,
                entryFileNames: 'webview/[name].js',
                chunkFileNames: 'webview/[name].js',
                assetFileNames: 'webview/[name].[ext]',
                format: 'esm',
            },
            external: []
        },
        outDir: resolve(__dirname, 'dist'),
        sourcemap: !isProduction,
        minify: isProduction,
        target: 'es2024',
        emptyOutDir: false,
        // Suppress chunk size warning for webview (React + dependencies are large)
        chunkSizeWarningLimit: 700,
    };

    // Node.js library configuration
    const nodeBuildConfig: BuildOptions = {
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
        ssr: true,
        emptyOutDir: true,
    };

    const staticCopyTargets: Target[] = [
        // Static assets to copy during build (if any)
    ];

    // Determine which build config to use
    const buildConfig = process.env.BUILD_TARGET === 'webview' ? webviewBuildConfig : nodeBuildConfig;

    // Vitest Configuration (from existing setup)
    const testConfig: VitestInlineConfig = {
        globals: true,
        mockReset: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
        },
        projects: [
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['src/**/*.{test,spec}.ts'],
                    exclude: ['src/**/*.{test,spec}.tsx'],
                    alias: {
                        vscode: resolve(__dirname, './__mocks__/vscode.js'),
                    }
                }
            },
            {
                test: {
                    name: 'jsdom',
                    environment: 'jsdom',
                    include: ['src/**/*.{test,spec}.tsx'],
                    setupFiles: ['./vitest.jsdom.setup.ts'],
                    alias: {
                        '@': resolve(__dirname, './src'),
                    }
                }
            }
        ]
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
        // SSR options for Node.js extension build - force bundling of runtime dependencies
        const ssrConfig = process.env.BUILD_TARGET === 'webview' ? undefined : {
            // SSR mode externalizes all bare imports by default.
            // noExternal: true forces bundling of all dependencies except those in rollupOptions.external
            noExternal: true as const,
        };

        config = {
            ...config,
            build: buildConfig,
            ssr: ssrConfig,
            plugins: [
                react({
                    babel: {
                        plugins: [
                            ["babel-plugin-react-compiler", {
                                target: "19" // React 19 support - provides automatic memoization
                            }]
                        ]
                    }
                }),
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
