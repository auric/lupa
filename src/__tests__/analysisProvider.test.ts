import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisProvider } from '../services/analysisProvider';
import { ContextProvider } from '../services/contextProvider';
import { CopilotModelManager } from '../models/copilotModelManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet, DiffHunk, HybridContextResult } from '../types/contextTypes';
import { TokenManagerService } from '../services/tokenManagerService';
import { PromptGenerator } from '../models/promptGenerator';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        CancellationTokenSource: vi.fn(() => ({
            token: { get isCancellationRequested() { return false; }, onCancellationRequested: vi.fn() },
            cancel: vi.fn(),
            dispose: vi.fn()
        })),
        workspace: {
            ...(actualVscode.workspace || {}),
            getConfiguration: vi.fn().mockReturnValue({
                get: vi.fn((key: string) => {
                    if (key === 'copilot.model') return 'gpt-4';
                    return undefined;
                }),
            }),
        },
        ProgressLocation: { Notification: 15 },
    };
});

// Mock Language Model
const mockLanguageModel = {
    id: 'copilot-gpt-4',
    name: 'GPT-4',
    family: 'gpt-4',
    maxInputTokens: 8000,
    countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 4)),
    sendRequest: vi.fn().mockImplementation(async (messages, _options, _token) => {
        // Simulate a streaming response
        async function* generateResponse() {
            yield "Mocked LLM analysis result."; // Yield the string directly
        }
        return { text: generateResponse() };
    }),
    onDidChange: vi.fn(),
};

// Mock CopilotModelManager
vi.mock('../models/copilotModelManager', () => ({
    CopilotModelManager: vi.fn().mockImplementation(() => ({
        getCurrentModel: vi.fn().mockResolvedValue(mockLanguageModel),
        listAvailableModels: vi.fn().mockResolvedValue([mockLanguageModel]),
    })),
}));

// Mock ContextProvider
const mockContextProviderInstance = {
    getContextForDiff: vi.fn(),
    getInstance: vi.fn(),
    dispose: vi.fn(),
};
vi.mock('../services/contextProvider', () => ({
    ContextProvider: {
        getInstance: vi.fn()
    } as unknown as ContextProvider,
}));

// Mock TokenManagerService - we will test its interaction, not its internal logic here
const mockTokenManagerInstance = {
    getSystemPromptForMode: vi.fn((mode: AnalysisMode) => `System prompt for ${mode}`),
    getResponsePrefill: vi.fn(() => 'I\'ll analyze this pull request comprehensively.\n\n## Analysis\n\n'),
    calculateTokenAllocation: vi.fn(),
    optimizeContext: vi.fn(),
    formatContextSnippetsToString: vi.fn((snippets, _truncated) => snippets.map(s => s.content).join('\n\n')),
    formatContextSnippetsForDisplay: vi.fn((snippets, _truncated) => snippets.map(s => s.content).join('\n\n')),
    calculateTokens: vi.fn(async (text: string) => Math.ceil(text.length / 4)),
    calculateCompleteMessageTokens: vi.fn(async (systemPrompt: string, userPrompt: string, responsePrefill?: string) => {
        // Mock implementation that returns reasonable token counts
        const systemTokens = Math.ceil(systemPrompt.length / 4) + 5; // content + overhead
        const userTokens = Math.ceil(userPrompt.length / 4) + 5; // content + overhead
        const prefillTokens = responsePrefill ? Math.ceil(responsePrefill.length / 4) + 5 : 0; // content + overhead if provided
        return systemTokens + userTokens + prefillTokens;
    }),
    // New methods from Story 1.1 refactoring
    setContentPrioritization: vi.fn(),
    getContentPrioritization: vi.fn(() => ({
        order: ['diff', 'embeddings', 'lsp-references', 'lsp-definitions']
    })),
    performProportionalTruncation: vi.fn(),
};
// Mock few-shot examples
const mockFewShotExamples = [
    {
        scenario: "Test scenario",
        code: "test code",
        review: "<suggestion-security>Test suggestion</suggestion-security>"
    }
];

vi.mock('../services/tokenManagerService', () => ({
    TokenManagerService: vi.fn(() => mockTokenManagerInstance),
}));


describe('AnalysisProvider', () => {
    let analysisProvider: AnalysisProvider;
    let contextProvider: ContextProvider;
    let modelManager: CopilotModelManager;
    let promptGenerator: PromptGenerator;
    let mockExtensionContext: vscode.ExtensionContext;

    beforeEach(() => {
        vi.clearAllMocks();

        // 1. Re-establish constructor mock implementations
        vi.mocked(CopilotModelManager).mockImplementation(() => {
            return {
                getCurrentModel: vi.fn().mockResolvedValue(mockLanguageModel),
                listAvailableModels: vi.fn().mockResolvedValue([mockLanguageModel]),
                // Add any other methods of CopilotModelManager that your code might call
            } as unknown as CopilotModelManager;
        });

        vi.mocked(ContextProvider.getInstance).mockImplementation(() => mockContextProviderInstance as unknown as ContextProvider);
        vi.mocked(TokenManagerService).mockImplementation(() => mockTokenManagerInstance as unknown as TokenManagerService);

        // 2. Re-establish specific behavior for vscode.workspace.getConfiguration
        // The getConfiguration function itself needs to return our mock object.
        // The get function on that returned object needs its specific implementation.
        const mockVscodeGet = vi.fn((key: string) => {
            if (key === 'copilot.model') return 'gpt-4';
            return undefined;
        });
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
            get: mockVscodeGet,
            update: vi.fn().mockResolvedValue(undefined),
            has: vi.fn().mockReturnValue(false), // Or true based on needs
            inspect: vi.fn() // Or a more detailed mock if needed
        } as unknown as vscode.WorkspaceConfiguration);

        vi.mocked(vscode.LanguageModelChatMessage.User).mockImplementation(
            (
                inputContent: string | Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart>,
                name?: string
            ) => {
                const processedContent = typeof inputContent === 'string'
                    ? [{ value: inputContent } as vscode.LanguageModelTextPart] // Ensure content is an array
                    : inputContent;
                return {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: name,
                    content: processedContent,
                } as vscode.LanguageModelChatMessage;
            }
        );
        vi.mocked(vscode.LanguageModelChatMessage.Assistant).mockImplementation(
            (
                inputContent: string | Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>, // Corrected parameter type
                name?: string
            ) => {
                const processedContent = typeof inputContent === 'string'
                    ? [{ value: inputContent } as vscode.LanguageModelTextPart] // Ensure content is an array
                    : inputContent;
                return {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    name: name || 'Assistant',
                    content: processedContent,
                } as vscode.LanguageModelChatMessage;
            }
        );

        vi.mocked(vscode.CancellationTokenSource).mockImplementation(() => {
            const listeners: Array<(e: any) => any> = [];
            let isCancelled = false;

            const token: vscode.CancellationToken = {
                get isCancellationRequested() { return isCancelled; },
                onCancellationRequested: vi.fn((listener: (e: any) => any) => {
                    listeners.push(listener);
                    return {
                        dispose: vi.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) {
                                listeners.splice(index, 1);
                            }
                        })
                    };
                })
            };

            return {
                token: token,
                cancel: vi.fn(() => {
                    isCancelled = true;
                    // Create a copy of listeners array before iteration
                    [...listeners].forEach(listener => listener(undefined)); // Pass undefined or a specific event if needed
                }),
                dispose: vi.fn()
            } as unknown as vscode.CancellationTokenSource; // Cast to assure TS it's a CancellationTokenSource
        });

        mockExtensionContext = {
            extensionPath: '/mock/extension/path',
            subscriptions: [],
            // Add other properties VS Code expects on an ExtensionContext
            workspaceState: { get: vi.fn(), update: vi.fn(), keys: vi.fn() },
            globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(), setKeysForSync: vi.fn() },
            secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() },
            extensionUri: vscode.Uri.file('/mock/extension/path'),
            storageUri: vscode.Uri.file('/mock/storage/path'),
            globalStorageUri: vscode.Uri.file('/mock/globalStorage/path'),
            logUri: vscode.Uri.file('/mock/log/path'),
            extensionMode: vscode.ExtensionMode.Test,
            extension: { id: 'test.extension', extensionPath: '/mock/extension/path', isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, exports: {} },
            environmentVariableCollection: { persistent: false, replace: vi.fn(), append: vi.fn(), prepend: vi.fn(), get: vi.fn(), delete: vi.fn(), clear: vi.fn(), [Symbol.iterator]: vi.fn() }
        } as unknown as vscode.ExtensionContext;

        contextProvider = mockContextProviderInstance as unknown as ContextProvider;
        const workspaceSettingsService = new WorkspaceSettingsService(mockExtensionContext);
        modelManager = new CopilotModelManager(workspaceSettingsService);
        promptGenerator = new PromptGenerator();
        analysisProvider = new AnalysisProvider(
            contextProvider,
            modelManager,
            mockTokenManagerInstance as unknown as TokenManagerService,
            promptGenerator
        );

        // 3. Reset/re-implement methods on mock instances (already doing this well)
        vi.mocked(mockContextProviderInstance.getContextForDiff).mockReset();
        vi.mocked(mockTokenManagerInstance.calculateTokenAllocation).mockReset();
        vi.mocked(mockTokenManagerInstance.optimizeContext).mockReset();
        vi.mocked(mockTokenManagerInstance.formatContextSnippetsToString).mockImplementation((snippets, _truncated) => snippets.map(s => s.content).join('\n\n'));
        vi.mocked(mockTokenManagerInstance.calculateTokens).mockReset().mockImplementation(async (text: string) => Math.ceil(text.length / 4)); // Add this line for reset
        vi.mocked(mockTokenManagerInstance.calculateCompleteMessageTokens).mockReset().mockImplementation(async (systemPrompt: string, userPrompt: string, responsePrefill?: string) => {
            const systemTokens = Math.ceil(systemPrompt.length / 4) + 5;
            const userTokens = Math.ceil(userPrompt.length / 4) + 5;
            const prefillTokens = responsePrefill ? Math.ceil(responsePrefill.length / 4) + 5 : 0;
            return systemTokens + userTokens + prefillTokens;
        });

        // Ensure methods on mockLanguageModel are reset/re-implemented if they were vi.fn()
        // sendRequest is already re-implemented below, countTokens might need .mockReset() if its state matters between tests
        vi.mocked(mockLanguageModel.countTokens).mockReset().mockImplementation(async (text: string) => Math.ceil(text.length / 4));
        vi.mocked(mockLanguageModel.sendRequest).mockClear().mockImplementation(async (messages, _options, _token) => {
            async function* generateResponse() {
                yield "Mocked LLM analysis result."; // Yield the string directly
            }
            return { text: generateResponse() };
        });

    });

    it('should analyze pull request and return analysis and context', async () => {
        const diffText = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-console.log("old");\n+console.log("new");';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const mockSnippets: ContextSnippet[] = [
            { id: 's1', type: 'embedding', content: 'Snippet 1 content', relevanceScore: 0.8, filePath: 'file1.ts', startLine: 10, associatedHunkIdentifiers: ['file.ts:L1'] },
        ];
        const mockParsedDiff: DiffHunk[] = [
            { filePath: 'file.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-console.log("old");', '+console.log("new");'], hunkId: 'file.ts:L1' }] }
        ];
        const mockHybridResult: HybridContextResult = { snippets: mockSnippets, parsedDiff: mockParsedDiff };

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            fitsWithinLimit: true, // optimizeContext will not be called, optimizedSnippets will be mockSnippets
            totalAvailableTokens: 7600,
            totalRequiredTokens: 1000,
            systemPromptTokens: 50,
            diffTextTokens: 100,
            contextTokens: 200,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
        });
        // Since fitsWithinLimit is true, optimizeContext is not strictly called for reduction,
        // but analyzeWithLanguageModel will call it to get the { optimizedSnippets, wasTruncated } structure.
        // We'll mock it to return the initial snippets as if no optimization was needed.
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: mockSnippets, wasTruncated: false });


        const result = await analysisProvider.analyzePullRequest(diffText, gitRootPath, mode);

        expect(mockContextProviderInstance.getContextForDiff).toHaveBeenCalledWith(diffText, gitRootPath, undefined, mode, expect.any(Function), undefined);
        expect(mockTokenManagerInstance.calculateTokenAllocation).toHaveBeenCalled();
        // optimizeContext IS called to get the structured snippets, even if no actual optimization occurs
        expect(mockTokenManagerInstance.optimizeContext).toHaveBeenCalledWith(mockSnippets, 7385);
        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();

        // Verify interleaved prompt structure
        const sentMessages = vi.mocked(mockLanguageModel.sendRequest).mock.calls[0][0];
        const systemPromptMessageContent = (sentMessages[0].content as Array<vscode.LanguageModelTextPart>)[0].value;
        const interleavedUserMessageContent = (sentMessages[1].content as Array<vscode.LanguageModelTextPart>)[0].value;


        expect(systemPromptMessageContent).toContain('System prompt for comprehensive');

        expect(interleavedUserMessageContent).toContain('<path>file.ts</path>');
        expect(interleavedUserMessageContent).toContain('@@ -1,1 +1,1 @@'); // Hunk header from diffText
        expect(interleavedUserMessageContent).toContain('-console.log("old");\n+console.log("new");'); // Hunk lines
        expect(interleavedUserMessageContent).toContain('<context>');
        expect(interleavedUserMessageContent).toContain('Snippet 1 content');
        expect(interleavedUserMessageContent).toContain('</context>');

        expect(result.analysis).toBe("Mocked LLM analysis result.");
        // result.context is now the string formatted from optimizedSnippets
        expect(mockTokenManagerInstance.formatContextSnippetsToString).toHaveBeenCalledWith(mockSnippets, false);
        expect(result.context).toBe("Snippet 1 content");
    });

    it('should call optimizeContext and build interleaved prompt when context exceeds token limits', async () => {
        const diffText = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Critical;
        const allSnippets: ContextSnippet[] = [
            { id: 's1', type: 'lsp-definition', content: 'Long snippet 1 DEF', relevanceScore: 1.0, associatedHunkIdentifiers: ['file.ts:L1'] },
            { id: 's2', type: 'embedding', content: 'Long snippet 2 EMB', relevanceScore: 0.7, associatedHunkIdentifiers: ['file.ts:L1'] },
            { id: 's3', type: 'embedding', content: 'Unrelated snippet', relevanceScore: 0.6 }, // Should be filtered by hunk or optimization
        ];
        const optimizedSnippetsFromManager: ContextSnippet[] = [ // What optimizeContext returns
            { id: 's1', type: 'lsp-definition', content: 'Long snippet 1 DEF', relevanceScore: 1.0, associatedHunkIdentifiers: ['file.ts:L1'] },
        ];
        const mockParsedDiff: DiffHunk[] = [
            { filePath: 'file.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'], hunkId: 'file.ts:L1' }] }
        ];
        const mockHybridResult: HybridContextResult = { snippets: allSnippets, parsedDiff: mockParsedDiff };


        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            fitsWithinLimit: false, // Key for this test
            contextAllocationTokens: 10, // Very small budget, forcing optimization
            totalAvailableTokens: 7600,
            totalRequiredTokens: 8000,
            systemPromptTokens: 50,
            diffTextTokens: 100,
            contextTokens: 7800,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
        });
        // optimizeContext will be called and should return the subset
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: optimizedSnippetsFromManager, wasTruncated: true });
        // formatContextSnippetsToString will be called with the result of optimizeContext
        mockTokenManagerInstance.formatContextSnippetsToString.mockImplementation((snippets, truncated) => {
            const content = snippets.map(s => s.content).join('\n\n');
            return content + (truncated ? " [Truncated]" : "");
        });


        const result = await analysisProvider.analyzePullRequest(diffText, gitRootPath, mode);

        expect(mockContextProviderInstance.getContextForDiff).toHaveBeenCalled();
        expect(mockTokenManagerInstance.calculateTokenAllocation).toHaveBeenCalled();
        expect(mockTokenManagerInstance.optimizeContext).toHaveBeenCalledWith(allSnippets, 7385); // Called with all snippets and budget
        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();

        // Verify interleaved prompt structure
        const sentMessages = vi.mocked(mockLanguageModel.sendRequest).mock.calls[0][0];
        const systemPromptMessageContent = (sentMessages[0].content as Array<vscode.LanguageModelTextPart>)[0].value;
        const interleavedUserMessageContent = (sentMessages[1].content as Array<vscode.LanguageModelTextPart>)[0].value;

        expect(systemPromptMessageContent).toContain('System prompt for critical');

        expect(interleavedUserMessageContent).toContain('<path>file.ts</path>');
        expect(interleavedUserMessageContent).toContain('@@ -1,1 +1,1 @@');
        expect(interleavedUserMessageContent).toContain('-old\n+new');
        expect(interleavedUserMessageContent).toContain('<context>');
        expect(interleavedUserMessageContent).toContain('Long snippet 1 DEF'); // Only the optimized snippet
        expect(interleavedUserMessageContent).not.toContain('Long snippet 2 EMB');
        expect(interleavedUserMessageContent).not.toContain('Unrelated snippet');
        expect(interleavedUserMessageContent).toContain('</context>');


        expect(result.analysis).toBe("Mocked LLM analysis result.");
        expect(mockTokenManagerInstance.formatContextSnippetsToString).toHaveBeenCalledWith(optimizedSnippetsFromManager, true);
        expect(result.context).toBe("Long snippet 1 DEF [Truncated]");
    });

    it('should handle cancellation during context retrieval', async () => {
        const diffText = 'diff text';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const cancellationToken = new vscode.CancellationTokenSource().token;
        vi.spyOn(cancellationToken, 'isCancellationRequested', 'get').mockReturnValue(true);

        mockContextProviderInstance.getContextForDiff.mockImplementation(async (_d, _g, _o, _m, _sP, _pC, ct) => {
            if (ct?.isCancellationRequested) throw new Error('Operation cancelled');
            // Return a valid HybridContextResult structure even if empty
            return { snippets: [], parsedDiff: [] };
        });

        await expect(analysisProvider.analyzePullRequest(diffText, gitRootPath, mode, undefined, cancellationToken))
            .rejects.toThrow('Operation cancelled');
    });

    it('should handle cancellation during LLM analysis', async () => {
        const diffText = 'diff text';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const mockSnippets: ContextSnippet[] = [{ id: 's1', type: 'embedding', content: 'Snippet 1', relevanceScore: 0.8, filePath: 'file.ts', startLine: 1 }];
        const mockParsedDiff: DiffHunk[] = [{ filePath: 'file.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'], hunkId: 'h1' }] }];
        const mockHybridResult: HybridContextResult = { snippets: mockSnippets, parsedDiff: mockParsedDiff };


        // Use a real CancellationTokenSource for the external token
        const externalCancellationSource = new vscode.CancellationTokenSource();
        const externalCancellationToken = externalCancellationSource.token;

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            fitsWithinLimit: true,
            contextAllocationTokens: 500,
            totalAvailableTokens: 7600,
            totalRequiredTokens: 1000,
            systemPromptTokens: 50,
            diffTextTokens: 100,
            contextTokens: 200,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
        });
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: mockSnippets, wasTruncated: false });


        vi.mocked(mockLanguageModel.sendRequest).mockImplementation(async (_messages, _options, internalToken) => {
            // internalToken is the requestTokenSource.token from AnalysisProvider
            async function* generateResponse() {
                yield "Initial chunk. "; // First chunk for AP to process

                // Cancel the external token, which should propagate to the internalToken
                externalCancellationSource.cancel();

                // Give ample time for the onCancellationRequested callback to fire
                // and for the AnalysisProvider's internal token to be cancelled.
                // The generator will then end. The AP loop should detect cancellation
                // before or as this stream ends.
                await new Promise(resolve => setTimeout(resolve, 30));

                // The generator now simply ends.
                // If internalToken was cancelled, AP should have thrown.
                // If AP didn't throw, the test will fail because the promise resolves.
            }
            return { text: generateResponse() };
        });

        // No need to spy on vscode.CancellationTokenSource for this specific test case anymore,
        // as we are directly controlling the external token and observing its effect on the internal one.

        await expect(analysisProvider.analyzePullRequest(diffText, gitRootPath, mode, undefined, externalCancellationToken))
            .rejects.toThrow(/Operation cancelled by token|Operation cancelled during model response streaming|Operation cancelled/);

        externalCancellationSource.dispose(); // Clean up the source
    });

    it('should correctly calculate and use diffText for token allocation', async () => {
        const diffText = 'diff --git a/file1.ts b/file1.ts\n--- a/file1.ts\n+++ b/file1.ts\n@@ -1,2 +1,2 @@\n-old line 1\n-old line 2\n+new line 1\n+new line 2\n';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const mockSnippets: ContextSnippet[] = [
            { id: 's1', type: 'embedding', content: 'Snippet for hunk 1', relevanceScore: 0.9, filePath: 'file1.ts', startLine: 10, associatedHunkIdentifiers: ['file1.ts:L1'] },
        ];
        const mockParsedDiff: DiffHunk[] = [
            {
                filePath: 'file1.ts',
                hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old line 1', '-old line 2', '+new line 1', '+new line 2'], hunkId: 'file1.ts:L1' }]
            }
        ];
        const mockHybridResult: HybridContextResult = { snippets: mockSnippets, parsedDiff: mockParsedDiff };

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);

        // 1. Manually construct the expected diffStructureForTokenCalc string with XML structure
        const instructionsXmlForCalc = `<instructions>
Analyze the following pull request changes step-by-step:

1. Review the provided context to understand the broader codebase structure and patterns
2. Examine each modified file and understand what changes are being made
3. Consider how these changes affect the overall system architecture and functionality
4. Assess code quality, security, performance, and maintainability implications
5. Compare against established software engineering best practices and industry standards
6. Formulate specific, actionable suggestions for improvement

Structure your response using XML tags for different types of feedback:
- <suggestion-security> for security recommendations
- <suggestion-performance> for performance optimizations
- <suggestion-maintainability> for code organization and readability
- <suggestion-reliability> for error handling and robustness
- <suggestion-type-safety> for type system improvements and runtime safety
- <example_fix> for concrete code examples
- <explanation> for detailed reasoning
</instructions>\n\n`;

        // Few-shot examples section for token calculation
        let examplesXmlForCalc = '<examples>\n';
        mockFewShotExamples.forEach((example, index) => {
            examplesXmlForCalc += `<example id="${index + 1}">\n`;
            examplesXmlForCalc += `<scenario>${example.scenario}</scenario>\n`;
            examplesXmlForCalc += `<code>\n${example.code}\n</code>\n`;
            examplesXmlForCalc += `<review>\n${example.review}\n</review>\n`;
            examplesXmlForCalc += '</example>\n\n';
        });
        examplesXmlForCalc += '</examples>\n\n';

        const contextXmlPlaceholderForCalc = "<context>\n[CONTEXT_PLACEHOLDER]\n</context>\n\n";

        let fileContentXmlForCalc = "<files_to_review>\n";
        fileContentXmlForCalc += `<file>\n<path>${mockParsedDiff[0].filePath}</path>\n<changes>\n`;
        fileContentXmlForCalc += `@@ -1,2 +1,2 @@\n`; // Hunk header from diffText
        fileContentXmlForCalc += mockParsedDiff[0].hunks[0].lines.join('\n') + '\n\n';
        fileContentXmlForCalc += "</changes>\n</file>\n\n";
        fileContentXmlForCalc += "</files_to_review>\n\n";

        const MOCKED_DIFF_TEXT_TOKENS = 100; // Tokens for the actual diff text

        const totalAvailableTokens = 7600; // Mocked total available tokens
        const systemPromptTokens = 50;
        const diffTextTokens = MOCKED_DIFF_TEXT_TOKENS;
        const responsePrefillTokens = 0;
        const messageOverheadTokens = 15;
        const otherTokens = 50;
        // Spy and mock calculateTokenAllocation
        vi.mocked(mockTokenManagerInstance.calculateTokenAllocation).mockImplementation(async (components, _analysisMode) => {
            // 3. Assert that diffText is passed correctly (no longer using diffStructureTokens)
            expect(components.diffText).toBe(diffText);
            expect(components.diffStructureTokens).toBeUndefined(); // Should not be present in unified approach
            return {
                fitsWithinLimit: true,
                totalAvailableTokens: totalAvailableTokens,
                systemPromptTokens: systemPromptTokens,
                diffTextTokens: diffTextTokens, // This field in result should reflect diffText tokens
                contextTokens: 20, // Mocked preliminary context tokens
                userMessagesTokens: 0,
                assistantMessagesTokens: 0,
                responsePrefillTokens: responsePrefillTokens,
                messageOverheadTokens: messageOverheadTokens,
                otherTokens: otherTokens,
            };
        });

        // Mock optimizeContext to check its budget argument
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: mockSnippets, wasTruncated: false });

        await analysisProvider.analyzePullRequest(diffText, gitRootPath, mode);

        const nonContextTokens = systemPromptTokens + diffTextTokens + responsePrefillTokens + messageOverheadTokens + otherTokens;

        // 4. Verify optimizeContext was called with the correct budget
        expect(mockTokenManagerInstance.optimizeContext).toHaveBeenCalledWith(
            mockSnippets,
            totalAvailableTokens - nonContextTokens
        );

        // Ensure other main mocks were called
        expect(mockContextProviderInstance.getContextForDiff).toHaveBeenCalled();
        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();
    });

    it('should include context markers in final prompt even if a hunk has no optimized snippets', async () => {
        const diffText = 'diff --git a/file.empty.ts b/file.empty.ts\n--- a/file.empty.ts\n+++ b/file.empty.ts\n@@ -1,1 +1,1 @@\n-old content\n+new content\n';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const mockSnippets: ContextSnippet[] = [
            // No snippets, or snippets not associated with 'file.empty.ts:L1'
            { id: 's-other', type: 'embedding', content: 'Some other snippet', relevanceScore: 0.5, filePath: 'other.ts', startLine: 1, associatedHunkIdentifiers: ['other.ts:L1'] }
        ];
        const mockParsedDiff: DiffHunk[] = [
            {
                filePath: 'file.empty.ts',
                hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old content', '+new content'], hunkId: 'file.empty.ts:L1' }]
            }
        ];
        const mockHybridResult: HybridContextResult = { snippets: mockSnippets, parsedDiff: mockParsedDiff };

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);

        // Mock token calculations - values are not critical for this test's assertion, just need to allow flow
        mockTokenManagerInstance.calculateTokens.mockResolvedValue(50); // For diffStructureForTokenCalc
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            fitsWithinLimit: true,
            contextAllocationTokens: 1000, // Ample budget
            totalAvailableTokens: 7000,
            totalRequiredTokens: 600,
            systemPromptTokens: 50,
            diffTextTokens: 50, // from calculateTokens
            contextTokens: 10, // from preliminaryContextStringForAllSnippets
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
        });

        // Key mock for this test: optimizeContext returns NO snippets for the hunk
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: [], wasTruncated: false });

        // formatContextSnippetsToString will be called with empty snippets
        mockTokenManagerInstance.formatContextSnippetsToString.mockImplementation((snippets, _truncated) => {
            if (snippets.length === 0) return "No relevant context snippets were selected or found."; // Simulate its behavior
            return snippets.map(s => s.content).join('\n\n');
        });

        await analysisProvider.analyzePullRequest(diffText, gitRootPath, mode);

        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();
        const sentMessages = vi.mocked(mockLanguageModel.sendRequest).mock.calls[0][0];
        const interleavedUserMessageContent = (sentMessages[1].content as Array<vscode.LanguageModelTextPart>)[0].value;

        // Check that XML structure is present
        expect(interleavedUserMessageContent).toContain('<instructions>');
        expect(interleavedUserMessageContent).toContain('<files_to_review>');
        expect(interleavedUserMessageContent).toContain(`<path>${mockParsedDiff[0].filePath}</path>`);
        expect(interleavedUserMessageContent).toContain(`@@ -1,1 +1,1 @@`);
        expect(interleavedUserMessageContent).toContain(mockParsedDiff[0].hunks[0].lines.join('\n'));
        expect(interleavedUserMessageContent).toContain('</files_to_review>');

        // Since there are no optimized snippets, there shouldn't be a context section
        expect(interleavedUserMessageContent).not.toContain('<context>');
        expect(interleavedUserMessageContent).not.toContain("Some other snippet");


    });

    it('should not include <context> tag when no snippets are available', async () => {
        const diffText = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-console.log("old");\n+console.log("new");';
        const gitRootPath = '/test/repo';
        const mode = AnalysisMode.Comprehensive;
        const mockHybridResult: HybridContextResult = {
            snippets: [], // No snippets
            parsedDiff: [
                { filePath: 'file.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-console.log("old");', '+console.log("new");'], hunkId: 'file.ts:L1' }] }
            ]
        };

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            fitsWithinLimit: true,
            contextAllocationTokens: 5000,
            totalAvailableTokens: 7600,
            totalRequiredTokens: 1000,
            systemPromptTokens: 50,
            diffTextTokens: 100,
            contextTokens: 200,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
        });
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: [], wasTruncated: false });

        await analysisProvider.analyzePullRequest(diffText, gitRootPath, mode);

        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();
        const sentMessages = vi.mocked(mockLanguageModel.sendRequest).mock.calls[0][0];
        const userMessageContent = (sentMessages[1].content as Array<vscode.LanguageModelTextPart>)[0].value;

        expect(userMessageContent).not.toContain('<context>');
        expect(userMessageContent).not.toContain('</context>');
        expect(userMessageContent).toContain('<files_to_review>');
    });

    it('should structure prompt with XML tags', async () => {
        const diffText = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-console.log("old");\n+console.log("new");';
        const mockAnalysis = 'Mocked XML-structured analysis result.';

        // Set up mock context data
        const mockSnippets: ContextSnippet[] = [
            { id: 's1', type: 'embedding', content: 'Test snippet content', relevanceScore: 0.9, filePath: 'file.ts', startLine: 10 }
        ];
        const mockParsedDiff: DiffHunk[] = [
            {
                filePath: 'file.ts',
                hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-console.log("old");', '+console.log("new");'], hunkId: 'file.ts:L1' }]
            }
        ];
        const mockHybridResult: HybridContextResult = { snippets: mockSnippets, parsedDiff: mockParsedDiff };

        mockContextProviderInstance.getContextForDiff.mockResolvedValue(mockHybridResult);

        // Set up token manager mocks
        mockTokenManagerInstance.calculateTokenAllocation.mockResolvedValue({
            totalAvailableTokens: 8000,
            totalRequiredTokens: 1000,
            systemPromptTokens: 50,
            diffTextTokens: 100,
            contextTokens: 200,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            responsePrefillTokens: 0,
            messageOverheadTokens: 15,
            otherTokens: 50,
            fitsWithinLimit: true,
            contextAllocationTokens: 5000
        });
        mockTokenManagerInstance.optimizeContext.mockResolvedValue({ optimizedSnippets: mockSnippets, wasTruncated: false });
        mockTokenManagerInstance.formatContextSnippetsForDisplay.mockReturnValue('Test snippet content');

        // Set up mock generation to return our expected analysis
        vi.mocked(mockLanguageModel.sendRequest).mockImplementation(async (messages, _options, _token) => {
            async function* generateResponse() {
                yield mockAnalysis;
            }
            return { text: generateResponse() };
        });

        const result = await analysisProvider.analyzePullRequest(
            diffText,
            '/mock/git/root',
            AnalysisMode.Comprehensive,
        );

        expect(result.analysis).toBe(mockAnalysis);

        // Verify that the prompt was structured with XML tags
        expect(mockLanguageModel.sendRequest).toHaveBeenCalled();
        const sentMessages = vi.mocked(mockLanguageModel.sendRequest).mock.calls[0][0];
        const userMessageContent = (sentMessages[1].content as Array<vscode.LanguageModelTextPart>)[0].value;

        // Check for new XML structure from PromptGenerator (follows Anthropic guidelines)
        expect(userMessageContent).toContain('<context>');
        expect(userMessageContent).toContain('</context>');
        expect(userMessageContent).toContain('<examples>');
        expect(userMessageContent).toContain('</examples>');
        expect(userMessageContent).toContain('<files_to_review>');
        expect(userMessageContent).toContain('</files_to_review>');
        expect(userMessageContent).toContain('<instructions>');
        expect(userMessageContent).toContain('</instructions>');

        // Verify the order: context, examples, files_to_review, instructions (Anthropic long context optimization)
        const contextIndex = userMessageContent.indexOf('<context>');
        const examplesIndex = userMessageContent.indexOf('<examples>');
        const filesIndex = userMessageContent.indexOf('<files_to_review>');
        const instructionsIndex = userMessageContent.indexOf('<instructions>');

        expect(contextIndex).toBeLessThan(examplesIndex);
        expect(examplesIndex).toBeLessThan(filesIndex);
        expect(filesIndex).toBeLessThan(instructionsIndex);
    });

    // Tests for Story 1.2: Content prioritization integration
    it('should configure content prioritization in TokenManagerService during construction', () => {
        // Verify that setContentPrioritization was called during constructor
        expect(mockTokenManagerInstance.setContentPrioritization).toHaveBeenCalledWith({
            order: ['diff', 'embedding', 'lsp-reference', 'lsp-definition']
        });
    });
});
