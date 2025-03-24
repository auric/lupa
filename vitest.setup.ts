import { vi } from 'vitest';

// Global setup for all tests
vi.mock('vscode', () => {
    return require('./__mocks__/vscode.js');
});

// Add any other global mocks or setup here