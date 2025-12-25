import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { FindFilesByPatternTool } from '../tools/findFilesByPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS, SUBAGENT_LIMITS } from '../models/workspaceSettingsSchema';
import { fdir } from 'fdir';
import { SubagentSessionManager } from '../services/subagentSessionManager';

/**
 * Create a mock WorkspaceSettingsService for testing
 */
function createMockWorkspaceSettings(): WorkspaceSettingsService {
    return {
        getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
        getRequestTimeoutSeconds: () => ANALYSIS_LIMITS.requestTimeoutSeconds.default,
        getMaxSubagentsPerSession: () => SUBAGENT_LIMITS.maxPerSession.default
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

// Mock fdir - Vitest 4 requires function/class for mocks used as constructors
vi.mock('fdir', () => ({
    fdir: vi.fn().mockImplementation(function () {
        return {
            withGlobFunction: vi.fn().mockReturnThis(),
            glob: vi.fn().mockReturnThis(),
            withRelativePaths: vi.fn().mockReturnThis(),
            exclude: vi.fn().mockReturnThis(),
            filter: vi.fn().mockReturnThis(),
            crawl: vi.fn().mockReturnThis(),
            withPromise: vi.fn()
        };
    })
}));

// Mock picomatch
vi.mock('picomatch', () => ({
    default: vi.fn()
}));

// Mock ignore - Vitest 4 requires function/class for mocks used as constructors
vi.mock('ignore', () => ({
    default: vi.fn(function () {
        return {
            add: vi.fn().mockReturnThis(),
            checkIgnore: vi.fn(function () { return { ignored: false }; }),
            ignores: vi.fn(function () { return false; }),
            filter: vi.fn().mockImplementation(function (files) { return files; })
        };
    })
}));

const mockCopilotModelManager = {
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: find_files_by_pattern')
};

// Test utility functions for DRY mocks
// Vitest 4 requires function/class syntax for mocks used as constructors
function createMockFdirInstance(syncReturnValue: string[] = []) {
    const instance = {
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        globWithOptions: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        withFullPaths: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnThis(),
        withPromise: vi.fn().mockResolvedValue(syncReturnValue),
        sync: vi.fn().mockReturnValue(syncReturnValue)
    };
    // Make chainable methods return the instance
    instance.withGlobFunction.mockReturnValue(instance);
    instance.glob.mockReturnValue(instance);
    instance.globWithOptions.mockReturnValue(instance);
    instance.withRelativePaths.mockReturnValue(instance);
    instance.withFullPaths.mockReturnValue(instance);
    instance.exclude.mockReturnValue(instance);
    instance.filter.mockReturnValue(instance);
    instance.crawl.mockReturnValue(instance);
    return instance as any;
}

function createMockGitRepository(gitRootPath: string = '/test/git-repo') {
    return {
        rootUri: {
            fsPath: gitRootPath
        }
    };
}

describe('FindFileTool Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let findFileTool: FindFilesByPatternTool;
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let subagentSessionManager: SubagentSessionManager;
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
        findFileTool = new FindFilesByPatternTool(mockGitOperationsManager);
        toolRegistry.registerTool(findFileTool);

        subagentSessionManager = new SubagentSessionManager(mockWorkspaceSettings);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings,
            subagentSessionManager
        );

        mockReadFile = vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>;

        // Clear all mocks
        vi.clearAllMocks();

        // Re-setup the essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });

        // Mock empty .gitignore by default
        mockReadFile.mockResolvedValue(Buffer.from(''));
    });

    describe('End-to-End Find File Workflow', () => {
        it('should handle find file tool call workflow', async () => {
            // Mock file search results with full paths from git repo
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/components/Button.tsx',
                '/test/git-repo/components/Input.tsx'
            ]);
            // Vitest 4: use mockImplementation with function syntax for constructor mocks
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            // Execute tool call through the ToolExecutor
            const toolCallResults = await toolExecutor.executeTools([{
                name: 'find_files_by_pattern',
                args: {
                    pattern: '*.tsx',
                    search_directory: 'components'
                }
            }]);

            // Verify results are properly formatted
            expect(toolCallResults).toHaveLength(1);
            expect(toolCallResults[0].name).toBe('find_files_by_pattern');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result).toEqual(
                'components/Button.tsx\ncomponents/Input.tsx'
            );
        });



        it('should handle tool execution errors gracefully', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            mockFdirInstance.sync.mockImplementation(function () {
                throw new Error('Permission denied');
            });
            // Vitest 4: use mockImplementation with function syntax for constructor mocks
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const toolCallResults = await toolExecutor.executeTools([{
                name: 'find_files_by_pattern',
                args: {
                    pattern: '*.js',
                    search_directory: 'restricted'
                }
            }]);

            expect(toolCallResults[0].name).toBe('find_files_by_pattern');
            expect(toolCallResults[0].success).toBe(false);
            expect(toolCallResults[0].error).toContain('Unable to find files');
            expect(toolCallResults[0].error).toContain('Permission denied');
        });


    });

    describe('Tool Registry Integration', () => {
        it('should register FindFileTool correctly', () => {
            expect(toolRegistry.hasTool('find_files_by_pattern')).toBe(true);
            expect(toolRegistry.getTool('find_files_by_pattern')).toBe(findFileTool);
        });

        it('should include FindFileTool in available tools list', () => {
            const toolNames = toolRegistry.getToolNames();
            expect(toolNames).toContain('find_files_by_pattern');
        });

        it('should provide comprehensive tool definition for LLM', () => {
            const tool = toolRegistry.getTool('find_files_by_pattern');
            const vscodeToolDef = tool!.getVSCodeTool();

            // Verify tool identification
            expect(vscodeToolDef.name).toBe('find_files_by_pattern');
            expect(tool!.name).toBe('find_files_by_pattern');

            // Verify description is LLM-friendly with key features
            expect(vscodeToolDef.description).toContain('Find files matching glob patterns within a directory');
            expect(vscodeToolDef.description).toContain('glob patterns');
            expect(vscodeToolDef.description).toContain('.gitignore');
            expect(vscodeToolDef.description).toContain('relative paths');
            expect(tool!.description).toContain('wildcards');
            expect(tool!.description).toContain('recursive search');

            // Verify schema structure and properties
            expect(vscodeToolDef.inputSchema).toBeDefined();
            const schema = vscodeToolDef.inputSchema as any;
            expect(schema.type).toBe('object');
            expect(schema.properties).toHaveProperty('pattern');
            expect(schema.properties).toHaveProperty('search_directory');
            expect(schema.required).toContain('pattern');

            // Verify pattern parameter details for LLM understanding
            const patternProp = schema.properties.pattern;
            expect(patternProp.type).toBe('string');
            expect(patternProp.description).toContain('*.js');
            expect(patternProp.description).toContain('**/*.test.ts');
            expect(patternProp.description).toContain('src/**/*.{js,ts}');

            // Verify search_directory parameter details
            const searchDirProp = schema.properties.search_directory;
            expect(searchDirProp.type).toBe('string');
            expect(searchDirProp.description).toContain('relative to project root');
            expect(searchDirProp.description).toContain('default');
            expect(searchDirProp.default).toBe('.');
        });
    });
});