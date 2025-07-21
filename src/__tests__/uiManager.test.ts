import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UIManager } from '../services/uiManager';
import * as vscode from 'vscode';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        window: {
            createWebviewPanel: vi.fn(() => ({
                webview: {
                    html: '',
                    onDidReceiveMessage: vi.fn(),
                    postMessage: vi.fn(),
                    asWebviewUri: vi.fn().mockImplementation((uri) => uri)
                },
                onDidDispose: vi.fn(),
                dispose: vi.fn()
            })),
            showTextDocument: vi.fn(),
            showErrorMessage: vi.fn(),
            onDidChangeActiveColorTheme: vi.fn(),
            activeColorTheme: {
                kind: 1, // ColorThemeKind.Light
            }
        },
        workspace: {
            openTextDocument: vi.fn()
        },
        Uri: {
            file: vi.fn().mockImplementation((path) => ({ fsPath: path, path })),
            joinPath: vi.fn().mockImplementation((...args) => args.join('/'))
        },
        ViewColumn: {
            One: 1,
            Beside: -2
        },
        ColorThemeKind: {
            Light: 1,
            Dark: 2,
            HighContrast: 3
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({ start, end }))
    };
});

// Mock LoggingService
vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

// Mock StatusBarService
vi.mock('../services/statusBarService', () => ({
    StatusBarService: {
        getInstance: vi.fn(() => ({
            // Mock status bar methods if needed
        }))
    }
}));

describe('UIManager', () => {
    let uiManager: UIManager;
    let mockExtensionContext: vscode.ExtensionContext;
    let mockWebview: any;
    let messageHandler: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create mock extension context
        mockExtensionContext = {
            extensionUri: { path: '/mock/path' }
        } as any;

        // Create mock webview with message handling
        mockWebview = {
            html: '',
            onDidReceiveMessage: vi.fn((handler) => {
                messageHandler = handler;
                return { dispose: vi.fn() };
            }),
            postMessage: vi.fn(),
            asWebviewUri: vi.fn().mockImplementation((uri) => uri)
        };

        // Mock createWebviewPanel to return our controlled webview
        (vscode.window.createWebviewPanel as any).mockReturnValue({
            webview: mockWebview,
            onDidDispose: vi.fn(),
            dispose: vi.fn()
        });

        uiManager = new UIManager(mockExtensionContext, '/mock/git/repo/root');
    });

    describe('displayAnalysisResults', () => {
        it('should create webview panel and set up message handlers', () => {
            const title = 'Test Analysis';
            const diffText = 'diff --git a/file.ts b/file.ts';
            const context = 'Test context';
            const analysis = 'Test analysis';

            const panel = uiManager.displayAnalysisResults(title, diffText, context, analysis);

            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'prAnalyzerResults',
                title,
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );

            expect(mockWebview.onDidReceiveMessage).toHaveBeenCalled();
            expect(panel).toBeDefined();
        });
    });

    describe('openFile message handling', () => {
        beforeEach(() => {
            // Set up webview by calling displayAnalysisResults
            uiManager.displayAnalysisResults('Test', 'diff', 'context', 'analysis');
        });

        it('should handle openFile message with valid file path', async () => {
            const mockDocument = { uri: { fsPath: 'test.ts' } };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.window.showTextDocument as any).mockResolvedValue(undefined);

            const message = {
                command: 'openFile',
                payload: {
                    filePath: '/path/to/test.ts',
                    line: 10,
                    column: 5
                }
            };

            // Simulate message from webview
            await messageHandler(message);

            expect(vscode.Uri.file).toHaveBeenCalledWith('/path/to/test.ts');
            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
                mockDocument,
                expect.objectContaining({
                    viewColumn: vscode.ViewColumn.One,
                    selection: expect.any(Object)
                })
            );
        });

        it('should handle openFile message without line/column', async () => {
            const mockDocument = { uri: { fsPath: 'test.ts' } };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.window.showTextDocument as any).mockResolvedValue(undefined);

            const message = {
                command: 'openFile',
                payload: {
                    filePath: '/path/to/test.ts'
                }
            };

            await messageHandler(message);

            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
                mockDocument,
                expect.objectContaining({
                    viewColumn: vscode.ViewColumn.One
                })
            );
        });

        it('should handle file opening errors gracefully', async () => {
            const error = new Error('File not found');
            (vscode.workspace.openTextDocument as any).mockRejectedValue(error);

            const message = {
                command: 'openFile',
                payload: {
                    filePath: '/path/to/nonexistent.ts'
                }
            };

            await messageHandler(message);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Could not open file: /path/to/nonexistent.ts')
            );
        });

        it('should handle unknown message commands', () => {
            const message = {
                command: 'unknownCommand',
                payload: {}
            };

            // Should not throw
            expect(() => messageHandler(message)).not.toThrow();
        });

        it('should convert 1-based line/column to 0-based for VSCode API', async () => {
            const mockDocument = { uri: { fsPath: 'test.ts' } };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.window.showTextDocument as any).mockResolvedValue(undefined);

            const message = {
                command: 'openFile',
                payload: {
                    filePath: '/path/to/test.ts',
                    line: 1,
                    column: 1
                }
            };

            await messageHandler(message);

            // Check that Position was created with 0-based coordinates (1,1 -> 0,0)
            expect(vscode.Position).toHaveBeenCalledWith(0, 0);
            expect(vscode.Range).toHaveBeenCalled();
        });

        it('should handle negative line/column values', async () => {
            const mockDocument = { uri: { fsPath: 'test.ts' } };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.window.showTextDocument as any).mockResolvedValue(undefined);

            const message = {
                command: 'openFile',
                payload: {
                    filePath: '/path/to/test.ts',
                    line: -5,
                    column: -3
                }
            };

            await messageHandler(message);

            // Should clamp negative values to 0
            expect(vscode.Position).toHaveBeenCalledWith(0, 0);
        });
    });

    describe('theme handling', () => {
        it('should set up theme change listeners', () => {
            uiManager.displayAnalysisResults('Test', 'diff', 'context', 'analysis');

            expect(vscode.window.onDidChangeActiveColorTheme).toHaveBeenCalled();
        });
    });
});