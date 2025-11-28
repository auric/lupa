import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { FileDiscoverer } from '../utils/fileDiscoverer';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

/**
 * Create a mock WorkspaceSettingsService for testing
 */
function createMockWorkspaceSettings(): WorkspaceSettingsService {
    return {
        getMaxToolCalls: () => WorkspaceSettingsService.DEFAULT_MAX_TOOL_CALLS,
        getMaxIterations: () => WorkspaceSettingsService.DEFAULT_MAX_ITERATIONS,
        getRequestTimeoutSeconds: () => WorkspaceSettingsService.DEFAULT_REQUEST_TIMEOUT_SECONDS
    } as WorkspaceSettingsService;
}

vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            workspaceFolders: [
                {
                    uri: {
                        fsPath: '/test/workspace'
                    }
                }
            ],
            fs: {
                readFile: vi.fn()
            }
        },
        Uri: {
            file: vi.fn((filePath) => ({ fsPath: filePath, toString: () => filePath }))
        }
    };
});

// Mock FileDiscoverer
vi.mock('../utils/fileDiscoverer', () => ({
    FileDiscoverer: {
        discoverFiles: vi.fn()
    }
}));

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
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
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
        } as any;

        // Initialize tools
        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);
        toolRegistry.registerTool(searchForPatternTool);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings
        );

        // Get mock references
        mockReadFile = vi.mocked(vscode.workspace.fs.readFile);

        // Clear mocks but preserve implementations
        vi.clearAllMocks();

        // Re-setup essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });
    });

    describe('End-to-End Tool-Calling Workflow', () => {
        it('should execute search_for_pattern tool through ToolExecutor', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/index.ts', 'src/utils.ts'],
                truncated: false,
                totalFound: 2
            });

            mockReadFile.mockImplementation((uri) => {
                const content = uri.fsPath.includes('index.ts')
                    ? 'export class MainClass {\n  constructor() {}\n}\nfunction helper() {}'
                    : 'export class UtilClass {\n  static method() {}\n}';
                return Promise.resolve(Buffer.from(content));
            });

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
            const result = results[0].result as { matches: Array<{ file_path: string; content: string }> };
            expect(result.matches).toBeDefined();
            expect(result.matches.length).toBe(2);
            expect(result.matches[0].file_path).toBe('src/index.ts');
            expect(result.matches[0].content).toContain('1: export class MainClass {');
            expect(result.matches[1].file_path).toBe('src/utils.ts');
            expect(result.matches[1].content).toContain('1: export class UtilClass {');
        });




        it('should handle error cases gracefully', async () => {
            // Test FileDiscoverer error
            vi.mocked(FileDiscoverer.discoverFiles).mockRejectedValue(new Error('File discovery failed'));

            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'test'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);
            const errorResult = results[0].result as { error: string };
            expect(errorResult.error).toBeDefined();
            expect(errorResult.error).toContain('Pattern search failed');
        });
    });

    describe('Tool Registration and Discovery', () => {
        it('should be registered in tool registry', () => {
            expect(toolRegistry.hasTool('search_for_pattern')).toBe(true);

            const tool = toolRegistry.getTool('search_for_pattern');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('search_for_pattern');
            expect(tool!.description).toContain('flexible search for arbitrary patterns');
        });

        it('should provide correct VS Code tool definition with LLM-optimized parameters', () => {
            const tool = toolRegistry.getTool('search_for_pattern');
            const vscodeTools = tool!.getVSCodeTool();

            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('flexible search for arbitrary patterns');
            expect(vscodeTools.inputSchema).toBeDefined();

            // Verify schema has correct LLM-optimized parameter names
            const properties = (vscodeTools.inputSchema as any).properties;
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