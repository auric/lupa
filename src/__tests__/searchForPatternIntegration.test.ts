import * as vscode from 'vscode';
import ignore from 'ignore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import * as gitUtils from '../utils/gitUtils';

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
                readDirectory: vi.fn(),
                readFile: vi.fn()
            }
        },
        Uri: {
            file: vi.fn((filePath) => ({ fsPath: filePath, toString: () => filePath }))
        },
        FileType: {
            File: 1,
            Directory: 2
        }
    };
});

// Mock pathUtils
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn()
}));

// Mock ignore library
vi.mock('ignore', () => {
    const mockIgnore = {
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn().mockReturnValue({ ignored: false })
    };
    return {
        default: vi.fn(() => mockIgnore)
    };
});

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
    let searchForPatternTool: SearchForPatternTool;
    let mockReadDirectory: ReturnType<typeof vi.fn>;
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
        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);
        toolRegistry.registerTool(searchForPatternTool);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any
        );

        // Get mock references
        mockReadDirectory = vi.mocked(vscode.workspace.fs.readDirectory);
        mockReadFile = vi.mocked(vscode.workspace.fs.readFile);

        // Clear mocks but preserve implementations
        vi.clearAllMocks();

        // Re-setup essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });
        vi.mocked(gitUtils.readGitignore).mockResolvedValue('node_modules/\n*.log');
    });

    describe('End-to-End Tool-Calling Workflow', () => {
        it('should execute search_for_pattern tool through ToolExecutor', async () => {
            // Set up mock file system
            mockReadDirectory.mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/test/git-repo') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory],
                        ['package.json', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src') {
                    return Promise.resolve([
                        ['index.ts', vscode.FileType.File],
                        ['utils.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            mockReadFile.mockImplementation((uri) => {
                const content = uri.fsPath.includes('index.ts')
                    ? 'export class MainClass {\n  constructor() {}\n}\nfunction helper() {}'
                    : 'export class UtilClass {\n  static method() {}\n}';
                return Promise.resolve(Buffer.from(content));
            });

            // Execute the tool directly through ToolExecutor
            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'class.*{',
                    include: '*.ts'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);
            const resultContent = results[0].result.join('\n');
            expect(resultContent).toContain('<file>src/index.ts</file>');
            expect(resultContent).toContain('<content>export class MainClass {</content>');
            expect(resultContent).toContain('<file>src/utils.ts</file>');
            expect(resultContent).toContain('<content>export class UtilClass {</content>');
        });

        it('should handle complex search patterns in integration workflow', async () => {
            // Set up more complex file structure
            mockReadDirectory.mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/test/git-repo') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory],
                        ['tests', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src') {
                    return Promise.resolve([
                        ['components', vscode.FileType.Directory],
                        ['services', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src/components') {
                    return Promise.resolve([
                        ['Button.tsx', vscode.FileType.File],
                        ['Modal.tsx', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src/services') {
                    return Promise.resolve([
                        ['api.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/tests') {
                    return Promise.resolve([
                        ['unit.test.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFiles = new Map([
                ['/test/git-repo/src/components/Button.tsx', 'export function Button() {\n  return <button>Click</button>;\n}'],
                ['/test/git-repo/src/components/Modal.tsx', 'export function Modal() {\n  return <div>Modal</div>;\n}'],
                ['/test/git-repo/src/services/api.ts', 'export function apiCall() {\n  return fetch("/api");\n}'],
                ['/test/git-repo/tests/unit.test.ts', 'function testFunction() {\n  expect(true).toBe(true);\n}']
            ]);

            mockReadFile.mockImplementation((uri) => {
                const content = mockFiles.get(uri.fsPath) || '';
                return Promise.resolve(Buffer.from(content));
            });

            // Search for functions with specific pattern
            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'export function.*\\('
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);

            const resultContent = results[0].result.join('\n');
            expect(resultContent).toContain('<file>src/components/Button.tsx</file>');
            expect(resultContent).toContain('<file>src/components/Modal.tsx</file>');
            expect(resultContent).toContain('<file>src/services/api.ts</file>');
            expect(resultContent).toContain('<content>export function Button() {</content>');
            expect(resultContent).toContain('<content>export function Modal() {</content>');
            expect(resultContent).toContain('<content>export function apiCall() {</content>');
        });

        it('should handle path filtering in integration workflow', async () => {
            // Set up file system for path filtering test
            mockReadDirectory.mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/test/git-repo/src/components') {
                    return Promise.resolve([
                        ['Button.tsx', vscode.FileType.File],
                        ['Input.tsx', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            mockReadFile.mockImplementation((uri) => {
                const content = uri.fsPath.includes('Button.tsx')
                    ? 'const Button = () => <button>Click</button>;'
                    : 'const Input = () => <input type="text" />;';
                return Promise.resolve(Buffer.from(content));
            });

            // Search within specific path
            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'const.*=.*=>',
                    path: 'src/components'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);

            const resultContent = results[0].result.join('\n');
            expect(resultContent).toContain('<file>src/components/Button.tsx</file>');
            expect(resultContent).toContain('<file>src/components/Input.tsx</file>');
            expect(resultContent).toContain('<content>const Button = () =&gt; &lt;button&gt;Click&lt;/button&gt;;</content>');
            expect(resultContent).toContain('<content>const Input = () =&gt; &lt;input type=&quot;text&quot; /&gt;;</content>');
        });

        it('should handle glob pattern filtering in integration workflow', async () => {
            // Set up mixed file types
            mockReadDirectory.mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/test/git-repo') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src') {
                    return Promise.resolve([
                        ['component.tsx', vscode.FileType.File],
                        ['service.ts', vscode.FileType.File],
                        ['styles.css', vscode.FileType.File],
                        ['readme.md', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFiles = new Map([
                ['/test/git-repo/src/component.tsx', 'interface Props {}\nconst Component = () => <div></div>;'],
                ['/test/git-repo/src/service.ts', 'interface Service {}\nclass ApiService {}'],
                ['/test/git-repo/src/styles.css', '.button { color: red; }'],
                ['/test/git-repo/src/readme.md', '# Documentation\ninterface NotCode {}']
            ]);

            mockReadFile.mockImplementation((uri) => {
                const content = mockFiles.get(uri.fsPath) || '';
                return Promise.resolve(Buffer.from(content));
            });

            // Search only in TypeScript/TSX files
            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'interface.*{',
                    include: '*.ts*'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);

            const resultContent = results[0].result.join('\n');
            expect(resultContent).toContain('<file>src/component.tsx</file>');
            expect(resultContent).toContain('<file>src/service.ts</file>');
            expect(resultContent).not.toContain('styles.css');
            expect(resultContent).not.toContain('readme.md');
            expect(resultContent).toContain('<content>interface Props {}</content>');
            expect(resultContent).toContain('<content>interface Service {}</content>');
        });

        it('should handle error cases in integration workflow', async () => {
            // Simulate file system error
            mockReadDirectory.mockRejectedValue(new Error('Permission denied'));

            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'test'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);
            expect(results[0].result.join('\n')).toContain('<message>No matches found for the specified pattern</message>');
        });

        it('should handle no matches scenario in integration workflow', async () => {
            // Set up files with no matching content
            mockReadDirectory.mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            mockReadFile.mockResolvedValue(Buffer.from('const variable = "no matches here";'));

            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'nonexistentpattern'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('search_for_pattern');
            expect(results[0].success).toBe(true);
            expect(results[0].result.join('\n')).toContain('<message>No matches found for the specified pattern</message>');
        });
    });

    describe('Tool Registration and Discovery', () => {
        it('should be registered in tool registry', () => {
            expect(toolRegistry.hasTool('search_for_pattern')).toBe(true);

            const tool = toolRegistry.getTool('search_for_pattern');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('search_for_pattern');
            expect(tool!.description).toContain('Search for a regex pattern');
        });

        it('should provide correct VS Code tool definition', () => {
            const tool = toolRegistry.getTool('search_for_pattern');
            const vscodeTools = tool!.getVSCodeTool();

            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('Search for a regex pattern');
            expect(vscodeTools.inputSchema).toBeDefined();

            // Verify schema has required fields
            const properties = (vscodeTools.inputSchema as any).properties;
            expect(properties.pattern).toBeDefined();
            expect(properties.include).toBeDefined();
            expect(properties.path).toBeDefined();
        });
    });

    describe('GitIgnore Integration', () => {
        it('should respect gitignore patterns during search', async () => {
            const mockIgnore = {
                add: vi.fn().mockReturnThis(),
                checkIgnore: vi.fn().mockImplementation((path) => ({
                    ignored: path.includes('node_modules') || path.includes('.log')
                }))
            } as any;
            vi.mocked(ignore).mockReturnValue(mockIgnore);

            // Mock file system with ignored files
            mockReadDirectory.mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/test/git-repo') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory],
                        ['node_modules', vscode.FileType.Directory],
                        ['debug.log', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/test/git-repo/src') {
                    return Promise.resolve([
                        ['index.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            mockReadFile.mockResolvedValue(Buffer.from('const test = "value";'));

            const toolCall = {
                name: 'search_for_pattern',
                args: {
                    pattern: 'test'
                }
            };

            const results = await toolExecutor.executeTools([toolCall]);

            expect(results).toHaveLength(1);
            expect(gitUtils.readGitignore).toHaveBeenCalledWith(
                mockGitOperationsManager.getRepository()
            );

            // Should find matches only in non-ignored files
            const resultContent = results[0].result.join('\n');
            expect(resultContent).toContain('<file>src/index.ts</file>');
            expect(resultContent).not.toContain('node_modules');
            expect(resultContent).not.toContain('debug.log');
        });
    });
});