/// <reference types="vitest/config" />

// Configure Vitest (https://vitest.dev/config/)

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        mockReset: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
        },
    },
    resolve: {
        alias: {
            'vscode': './__mocks__/vscode.js'
        }
    }
});
