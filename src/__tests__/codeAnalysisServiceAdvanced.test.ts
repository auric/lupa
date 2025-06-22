import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';
import * as path from 'path';

describe('CodeAnalysisService - Advanced Scenarios', () => {
    let service: CodeAnalysisService;

    beforeAll(async () => {
        const extensionPath = path.resolve(__dirname, '..', '..');
        // Set a longer timeout for WASM compilation in Vitest
        vi.setConfig({ testTimeout: 30000 });
        await CodeAnalysisServiceInitializer.initialize(extensionPath);
        service = new CodeAnalysisService();
    });

    afterAll(() => {
        if (service) {
            service.dispose();
        }
    });

    describe('Symbol Finding (`findSymbols`)', () => {
        it('should find symbol for anonymous function assigned to a const in TypeScript', async () => {
            const code = `export const myArrowFunction = () => { return 1; };`;
            const symbols = await service.findSymbols(code, 'typescript');
            expect(symbols).toContainEqual(expect.objectContaining({
                symbolName: 'myArrowFunction',
                symbolType: 'variable_declarator' // The symbol is the variable that holds the function
            }));
            expect(symbols).toHaveLength(1);

            // Ensure no duplicates
            const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
            const uniqueSymbolKeys = new Set(symbolKeys);
            expect(uniqueSymbolKeys.size).toBe(symbols.length);
        });

        it('should correctly identify various top-level CSS rules as symbol names', async () => {
            const code = `
@import "my-styles.css";
@layer utilities;

@keyframes slidein {
  from {
    transform: translateX(0%);
  }
  to {
    transform: translateX(100%);
  }
}

.container > .item, #main {
    color: blue;
}

@media (max-width: 600px) {
    body {
        background-color: #f0f0f0;
    }
}
`;
            const symbols = await service.findSymbols(code, 'css');
            const symbolNames = symbols.map(s => s.symbolName);

            expect(symbolNames).toContain('@import "my-styles.css"');
            expect(symbolNames).toContain('@layer utilities');
            expect(symbolNames).toContain('@keyframes slidein');
            expect(symbolNames).toContain('.container > .item, #main');
            expect(symbolNames).toContain('@media (max-width: 600px)');

            // Nested rules should NOT be included.
            expect(symbolNames).not.toContain('body');
            expect(symbolNames).not.toContain('from');
            expect(symbolNames).not.toContain('to');

            // Ensure no duplicates
            const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
            const uniqueSymbolKeys = new Set(symbolKeys);
            expect(uniqueSymbolKeys.size).toBe(symbols.length);
        });

        it('should find nested symbols like methods within a class', async () => {
            const code = `
class MyClass {
    constructor() {}

    myMethod() {
        return "hello";
    }
}
`;
            const symbols = await service.findSymbols(code, 'typescript');
            const symbolNames = symbols.map(s => s.symbolName);

            expect(symbolNames).toContain('MyClass');
            expect(symbolNames).toContain('myMethod'); // This would fail with the old logic

            const classSymbol = symbols.find(s => s.symbolName === 'MyClass');
            const methodSymbol = symbols.find(s => s.symbolName === 'myMethod');

            expect(classSymbol?.symbolType).toBe('class_declaration');
            expect(methodSymbol?.symbolType).toBe('method_definition');

            // Ensure no duplicates
            const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
            const uniqueSymbolKeys = new Set(symbolKeys);
            expect(uniqueSymbolKeys.size).toBe(symbols.length);
        });

        it('should handle TSX syntax correctly', async () => {
            const code = `
import React from 'react';

const MyComponent = ({ name }: { name: string }) => {
    return <div>Hello, {name}</div>;
};
`;
            const symbols = await service.findSymbols(code, 'typescript', 'tsx');
            expect(symbols).toContainEqual(expect.objectContaining({
                symbolName: 'MyComponent',
                symbolType: 'variable_declarator',
                position: { line: 3, character: 6 }
            }));

            // Ensure no duplicates
            const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
            const uniqueSymbolKeys = new Set(symbolKeys);
            expect(uniqueSymbolKeys.size).toBe(symbols.length);
        });
    });

    describe('Breakpoint Lines (`getLinesForPointsOfInterest`)', () => {
        it('should not associate a comment if a non-comment code line is between it and the POI', async () => {
            const code = `
// This comment is for MyClass
const x = 1;
class MyClass {}
`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // The line \`const x = 1;\` breaks the association.
            // So the POI line for MyClass should be its own line (3), not the comment line (1).
            expect(lines).toContain(3);
            expect(lines).not.toContain(1);
        });

        it('should return the POI line for comments on the same line', async () => {
            const code = `class MyClass {} // This is a class`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // The POI is the class on line 1 (index 0). The comment doesn't precede it.
            expect(lines).toEqual([0]);
        });

        it('should handle multiple POIs with and without comments correctly', async () => {
            const code = `
// Comment for FuncA
function FuncA() {}

function FuncB() {} // No preceding comment

/**
 * Comment for ClassC
 */
class ClassC {}
`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // FuncA -> line 1 (comment)
            // FuncB -> line 4 (itself)
            // ClassC -> line 6 (comment)
            expect(lines).toEqual([1, 4, 6]);
        });
    });

    describe('Service Lifecycle', () => {
        it('should not process requests after being disposed', async () => {
            const localService = new CodeAnalysisService();
            localService.dispose(); // Dispose the service

            // Spy on console.warn
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const symbols = await localService.findSymbols('const a = 1;', 'javascript');
            expect(symbols).toEqual([]);

            const lines = await localService.getLinesForPointsOfInterest('const a = 1;', 'javascript');
            expect(lines).toEqual([]);

            const tree = await localService.parseCode('const a = 1;', 'javascript');
            expect(tree).toBeNull();

            // Check that warnings were logged
            expect(consoleWarnSpy).toHaveBeenCalledWith('CodeAnalysisService is disposed. Cannot parse code.');

            // Clean up spy
            consoleWarnSpy.mockRestore();
        });
    });
});