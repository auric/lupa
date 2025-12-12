import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenManagerService } from '../services/tokenManagerService';
import type { ContentPrioritization, TokenAllocation } from '../types/contextTypes';
import { CopilotModelManager } from '../models/copilotModelManager';
import { ContextSnippet } from '../types/contextTypes';
import { AnalysisMode } from '../types/modelTypes';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenConstants } from '../models/tokenConstants';

vi.mock('vscode');
vi.mock('../models/copilotModelManager');

function getTotalRequiredTokens(allocation: TokenAllocation): number {
    return allocation.systemPromptTokens + allocation.diffTextTokens +
        allocation.contextTokens + allocation.userMessagesTokens + allocation.assistantMessagesTokens +
        allocation.responsePrefillTokens + allocation.messageOverheadTokens + allocation.otherTokens;
}

// Helper to create a mock LanguageModelChat
const createMockLanguageModelChat = (maxTokens = 8000, modelFamily = 'mock-family-default') => ({
    id: 'mock-lm-id',
    name: 'Mock Language Model',
    vendor: 'mock-lm-vendor', // Part of vscode.LanguageModelChat
    family: modelFamily,
    version: '1.0.0-mock',
    maxInputTokens: maxTokens,
    sendRequest: vi.fn().mockResolvedValue({}),
    countTokens: vi.fn().mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
        if (typeof text === 'string') {
            return Math.max(1, Math.ceil(text.length / 4));
        } else if (Array.isArray(text)) {
            let totalTokens = 0;
            for (const item of text) {
                // Check if item has a 'content' property that is a string
                if (item && typeof (item as any).content === 'string') {
                    totalTokens += Math.max(1, Math.ceil(((item as any).content as string).length / 4));
                } else {
                    totalTokens += 1; // Add a nominal token count for items without string content
                }
            }
            return totalTokens;
        } else { // LanguageModelChatMessage
            // Check if text has a 'content' property that is a string
            if (text && typeof (text as any).content === 'string') {
                return Math.max(1, Math.ceil(((text as any).content as string).length / 4));
            }
        }
        return 1; // Fallback for unexpected input or if content is not a string
    }),
});


describe('TokenManagerService', () => {
    let promptGenerator: PromptGenerator;
    let tokenManagerService: TokenManagerService;
    let mockModelManager: CopilotModelManager;
    let mockLanguageModel: vscode.LanguageModelChat;

    // Helper function to combine separate context fields for testing
    const combineContextFields = (components: any): string => {
        const contextParts: string[] = [];

        if (components.embeddingContext && components.embeddingContext.length > 0) {
            contextParts.push(components.embeddingContext);
        }

        if (components.lspReferenceContext && components.lspReferenceContext.length > 0) {
            contextParts.push(components.lspReferenceContext);
        }

        if (components.lspDefinitionContext && components.lspDefinitionContext.length > 0) {
            contextParts.push(components.lspDefinitionContext);
        }

        return contextParts.join('\n\n');
    };
    beforeEach(async () => {
        const mockExtensionContext = {
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

        // Reset mocks for CopilotModelManager
        vi.mocked(CopilotModelManager).mockClear();
        const MockedCopilotModelManager = vi.mocked(CopilotModelManager);
        const workspaceSettingsService = new WorkspaceSettingsService(mockExtensionContext);
        mockModelManager = new MockedCopilotModelManager(workspaceSettingsService);

        // mockLanguageModel is the instance that mockModelManager.getCurrentModel() will return.
        // TokenManagerService uses this instance for countTokens and its properties.
        mockLanguageModel = createMockLanguageModelChat(8000, 'gpt-4-test');
        vi.mocked(mockModelManager.getCurrentModel).mockResolvedValue(mockLanguageModel);

        // listAvailableModels returns ModelDetail[] which is used by TokenManagerService's updateModelInfo
        // to get details about the current model (like maxInputTokens and family).
        // The ModelDetail interface is: { id, name, family, version, maxInputTokens }
        vi.mocked(mockModelManager.listAvailableModels).mockResolvedValue([
            {
                id: mockLanguageModel.id, // Match the ID of the model returned by getCurrentModel
                name: mockLanguageModel.name,
                family: mockLanguageModel.family, // Crucial: This family must match for updateModelInfo
                version: mockLanguageModel.version,
                maxInputTokens: mockLanguageModel.maxInputTokens, // Crucial for token limits
            },
            { // Another model, just to make the list non-trivial
                id: 'other-model-id',
                name: 'Other Mock Model',
                family: 'claude-test',
                version: '2.0.0-mock',
                maxInputTokens: 100000,
            }
        ]);

        promptGenerator = new PromptGenerator();
        tokenManagerService = new TokenManagerService(mockModelManager, promptGenerator);
    });

    describe('optimizeContext', () => {
        const createSnippet = (id: string, type: ContextSnippet['type'], content: string, relevanceScore: number): ContextSnippet => ({
            id, type, content, relevanceScore
        });

        it('should select all snippets if they fit within token limit', async () => {
            const snippets: ContextSnippet[] = [
                createSnippet('s1', 'lsp-definition', 'def func(): pass', 1.0),
                createSnippet('s2', 'embedding', 'similar code here', 0.8),
            ];
            // Mock countTokens to ensure snippets fit
            vi.mocked(mockLanguageModel.countTokens).mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
                if (typeof text === 'string') return Math.max(1, Math.ceil(text.length / 4));
                // Basic handling for other types, can be expanded if tests need more detail
                if (Array.isArray(text)) return text.length * 5;
                return 5;
            });

            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, 100);
            expect(optimizedSnippets.length).toBe(2);
            expect(wasTruncated).toBe(false);
        });

        it('should prioritize snippets by relevance (embedding score > LSP ref > LSP def)', async () => {
            const lspDef = createSnippet('lspDef', 'lsp-definition', 'Definition content '.repeat(5), 1.0); // ~25 tokens
            const lspRef = createSnippet('lspRef', 'lsp-reference', 'Reference content '.repeat(5), 0.9); // ~25 tokens
            const highEmb = createSnippet('highEmb', 'embedding', 'High score embedding '.repeat(5), 0.95); // ~25 tokens
            const midEmb = createSnippet('midEmb', 'embedding', 'Mid score embedding '.repeat(5), 0.8);   // ~25 tokens
            const lowEmb = createSnippet('lowEmb', 'embedding', 'Low score embedding '.repeat(5), 0.7);    // ~25 tokens

            const snippets: ContextSnippet[] = [lowEmb, highEmb, lspRef, midEmb, lspDef]; // Unsorted

            // Available tokens allow for the top 3 embedding (approx 25*3 = 75 tokens + buffer)
            const availableTokens = 85;
            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, availableTokens);

            expect(wasTruncated).toBe(true);
            expect(optimizedSnippets.length).toBe(3);
            // New priority: embeddings first (by score), then LSP refs, then LSP defs
            expect(optimizedSnippets.map(s => s.id)).toEqual(['highEmb', 'midEmb', 'lowEmb']);
        });

        it('should truncate the last fitting snippet if it partially exceeds the limit (embedding)', async () => {
            const s1 = createSnippet('s1', 'lsp-definition', 'Short def', 1.0); // ~3 tokens
            const s2Emb = createSnippet('s2-emb', 'embedding', 'This is a longer embedding snippet that will need to be truncated. '.repeat(5), 0.8); // ~40 tokens
            const s3 = createSnippet('s3', 'lsp-reference', 'Another short one', 0.9); // ~5 tokens

            const snippets: ContextSnippet[] = [s1, s2Emb, s3];
            // s1 (3) + s2Emb (partially)
            // Available tokens: 3 (s1) + 2 (buffer) + 20 (partial s2Emb) = 25
            const availableTokens = 25;
            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, availableTokens);

            expect(wasTruncated).toBe(true);
            // With new priority (embedding > ref > def), s2Emb (embedding) gets highest priority and will be truncated
            // to fit within the available token budget, demonstrating the new priority system.
            expect(optimizedSnippets.length).toBe(1);
            expect(optimizedSnippets[0].id).toBe('s2-emb-partial'); // s2Emb gets partial truncation due to embedding priority
            expect(optimizedSnippets[0].content).toContain('[File content partially truncated to fit token limit]');

            const totalUsed = await mockLanguageModel.countTokens(optimizedSnippets[0].content);
            expect(totalUsed).toBeLessThanOrEqual(availableTokens);
        });

        it('should truncate a high-priority LSP snippet if it partially exceeds the limit', async () => {
            const lspDefLarge = createSnippet('lspDefLarge', 'lsp-definition', 'This is a very large LSP definition that must be included but is too long. '.repeat(10), 1.0); // ~100 tokens
            const snippets: ContextSnippet[] = [lspDefLarge];
            const availableTokens = 50; // Enough for partial inclusion

            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, availableTokens);

            expect(wasTruncated).toBe(true);
            expect(optimizedSnippets.length).toBe(1);
            expect(optimizedSnippets[0].id).toBe('lspDefLarge-partial');
            expect(optimizedSnippets[0].content).toContain('[File content partially truncated to fit token limit]');
            const partialTokens = await mockLanguageModel.countTokens(optimizedSnippets[0].content);
            expect(partialTokens).toBeLessThanOrEqual(availableTokens);
        });

        it('should handle empty snippet list', async () => {
            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext([], 100);
            expect(optimizedSnippets.length).toBe(0);
            expect(wasTruncated).toBe(false);
        });

        it('should correctly close markdown code blocks when truncating', async () => {
            const codeContent = "```typescript\n" +
                "function hello() {\n" +
                "  console.log('This is a long line that will be part of the truncated content');\n" +
                "  console.log('This line might be cut off');\n" +
                "}\n" +
                "```";
            const snippet = createSnippet('codeEmb', 'embedding', codeContent, 0.8);
            const snippets: ContextSnippet[] = [snippet];
            const availableTokens = 36;

            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, availableTokens);

            expect(wasTruncated).toBe(true);
            expect(optimizedSnippets.length).toBe(1);
            expect(optimizedSnippets[0].id).toBe('codeEmb-partial');
            expect(optimizedSnippets[0].content).toContain('```typescript');
            expect(optimizedSnippets[0].content).toContain('This is a long line');
            expect(optimizedSnippets[0].content).not.toContain("This line might be cut off");
            expect(optimizedSnippets[0].content).toContain('```');
            expect(optimizedSnippets[0].content).toContain('truncated');
        });



        it('should handle duplicate content properly', async () => {
            const snippets: ContextSnippet[] = [
                createSnippet('s1', 'embedding', 'duplicate content', 0.9),
                createSnippet('s2', 'embedding', 'duplicate content', 0.8),
            ];

            const { optimizedSnippets, wasTruncated } = await tokenManagerService.optimizeContext(snippets, 100);

            // Should deduplicate automatically and keep only one
            expect(optimizedSnippets.length).toBe(1);
            expect(optimizedSnippets[0].id).toBe('s1'); // Higher relevance score
            expect(wasTruncated).toBe(false);
        });

        it('should correctly format snippets to string with headers and truncation message', async () => {
            const lspDef = createSnippet('lspDef', 'lsp-definition', 'Definition content', 1.0);
            const lspRef = createSnippet('lspRef', 'lsp-reference', 'Reference content', 0.9);
            const emb = createSnippet('emb', 'embedding', 'Embedding content', 0.8);

            let formatted = tokenManagerService.formatContextSnippetsToString([lspDef, lspRef, emb], false);
            expect(formatted).toContain('## Definitions Found (LSP)');
            expect(formatted).toContain('Definition content');
            expect(formatted).toContain('## References Found (LSP)');
            expect(formatted).toContain('Reference content');
            expect(formatted).toContain('## Semantically Similar Code (Embeddings)');
            expect(formatted).toContain('Embedding content');
            expect(formatted).not.toContain('truncated');

            formatted = tokenManagerService.formatContextSnippetsToString([lspDef], true);
            expect(formatted).toContain('## Definitions Found (LSP)');
            expect(formatted).toContain('Definition content');
            expect(formatted).not.toContain('## References Found (LSP)');
            expect(formatted).not.toContain('## Semantically Similar Code (Embeddings)');
            expect(formatted).toContain('truncated');

            formatted = tokenManagerService.formatContextSnippetsToString([], true);
            expect(formatted).toContain("too large to fit");

            formatted = tokenManagerService.formatContextSnippetsToString([], false);
            expect(formatted).toEqual("No relevant context snippets were selected or found.");
        });
    });


    describe('calculateTokenAllocation', () => {
        it('should correctly calculate token allocation', async () => {
            const components = {
                systemPrompt: "System prompt text.", // 4 tokens
                diffText: "Diff text.", // 3 tokens
                embeddingContext: "Context text.", // 3 tokens
            };
            // Mock countTokens for specific inputs
            vi.mocked(mockLanguageModel.countTokens).mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
                if (typeof text === 'string') {
                    if (text === "System prompt text.") return 4;
                    if (text === "Diff text.") return 3;
                    if (text === "Context text.") return 3;
                    return Math.max(1, Math.ceil(text.length / 4));
                }
                // Basic handling for other types
                if (Array.isArray(text)) return text.length * 5;
                return 5;
            });

            const allocation = await tokenManagerService.calculateTokenAllocation(components, AnalysisMode.Comprehensive);

            const expectedSystemTokens = 4;
            const expectedDiffTokens = 3;
            const expectedContextTokens = 3; // Unoptimized context
            const expectedOtherTokens = 50; // FORMATTING_OVERHEAD
            // Message count: 1 (system prompt) + 0 (no userMessages) + 0 (no responsePrefill) = 1
            const expectedMessageOverheadTokens = 1 * 5; // TOKEN_OVERHEAD_PER_MESSAGE
            const expectedTotalRequired = expectedSystemTokens + expectedDiffTokens + expectedContextTokens + expectedMessageOverheadTokens + expectedOtherTokens; // 4+3+3+5+50 = 65

            const safeMaxTokens = Math.floor(8000 * TokenConstants.SAFETY_MARGIN_RATIO); // 7600

            expect(allocation.systemPromptTokens).toBe(expectedSystemTokens);
            expect(allocation.diffTextTokens).toBe(expectedDiffTokens);
            expect(allocation.contextTokens).toBe(expectedContextTokens);
            expect(allocation.messageOverheadTokens).toBe(expectedMessageOverheadTokens);
            expect(allocation.otherTokens).toBe(expectedOtherTokens);
            const totalRequiredTokens = getTotalRequiredTokens(allocation);
            expect(totalRequiredTokens).toBe(expectedTotalRequired);
            expect(totalRequiredTokens <= allocation.totalAvailableTokens).toBe(expectedTotalRequired <= safeMaxTokens);
            const expectedResponsePrefillTokens = 0;
            const nonContextTokens = expectedSystemTokens + expectedDiffTokens + expectedResponsePrefillTokens +
                expectedMessageOverheadTokens + expectedOtherTokens;
            const contextAllocationTokens = Math.max(0, allocation.totalAvailableTokens - nonContextTokens);
            expect(contextAllocationTokens).toBe(safeMaxTokens - (expectedSystemTokens + expectedDiffTokens + expectedMessageOverheadTokens + expectedOtherTokens));
        });

        it('should handle missing diffText correctly', async () => {
            const components = {
                systemPrompt: "System prompt text.", // 4 tokens
                embeddingContext: "Context text.", // 3 tokens
                responsePrefill: "Analysis:" // 2 tokens
            };

            vi.mocked(mockLanguageModel.countTokens).mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
                if (typeof text === 'string') {
                    if (text === "System prompt text.") return 4;
                    if (text === "Context text.") return 3;
                    if (text === "Analysis:") return 2;
                    return Math.max(1, Math.ceil(text.length / 4));
                }
                return 5;
            });

            const allocation = await tokenManagerService.calculateTokenAllocation(components, AnalysisMode.Comprehensive);

            expect(allocation.systemPromptTokens).toBe(4);
            expect(allocation.diffTextTokens).toBe(0); // Should be 0 if there is no diffText provided
            expect(allocation.contextTokens).toBe(3);
            expect(allocation.responsePrefillTokens).toBe(2); // Content tokens only
            // Message count: 1 (system prompt) + 0 (no userMessages) + 1 (responsePrefill) = 2
            expect(allocation.messageOverheadTokens).toBe(2 * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE);
        });
    });

    describe('calculateCompleteMessageTokens', () => {
        it('should calculate total tokens for complete message array', async () => {
            const systemPrompt = "You are an expert reviewer.";
            const userPrompt = "Please review this code: function test() { return 42; }";
            const responsePrefill = "I'll analyze this code step by step.";

            // Mock specific token counts
            vi.mocked(mockLanguageModel.countTokens).mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
                if (typeof text === 'string') {
                    if (text === systemPrompt) return 6;
                    if (text === userPrompt) return 12;
                    if (text === responsePrefill) return 8;
                    return Math.max(1, Math.ceil(text.length / 4));
                }
                return 5;
            });

            const totalTokens = await tokenManagerService.calculateCompleteMessageTokens(
                systemPrompt,
                userPrompt,
                responsePrefill
            );

            // Expected: (6 + 5) + (12 + 5) + (8 + 5) = 11 + 17 + 13 = 41
            const expectedTotal =
                (6 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE) + // System message
                (12 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE) + // User message
                (8 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE); // Assistant prefill message

            expect(totalTokens).toBe(expectedTotal);
        });

        it('should be consistent with calculateTokenAllocation for validation', async () => {
            const systemPrompt = "Expert reviewer prompt.";
            const userPrompt = "Review this diff: +added line\n-removed line";
            const responsePrefill = "Analysis begins:";

            const components = {
                systemPrompt,
                diffText: userPrompt,
                embeddingContext: "", // No context for this test
                responsePrefill
            };

            // Mock consistent token counts
            vi.mocked(mockLanguageModel.countTokens).mockImplementation(async (text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[]) => {
                if (typeof text === 'string') {
                    if (text === systemPrompt) return 4;
                    if (text === userPrompt) return 8;
                    if (text === responsePrefill) return 3;
                    if (text === "") return 0;
                    return Math.max(1, Math.ceil(text.length / 4));
                }
                return 5;
            });

            const allocation = await tokenManagerService.calculateTokenAllocation(components, AnalysisMode.Comprehensive);
            const completeTokens = await tokenManagerService.calculateCompleteMessageTokens(
                systemPrompt,
                userPrompt,
                responsePrefill
            );

            // The complete message tokens should account for the core components plus overhead
            // allocation includes: system + diff + context + responsePrefill + messageOverhead + other
            // completeTokens includes: system + user + responsePrefill (all with message overhead)

            const expectedCompleteTokens =
                (4 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE) + // System
                (8 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE) + // User (diff)
                (3 + TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE); // Response prefill

            expect(completeTokens).toBe(expectedCompleteTokens);

            // Verify that the allocation's core components sum correctly
            const allocationCoreTokens = allocation.systemPromptTokens + allocation.diffTextTokens +
                allocation.responsePrefillTokens + allocation.messageOverheadTokens;

            // Should be close but allocation includes extra formatting overhead
            expect(Math.abs(completeTokens - allocationCoreTokens)).toBeLessThanOrEqual(allocation.otherTokens);
        });
    });

    describe('Content Prioritization Methods', () => {
        describe('setContentPrioritization and getContentPrioritization', () => {
            it('should set and get content prioritization order', () => {
                const customPrioritization: ContentPrioritization = {
                    order: ['lsp-definition', 'lsp-reference', 'embedding', 'diff']
                };

                tokenManagerService.setContentPrioritization(customPrioritization);
                const result = tokenManagerService.getContentPrioritization();

                expect(result.order).toEqual(customPrioritization.order);
                expect(result).not.toBe(customPrioritization); // Should return a copy
            });

            it('should have default prioritization order', () => {
                const defaultPrioritization = tokenManagerService.getContentPrioritization();
                expect(defaultPrioritization.order).toEqual(['diff', 'embedding', 'lsp-reference', 'lsp-definition']);
            });

            it('should update snippet prioritization based on configuration', async () => {
                const snippets = [
                    { id: 's1', type: 'lsp-definition' as const, content: 'def content', relevanceScore: 1.0 },
                    { id: 's2', type: 'embedding' as const, content: 'emb content', relevanceScore: 0.8 },
                    { id: 's3', type: 'lsp-reference' as const, content: 'ref content', relevanceScore: 0.9 }
                ];

                // Set custom prioritization: definitions > references > embedding
                tokenManagerService.setContentPrioritization({
                    order: ['diff', 'lsp-definition', 'lsp-reference', 'embedding']
                });

                const { optimizedSnippets } = await tokenManagerService.optimizeContext(snippets, 1000);

                // Should be ordered by new priority: definition, reference, embedding
                expect(optimizedSnippets.map(s => s.type)).toEqual(['lsp-definition', 'lsp-reference', 'embedding']);
            });
        });

        describe('performProportionalTruncation', () => {
            it('should return original components if they fit within target tokens', async () => {
                const components = {
                    systemPrompt: 'Short prompt',
                    diffText: 'Short diff',
                    embeddingContext: 'Short context'
                };

                const { components: truncatedComponents, wasTruncated } = await tokenManagerService.performProportionalTruncation(components, 1000);

                expect(wasTruncated).toBe(false);
                expect(truncatedComponents.systemPrompt).toBe(components.systemPrompt);
                expect(truncatedComponents.diffText).toBe(components.diffText);
                expect(combineContextFields(truncatedComponents)).toBe('Short context');
            });


            it('should implement true waterfall: diff gets full allocation first, context gets remainder', async () => {
                const components = {
                    systemPrompt: 'System', // 2 tokens (6 chars / 4 = 2)
                    diffText: 'Diff content '.repeat(20), // 65 tokens (260 chars / 4 = 65)
                    embeddingContext: 'Context content '.repeat(30), // 120 tokens (480 chars / 4 = 120)
                };

                const targetTokens = 170; // Total available: 170, Fixed overhead: ~57, Available for content: ~113
                const { components: truncatedComponents, wasTruncated } = await tokenManagerService.performProportionalTruncation(components, targetTokens);

                expect(wasTruncated).toBe(true);

                // Calculate actual token counts with the mock
                // 'Diff content '.repeat(20) = 260 chars = 65 tokens
                // 'Context content '.repeat(30) = 480 chars = 120 tokens
                // System: 6 chars = 2 tokens + 5 overhead = 7 tokens
                // Fixed total: 7 + 50 formatting = 57 tokens
                // Available for content: 170 - 57 = 113 tokens
                // In true waterfall: diff gets its full 65 tokens, context gets remaining 48 tokens
                const finalDiffTokens = await mockLanguageModel.countTokens(truncatedComponents.diffText!);
                const combinedContext = combineContextFields(truncatedComponents);
                const finalContextTokens = await mockLanguageModel.countTokens(combinedContext);

                // Diff should get priority allocation and its full amount since it fits
                expect(finalDiffTokens).toBe(65); // Diff should get its full allocation

                // Context should get the remaining space (48 tokens)
                expect(finalContextTokens).toBeLessThan(120); // Should be truncated from original 120
                expect(finalContextTokens).toBeGreaterThan(30); // Should get substantial remaining space
                expect(finalContextTokens).toBeLessThan(65); // Should be less than diff allocation
            });

            it('should truncate diff only when it exceeds entire available space, leaving no room for context', async () => {
                const components = {
                    systemPrompt: 'System',
                    diffText: 'Very large diff content '.repeat(100), // ~500 tokens
                    embeddingContext: 'Context content '.repeat(20), // ~100 tokens
                };

                const targetTokens = 150; // Very tight limit
                const { components: truncatedComponents, wasTruncated } = await tokenManagerService.performProportionalTruncation(components, targetTokens);

                expect(wasTruncated).toBe(true);

                // Diff should be truncated to fit within available space
                const finalDiffTokens = await mockLanguageModel.countTokens(truncatedComponents.diffText!);

                // Context should be empty because diff took all available space
                expect(combineContextFields(truncatedComponents)).toBe('');

                // Diff should be truncated but still present
                expect(finalDiffTokens).toBeGreaterThan(0);
                expect(finalDiffTokens).toBeLessThan(500); // Original diff size
            });

        });
    });
});
