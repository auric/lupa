import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelToolProvider } from '../services/languageModelToolProvider';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { Log } from '../services/loggingService';

// Mock dependencies
vi.mock('../services/loggingService');

describe('LanguageModelToolProvider', () => {
    let mockTool: GetSymbolsOverviewTool;
    let originalRegisterTool: typeof vscode.lm.registerTool;

    beforeEach(() => {
        vi.clearAllMocks();
        // Store original to ensure restoration
        originalRegisterTool = vscode.lm.registerTool;

        // Create a mock tool
        mockTool = {
            name: 'get_symbols_overview',
            execute: vi.fn(),
        } as unknown as GetSymbolsOverviewTool;
    });

    afterEach(() => {
        // Restore API after each test
        (vscode.lm as any).registerTool = originalRegisterTool;
    });

    describe('register', () => {
        it('should call vscode.lm.registerTool', () => {
            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            expect(vscode.lm.registerTool).toHaveBeenCalledWith(
                'lupa_getSymbolsOverview',
                expect.objectContaining({
                    invoke: expect.any(Function),
                })
            );
        });

        it('should handle missing API gracefully', () => {
            // Temporarily remove the API
            (vscode.lm as any).registerTool = undefined;

            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Language Model API may not be available'
                )
            );
        });

        it('should log registration success', () => {
            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            expect(Log.info).toHaveBeenCalledWith(
                expect.stringContaining('lupa_getSymbolsOverview registered')
            );
        });
    });

    describe('handleInvoke', () => {
        it('should call tool.execute with full input including filtering options', async () => {
            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            // Get the registered handler
            const registrationCall = vi.mocked(vscode.lm.registerTool).mock
                .calls[0];
            const handler = registrationCall[1];

            const input = {
                path: 'src/test.ts',
                max_depth: 2,
                include_body: true,
                include_kinds: ['class', 'function'],
                exclude_kinds: ['variable'],
                max_symbols: 50,
                show_hierarchy: false,
            };

            vi.mocked(mockTool.execute).mockResolvedValue({
                success: true,
                data: 'symbol data',
            });

            const result = await handler.invoke({ input } as any, {} as any);

            // Verify full input is passed directly - no artificial limitations
            expect(mockTool.execute).toHaveBeenCalledWith(
                input,
                expect.any(Object)
            );

            expect((result as any).content[0].value).toBe('symbol data');
        });

        it('should handle tool errors gracefully', async () => {
            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            const registrationCall = vi.mocked(vscode.lm.registerTool).mock
                .calls[0];
            const handler = registrationCall[1];

            vi.mocked(mockTool.execute).mockResolvedValue({
                success: false,
                error: 'Tool failed',
            });

            const result = await handler.invoke(
                { input: { path: 'test' } } as any,
                {} as any
            );

            expect((result as any).content[0].value).toBe('Error: Tool failed');
        });

        it('should handle exceptions gracefully', async () => {
            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();

            const registrationCall = vi.mocked(vscode.lm.registerTool).mock
                .calls[0];
            const handler = registrationCall[1];

            vi.mocked(mockTool.execute).mockRejectedValue(
                new Error('Unexpected error')
            );

            const result = await handler.invoke(
                { input: { path: 'test' } } as any,
                {} as any
            );

            expect((result as any).content[0].value).toBe(
                'Error: Unexpected error'
            );
            expect(Log.error).toHaveBeenCalled();
        });
    });

    describe('dispose', () => {
        it('should dispose the registration', () => {
            const mockDisposable = { dispose: vi.fn() };
            vi.mocked(vscode.lm.registerTool).mockReturnValue(mockDisposable);

            const provider = new LanguageModelToolProvider(mockTool);
            provider.register();
            provider.dispose();

            expect(mockDisposable.dispose).toHaveBeenCalled();
        });
    });
});
