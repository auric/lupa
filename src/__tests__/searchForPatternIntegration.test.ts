import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { RipgrepSearchService, RipgrepFileResult } from '../services/ripgrepSearchService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { createMockWorkspaceSettings, createMockRipgrepService, createMockGitRepository } from './testUtils/mockFactories';

// Mock RipgrepSearchService
vi.mock('../services/ripgrepSearchService');

const mockCopilotModelManager = {
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: search_for_pattern')
};

describe('SearchForPatternTool Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let searchForPatternTool: SearchForPatternTool;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockGitOperationsManager: GitOperationsManager;
    let mockRipgrepService: {
        search: Mock;
        formatResults: Mock;
    };
    let subagentSessionManager: SubagentSessionManager;

    beforeEach(() => {
        vi.clearAllMocks();

        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        mockWorkspaceSettings = createMockWorkspaceSettings();
        toolExecutor = new ToolExecutor(toolRegistry, mockWorkspaceSettings);
        conversationManager = new ConversationManager();

        mockGetRepository = vi.fn().mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });

        mockGitOperationsManager = {
            getRepository: mockGetRepository
        } as unknown as GitOperationsManager;

        // Setup RipgrepSearchService mock
        mockRipgrepService = {
            search: vi.fn(),
            formatResults: vi.fn()
        };

        // Vitest 4 requires function syntax for constructor mocks
        vi.mocked(RipgrepSearchService).mockImplementation(function (this: any) {
            this.search = mockRipgrepService.search;
            this.formatResults = mockRipgrepService.formatResults;
        });

        // Initialize tools
        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);
        toolRegistry.registerTool(searchForPatternTool);

        subagentSessionManager = new SubagentSessionManager(mockWorkspaceSettings);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as never,
            mockPromptGenerator as never,
            mockWorkspaceSettings,
            subagentSessionManager
        );
    });

    describe('End-to-End Tool-Calling Workflow', () => {
        it('should execute search_for_pattern tool through ToolExecutor', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/index.ts',
                    matches: [
                        { filePath: 'src/index.ts', lineNumber: 1, content: 'export class MainClass {', isContext: false }
                    ]
                },
                {
                    filePath: 'src/utils.ts',
                    matches: [
                        { filePath: 'src/utils.ts', lineNumber: 1, content: 'export class UtilClass {', isContext: false }
                    ]
                }
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/index.ts ===\n1: export class MainClass {\n\n=== src/utils.ts ===\n1: export class UtilClass {'
            );

            // Execute the tool directly through ToolExecutor with new parameter names
            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'class.*{',
                    include_files: '*.ts'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);
            const result = results[0].result as string;
            expect(result).toContain('src/index.ts');
            expect(result).toContain('1: export class MainClass {');
            expect(result).toContain('src/utils.ts');
            expect(result).toContain('1: export class UtilClass {');
        });

        it('should handle error cases gracefully', async () => {
            // Test RipgrepSearchService error
            mockRipgrepService.search.mockRejectedValue(new Error('ripgrep error'));

            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'test'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(false);
            expect(results[0].error).toBeDefined();
            expect(results[0].error).toContain('Pattern search failed');
        });
    });

    describe('Tool Registration and Discovery', () => {
        it('should be registered in tool registry', () => {
            expect(toolRegistry.hasTool('search_for_pattern')).toBe(true);

            const tool = toolRegistry.getTool('search_for_pattern');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('search_for_pattern');
            expect(tool!.description).toContain('Search for text patterns');
        });

        it('should provide correct VS Code tool definition with LLM-optimized parameters', () => {
            const tool = toolRegistry.getTool('search_for_pattern');
            const vscodeTools = tool!.getVSCodeTool();

            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('Search for text patterns');
            expect(vscodeTools.inputSchema).toBeDefined();

            // Verify schema has correct LLM-optimized parameter names
            const properties = (vscodeTools.inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
            expect(properties.pattern).toBeDefined();
            expect(properties.include_files).toBeDefined();
            expect(properties.exclude_files).toBeDefined();
            expect(properties.search_path).toBeDefined();
            expect(properties.lines_before).toBeDefined();
            expect(properties.lines_after).toBeDefined();
            expect(properties.only_code_files).toBeDefined();
            expect(properties.case_sensitive).toBeDefined();
        });
    });

});