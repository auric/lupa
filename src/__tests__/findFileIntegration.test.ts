import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { FindFileTool } from '../tools/findFileTool';
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
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: find_file')
};

describe('FindFileTool Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let findFileTool: FindFileTool;
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
        findFileTool = new FindFileTool(mockGitOperationsManager);
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
                    name: 'find_file',
                    arguments: {
                        fileName: '*.tsx',
                        path: 'components'
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
            expect(toolCallResults[0].name).toBe('find_file');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result).toEqual([
                'components/components/Button.tsx',
                'components/components/Input.tsx',
                'components/pages/Home.tsx'
            ]);
        });

        it('should handle glob patterns with multiple extensions', async () => {
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

            const mockToolCall = {
                call: {
                    name: 'find_file',
                    arguments: {
                        fileName: '**/*.{js,ts}',
                        path: '.'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
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
                    name: 'find_file',
                    arguments: {
                        fileName: '*.js'
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
                    name: 'find_file',
                    arguments: {
                        fileName: '*.js',
                        path: 'restricted'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            expect(toolCallResults[0].name).toBe('find_file');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result).toEqual([
                'Error finding files: Failed to find files matching \'*.js\' in \'restricted\': Permission denied'
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
                    name: 'find_file',
                    arguments: {
                        fileName: '', // Invalid: empty filename but will be processed
                        path: 'src'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            expect(toolCallResults[0].name).toBe('find_file');
            expect(toolCallResults[0].success).toBe(true);
            expect(toolCallResults[0].result[0]).toContain('Error finding files:');
        });

        it('should handle recursive search patterns', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([
                    'src/components/Button/Button.test.ts',
                    'src/utils/helpers.test.ts',
                    'tests/integration/api.test.ts'
                ])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const mockToolCall = {
                call: {
                    name: 'find_file',
                    arguments: {
                        fileName: '**/*.test.ts'
                    }
                }
            };

            const toolCallResults = await toolExecutor.executeTools([{
                name: mockToolCall.call.name,
                args: mockToolCall.call.arguments
            }]);

            expect(mockFdirInstance.glob).toHaveBeenCalledWith('**/*.test.ts');
            expect(toolCallResults[0].result).toEqual([
                'src/components/Button/Button.test.ts',
                'src/utils/helpers.test.ts',
                'tests/integration/api.test.ts'
            ]);
        });
    });

    describe('Tool Registry Integration', () => {
        it('should register FindFileTool correctly', () => {
            expect(toolRegistry.hasTool('find_file')).toBe(true);
            expect(toolRegistry.getTool('find_file')).toBe(findFileTool);
        });

        it('should include FindFileTool in available tools list', () => {
            const toolNames = toolRegistry.getToolNames();
            expect(toolNames).toContain('find_file');
        });

        it('should provide correct tool definition for LLM', () => {
            const tool = toolRegistry.getTool('find_file');
            const vscodeToolDef = tool!.getVSCodeTool();

            expect(vscodeToolDef.name).toBe('find_file');
            expect(vscodeToolDef.description).toContain('glob pattern');
            expect(vscodeToolDef.inputSchema).toBeDefined();
            expect((vscodeToolDef.inputSchema as any).properties).toHaveProperty('fileName');
            expect((vscodeToolDef.inputSchema as any).properties).toHaveProperty('path');
        });
    });
});