import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { FindFilesByPatternTool } from '../tools/findFilesByPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { fdir } from 'fdir';

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

// Mock fdir
vi.mock('fdir', () => ({
    fdir: vi.fn().mockImplementation(() => ({
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnThis(),
        withPromise: vi.fn()
    }))
}));

// Mock picomatch
vi.mock('picomatch', () => ({
    default: vi.fn()
}));

// Mock ignore
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn(() => ({ ignored: false }))
    }))
}));

const mockCopilotModelManager = {
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: find_files_by_pattern')
};

describe('FindFileTool Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let findFileTool: FindFilesByPatternTool;
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        toolExecutor = new ToolExecutor(toolRegistry);
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

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any
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
            // Mock file search results
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([
                    'components/Button.tsx',
                    'components/Input.tsx',
                    'pages/Home.tsx'
                ])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            // Mock LLM requesting to find TypeScript files
            const mockConversation = {
                id: 'test-id',
                messages: [
                    {
                        role: 'user' as const,
                        content: 'Find all TypeScript files in the components directory'
                    }
                ]
            };

            const mockToolCall = {
                call: {
                    name: 'find_files_by_pattern',
                    arguments: {
                        pattern: '*.tsx',
                        search_directory: 'components'
                    }
                }
            };

            // Mock LLM response with tool call
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                toolCalls: [mockToolCall]
            });

            // Execute tool call through the ToolExecutor
            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            // Verify tool was called with correct arguments
            expect(mockFdirInstance.glob).toHaveBeenCalledWith('*.tsx');
            expect(mockFdirInstance.crawl).toHaveBeenCalledWith(expect.stringContaining('components'));

            // Verify results are properly formatted
            expect(toolCallResults).toHaveLength(1);
            expect(toolCallResults[0].name).toBe('find_files_by_pattern');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result).toEqual([
                'components/components/Button.tsx',
                'components/components/Input.tsx',
                'components/pages/Home.tsx'
            ]);
        });

        it('should handle complex glob patterns', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([
                    'utils/helper.js',
                    'utils/config.ts',
                    'lib/parser.js'
                ])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            // Test multiple extensions pattern
            const toolCallResults = await toolExecutor.executeTools([{
                name: 'find_files_by_pattern',
                args: {
                    pattern: '**/*.{js,ts}',
                    search_directory: '.'
                }
            }]);

            expect(mockFdirInstance.glob).toHaveBeenCalledWith('**/*.{js,ts}');
            expect(toolCallResults[0].result).toEqual([
                'lib/parser.js',
                'utils/config.ts',
                'utils/helper.js'
            ]);
        });

        it('should handle .gitignore filtering', async () => {
            // Mock .gitignore content
            mockReadFile.mockResolvedValue(Buffer.from('node_modules\n*.log\n.env'));

            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([
                    'src/app.js',
                    'src/utils.js'
                ])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const mockToolCall = {
                call: {
                    name: 'find_files_by_pattern',
                    arguments: {
                        pattern: '*.js'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            // Verify .gitignore was read
            expect(mockReadFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    fsPath: expect.stringContaining('.gitignore')
                })
            );

            // Verify results exclude gitignored files
            expect(toolCallResults[0].result).toEqual([
                'src/app.js',
                'src/utils.js'
            ]);
        });

        it('should handle tool execution errors gracefully', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockRejectedValue(new Error('Permission denied'))
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const mockToolCall = {
                call: {
                    name: 'find_files_by_pattern',
                    arguments: {
                        pattern: '*.js',
                        search_directory: 'restricted'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            expect(toolCallResults[0].name).toBe('find_files_by_pattern');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result).toEqual([
                'Unable to find files matching pattern \'*.js\' in directory \'restricted\': Failed to find files matching \'*.js\' in \'restricted\': Permission denied'
            ]);
        });

        it('should validate tool arguments according to schema', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockRejectedValue(new Error('Permission denied'))
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const mockToolCall = {
                call: {
                    name: 'find_files_by_pattern',
                    arguments: {
                        pattern: '', // Invalid: empty pattern but will be processed
                        search_directory: 'src'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            expect(toolCallResults[0].name).toBe('find_files_by_pattern');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result[0]).toContain('Unable to find files matching pattern');
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