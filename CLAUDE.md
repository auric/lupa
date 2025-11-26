# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lupa** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It leverages both Language Server Protocol (LSP) queries and semantic similarity search via embeddings to provide intelligent context for PR analysis.

## Key Technologies

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build Tool**: Vite
- **Testing**: Vitest
- **UI Framework**: React 19 with TypeScript and React Compiler
- **UI Components**: shadcn/ui with Tailwind CSS v4
- **Diff Viewer**: react-diff-view with VSCode theme integration
- **Markdown**: react-markdown v10 with syntax highlighting
- **Embedding Models**: Hugging Face Transformers (@huggingface/transformers) - Default: Xenova/all-MiniLM-L6-v2
- **Vector Search**: HNSWlib for Approximate Nearest Neighbor (ANN) search
- **Database**: SQLite (@vscode/sqlite3) for metadata storage
- **Code Analysis**: Tree-sitter for parsing and symbol extraction
- **Worker Threads**: Tinypool for parallel embedding generation

## Development Commands

```bash
# Build and type check (development mode)
npm run build

# Build with file watching
npm run watch

# Package for production
npm run package

# Type checking only
npm run check-types

# Clean build artifacts
npm run clean

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Architecture Overview

The extension follows a layered, service-oriented architecture with clear separation of concerns and dependency inversion to eliminate circular dependencies:

### Core Coordinator Layer

- **`PRAnalysisCoordinator`** (`src/services/prAnalysisCoordinator.ts`) - Refactored lightweight coordinator that delegates to specialized coordinators
- **`ServiceManager`** (`src/services/serviceManager.ts`) - Centralized dependency injection container with phased initialization and service reinitialization
- **`AnalysisOrchestrator`** (`src/coordinators/analysisOrchestrator.ts`) - Handles core PR analysis workflow
- **`EmbeddingModelCoordinator`** (`src/coordinators/embeddingModelCoordinator.ts`) - Handles embedding model UI workflows, delegates service reinitialization to ServiceManager
- **`CopilotModelCoordinator`** (`src/coordinators/copilotModelCoordinator.ts`) - Manages GitHub Copilot language model operations
- **`DatabaseOrchestrator`** (`src/coordinators/databaseOrchestrator.ts`) - Manages database operations and optimization
- **`CommandRegistry`** (`src/coordinators/commandRegistry.ts`) - Centralizes VS Code command registration

### Indexing System

- **`IndexingService`** (`src/services/indexingService.ts`) - Processes individual files for chunking and embedding generation using single-file API
- **`IndexingManager`** (`src/services/indexingManager.ts`) - Manages continuous and full re-indexing workflows
- **`CodeChunkingService`** (`src/services/codeChunkingService.ts`) - Structure-aware code chunking using Tree-sitter
- **`EmbeddingGenerationService`** (`src/services/embeddingGenerationService.ts`) - Manages worker pool for parallel embedding generation
- **Worker**: `embeddingGeneratorWorker.ts` - Generates embeddings in separate processes using Hugging Face models

### Context Retrieval (Hybrid LSP + Embedding)

- **`ContextProvider`** (`src/services/contextProvider.ts`) - Combines LSP queries with semantic similarity search
  - Uses VS Code LSP for precise structural information (definitions, references)
  - Uses embedding-based search for semantic similarity via HNSWlib ANN index
- **`EmbeddingDatabaseAdapter`** (`src/services/embeddingDatabaseAdapter.ts`) - Bridges indexing and storage systems with singleton pattern
- **`VectorDatabaseService`** (`src/services/vectorDatabaseService.ts`) - Manages SQLite metadata and HNSWlib vector index

### Analysis System (with Tool-Calling)

- **`AnalysisOrchestrator`** (`src/coordinators/analysisOrchestrator.ts`) - Coordinates the complete PR analysis workflow, choosing between tool-calling and legacy approaches based on user settings.
- **`ToolCallingAnalysisProvider`** (`src/services/toolCallingAnalysisProvider.ts`) - Manages the conversational tool-calling loop with the LLM, including conversation management and tool execution.
- **`AnalysisProvider`** (`src/services/analysisProvider.ts`) - Legacy analysis provider using embedding-based context retrieval, available as fallback.
- **`ConversationManager`** (`src/models/conversationManager.ts`) - Manages the multi-turn conversation history with the LLM.
- **`ToolExecutor`** (`src/models/toolExecutor.ts`) - Executes tool calls with rate limiting (50 calls per session) to prevent runaway loops
- **`ToolRegistry`** (`src/models/toolRegistry.ts`) - Registry of available tools for code exploration
- **Tools** (`src/tools/`) - Individual tools that let the LLM explore code dynamically during analysis
- **`CopilotModelManager`** (`src/models/copilotModelManager.ts`) - Interfaces with VS Code's Language Model API.
- **`ContextProvider`** (`src/services/contextProvider.ts`) - Provides context for legacy embedding-based approach.
- **`TokenManagerService`** (`src/services/tokenManagerService.ts`) - Optimizes context to fit model limits.

### Git Integration

- **`GitService`** (`src/services/gitService.ts`) - Interfaces with Git via VS Code's Git extension
- **`GitOperationsManager`** (`src/services/gitOperationsManager.ts`) - Manages Git operations and diff preparation

### UI and Status

- **`UIManager`** (`src/services/uiManager.ts`) - Creates webviews and handles user interactions
- **`StatusBarService`** (`src/services/statusBarService.ts`) - Manages multiple, contextual VS Code status bar items with on-demand progress indicators

### Modern React UI System

- **`AnalysisView.tsx`** (`src/webview/AnalysisView.tsx`) - Main React component with clean hook-based architecture
- **Component Architecture**:
  - `AnalysisTab.tsx` - Memoized analysis results display
  - `ContextTab.tsx` - Memoized context information display
  - `DiffTab.tsx` - Memoized diff viewer using react-diff-view
  - `MarkdownRenderer.tsx` - Syntax-highlighted markdown with code block detection
  - `CopyButton.tsx` - Reusable copy-to-clipboard functionality
- **Custom Hooks**:
  - `useTheme.tsx` - VSCode theme detection and luminance calculation
  - `useCopyToClipboard.tsx` - Copy functionality with temporary state management
- **Styling Architecture**:
  - `globals.css` - Global VSCode theme integration and shadcn UI variables
  - `styles/markdown.css` - Markdown and syntax highlighting styles
  - `styles/diff.css` - react-diff-view theme integration
  - `styles/copy-button.css` - Copy button specific styles

## Data Flow

### Service Initialization (Phase-Based)

1. **Phase 1 - Foundation**: `WorkspaceSettingsService`, `ResourceDetectionService`, `LoggingService`, `StatusBarService`, `UIManager`, `GitOperationsManager`
2. **Phase 2 - Core**: `EmbeddingModelSelectionService`, `CopilotModelManager`, `VectorDatabaseService`
3. **Phase 3 - Complex**: `IndexingManager` → `IndexingService` → `EmbeddingDatabaseAdapter` (breaks circular dependency via null injection then setter injection)
4. **Phase 4 - High-Level**: `ContextProvider`, `AnalysisProvider`, `ToolCallingAnalysisProvider` (tool-calling services)

### Analysis Workflow

#### Tool-Calling Approach (Default)

1. **Analysis Initiation**: `AnalysisOrchestrator` checks `WorkspaceSettingsService.isEmbeddingLspAlgorithmEnabled()` and uses `ToolCallingAnalysisProvider` by default.
2. **Conversational Loop**: LLM dynamically requests context using tools like `FindSymbolTool` through multi-turn conversation managed by `ConversationManager`.
3. **Tool Execution**: `ToolExecutor` runs requested tools in parallel via VS Code LSP APIs, with results fed back to the LLM.
4. **Response Generation**: LLM provides final analysis after gathering necessary context through tool calls.

#### Legacy Embedding Approach (Fallback)

1. **Indexing**: Files are processed individually by `IndexingService.processFile()` which uses `CodeChunkingService` for structure-aware chunking, then `EmbeddingGenerationService` generates embeddings in parallel using worker threads.
2. **Storage**: Embeddings and metadata are stored via `VectorDatabaseService` (SQLite + HNSWlib)
3. **Pre-Context Retrieval**: When `enableEmbeddingLspAlgorithm: true`, `ContextProvider` combines LSP queries and embedding search to find relevant context upfront.
4. **Optimization**: `TokenManagerService` optimizes context to fit model limits using waterfall truncation.
5. **Analysis**: `AnalysisProvider` sends the optimized prompt with pre-retrieved context to Copilot models via `CopilotModelManager`.

## Key File Locations

### Services

- `src/services/` - All service implementations
- `src/services/prAnalysisCoordinator.ts` - Main coordinator (entry point)
- `src/services/serviceManager.ts` - Centralized dependency injection container

### Coordinators

- `src/coordinators/` - Specialized coordinator implementations
- `src/coordinators/analysisOrchestrator.ts` - PR analysis orchestration
- `src/coordinators/embeddingModelCoordinator.ts` - Embedding model management
- `src/coordinators/copilotModelCoordinator.ts` - Copilot model management
- `src/coordinators/databaseOrchestrator.ts` - Database operations
- `src/coordinators/commandRegistry.ts` - VS Code command registration

### Types

- `src/types/` - TypeScript type definitions
- `src/types/contextTypes.ts` - Context and diff structures
- `src/types/embeddingTypes.ts` - Embedding and similarity search types
- `src/types/indexingTypes.ts` - Indexing workflow types

### Workers

- `src/workers/embeddingGeneratorWorker.ts` - Parallel embedding generation
- `src/workers/workerCodeChunker.ts` - Code chunking utilities

### Configuration

- `src/config/treeSitterQueries.ts` - Tree-sitter queries for code parsing

### Tests

- `src/__tests__/` - Vitest test files
- `vitest.jsdom.setup.ts` - Test setup configuration for jsdom environment

## Testing Strategy

- **Unit Tests**: Service isolation with mocked dependencies
- **Integration Tests**: Service interactions and end-to-end workflows
- Test files follow pattern: `*.test.ts` or `*.spec.ts`
- Mocks are in `__mocks__/` directory
- Run single test: `npx vitest run src/path/to/test.test.ts`

## React UI Implementation Details

### Component Architecture

The webview uses a modern React architecture with performance optimizations:

- **Main Component** (`src/webview/AnalysisView.tsx`): Lightweight container using custom hooks
- **Memoized Components**: All tab components use `React.memo` for performance
- **Custom Hooks**: Extracted theme detection and copy functionality
- **Modular CSS**: Separate files for different UI concerns

### Key Features

- **VSCode Theme Integration**: Automatic light/dark theme detection with luminance calculation
- **Syntax Highlighting**: react-syntax-highlighter with VSCode color schemes
- **Code Block Detection**: Fixed react-markdown v9 compatibility for proper block detection
- **Copy Functionality**: Copy buttons on all code blocks with success feedback
- **Diff Viewer**: react-diff-view with full VSCode theme integration
- **Responsive Design**: Adaptive diff view (split/unified) based on window size

### Performance Optimizations

- **React Compiler**: Automatic memoization and optimization for React 19
- **Strategic memo()**: Manual memoization for expensive components (DiffTab, ContextTab, MarkdownRenderer)
- **Hook Extraction**: Separates concerns and improves testability
- **CSS Code Splitting**: Modular styles for better maintainability
- **Efficient Rendering**: Proper key props and minimal state updates

### File Structure

```
src/webview/
├── AnalysisView.tsx           # Main component (117 lines)
├── components/
│   ├── AnalysisTab.tsx        # Analysis results
│   ├── ContextTab.tsx         # Context information
│   ├── DiffTab.tsx            # Diff viewer
│   ├── MarkdownRenderer.tsx   # Markdown with syntax highlighting
│   └── CopyButton.tsx         # Reusable copy button
├── hooks/
│   ├── useTheme.tsx           # VSCode theme detection
│   └── useCopyToClipboard.tsx # Copy functionality
├── styles/
│   ├── markdown.css           # Markdown styles
│   ├── diff.css               # Diff viewer styles
│   └── copy-button.css        # Copy button styles
└── globals.css                # Global styles & theme variables
```

## Development Notes

### Worker Thread Architecture

- Embedding generation uses Tinypool for worker management
- Workers are isolated processes that load Hugging Face models
- Main thread remains responsive during intensive operations

### Hybrid Context System

- LSP provides precise structural information (definitions, references)
- Embeddings provide semantic similarity for broader context
- Results are combined and ranked by relevance

### Performance Considerations

- HNSWlib provides efficient ANN search for large embedding indexes
- SQLite stores metadata while vectors are in the ANN index
- Incremental indexing minimizes resource usage
- Background processing prevents UI blocking

### Model Management

- Embedding models are downloaded to `models/` directory
- **Default model**: Xenova/all-MiniLM-L6-v2 (Jina models being phased out)
- Proper separation between embedding models and GitHub Copilot language models
- Model selection affects vector database configuration

### Circular Dependency Resolution

The new architecture eliminates circular dependencies through:

- **Dependency Inversion**: Using interfaces and null injection followed by setter injection
- **Phased Initialization**: ServiceManager initializes services in 4 phases to respect dependencies
- **Service Registry**: Type-safe service access through IServiceRegistry interface
- **Specialized Coordinators**: Breaking monolithic coordinator into focused components
- **Null Injection Pattern**: IndexingManager is created with null EmbeddingDatabaseAdapter, then the adapter is created and injected via setter

### IndexingService Architecture

The IndexingService follows Single Responsibility Principle with these key improvements:

- **Single-File Processing**: `processFile()` method processes one file at a time instead of batch generators
- **Custom Error Types**: `ChunkingError` and `EmbeddingError` with proper cause chaining for better debugging
- **Proper Resource Cleanup**: AbortSignal handling with try/finally blocks ensures resources are always cleaned up
- **Simplified Testing**: Direct method calls instead of complex generator patterns make testing more straightforward
- **Clear Separation**: File processing logic is separated from batch orchestration, which is handled by IndexingManager

### TokenManagerService Architecture & Waterfall Truncation

The TokenManagerService has been refactored into a coordinator pattern with specialized classes (TokenCalculator, WaterfallTruncator, ContextOptimizer, TokenConstants) while maintaining the same public API. The system manages token allocation and implements sophisticated waterfall truncation logic:

#### Core Waterfall Truncation Logic

- **Priority-Based Allocation**: Content types are processed in strict priority order: `diff → embedding → lsp-reference → lsp-definition`
- **Full Allocation Strategy**: Higher-priority content receives full token allocation before lower-priority content gets remaining tokens
- **Separate Context Fields**: Individual truncation of different context types (`embeddingContext`, `lspReferenceContext`, `lspDefinitionContext`)
- **Token Budget Management**: Precise calculation of fixed overhead vs. available content tokens
- **Graceful Degradation**: Content that cannot fit even with truncation is removed entirely

#### Waterfall Algorithm Steps

1. **Fixed Token Calculation**: Calculate non-truncatable tokens (system prompt, message overhead, formatting)
2. **Available Budget**: `targetTokens - fixedTokens = availableTokensForContent`
3. **Priority Processing**: Process each content type in configured priority order
4. **Full Allocation Attempt**: Each content type tries to use its full token requirement
5. **Remaining Token Allocation**: If content exceeds remaining tokens, truncate to fit exactly
6. **Removal Fallback**: If truncation isn't viable, remove content entirely

### Status Bar Architecture

- **Contextual Progress**: Status indicators appear only during active operations
- **Multiple Independent Items**: Uses unique IDs to manage different operation types simultaneously
- **Automatic Cleanup**: try/finally blocks ensure progress indicators are always removed
- **Consistent IDs**: Related operations (indexing, embedding generation) use shared IDs to prevent duplicates
- **Temporary Messages**: Success/error feedback with auto-disposal after timeout

## Extension Commands

The extension provides these VS Code commands:

- `lupa.analyzePR` - Analyze Pull Request
- `lupa.manageIndexing` - Manage indexing operations
- `lupa.selectEmbeddingModel` - Select embedding model
- `lupa.startContinuousIndexing` - Start background indexing
- `lupa.stopContinuousIndexing` - Stop background indexing

## Debugging

- Extension logs to VS Code Developer Console
- Use VS Code's extension host debugging for breakpoints
- Status bar shows real-time operation status
- Test with `F5` to launch extension development host

## Codebase Analysis

When analyzing large codebases or multiple files that might exceed context limits, use the Gemini CLI with its massive
context window. Use `gemini -p` to leverage Google Gemini's large context capacity.

### File and Directory Inclusion Syntax

Use the `@` syntax to include files and directories in your Gemini prompts. The paths should be relative to WHERE you run the
gemini command:

#### Examples:

Single file analysis:
`gemini -p "@src/main.py Explain this file's purpose and structure"`

Multiple files:
`gemini -p "@package.json @src/index.js Analyze the dependencies used in the code"`

Entire directory:
`gemini -p "@src/ Summarize the architecture of this codebase"`

Multiple directories:
`gemini -p "@src/ @tests/ Analyze test coverage for the source code"`

Current directory and subdirectories:
`gemini -p "@./ Give me an overview of this entire project"` or use `--all_files` flag: `gemini --all_files -p "Analyze the project structure and dependencies"`

Implementation Verification Examples

Check if a feature is implemented:
`gemini -p "@src/ @lib/ Has dark mode been implemented in this codebase? Show me the relevant files and functions"`

Verify authentication implementation:
`gemini -p "@src/ @middleware/ Is JWT authentication implemented? List all auth-related endpoints and middleware"`

Check for specific patterns:
`gemini -p "@src/ Are there any React hooks that handle WebSocket connections? List them with file paths"`

Verify error handling:
`gemini -p "@src/ @api/ Is proper error handling implemented for all API endpoints? Show examples of try-catch blocks"`

Check for rate limiting:
`gemini -p "@backend/ @middleware/ Is rate limiting implemented for the API? Show the implementation details"`

Verify caching strategy:
`gemini -p "@src/ @lib/ @services/ Is Redis caching implemented? List all cache-related functions and their usage"`

Check for specific security measures:
`gemini -p "@src/ @api/ Are SQL injection protections implemented? Show how user inputs are sanitized"`

Verify test coverage for features:
`gemini -p "@src/payment/ @tests/ Is the payment processing module fully tested? List all test cases"`

### When to Use Gemini CLI

Use gemini -p when:

- Analyzing entire codebases or large directories
- Comparing multiple large files
- Need to understand project-wide patterns or architecture
- Current context window is insufficient for the task
- Working with files totaling more than 100KB
- Verifying if specific features, patterns, or security measures are implemented
- Checking for the presence of certain coding patterns across the entire codebase

### Important Notes

- Paths in @ syntax are relative to your current working directory when invoking gemini
- The CLI will include file contents directly in the context
- No need for --yolo flag for read-only analysis
- Gemini's context window can handle entire codebases that would overflow Claude's context
- When checking implementations, be specific about what you're looking for to get accurate results

## BMAD Method Integration

**BMAD (Breakthrough Method for Agile AI-Driven Development)** is integrated for enhanced development workflows using specialized AI agents. BMAD focuses on structured, quality-controlled development with emphasis on documentation-first approaches and systematic integration.

### BMAD Core Architecture

The BMAD system provides structured prompts, templates, and workflows to guide AI agents through complex development tasks. It supports both greenfield (new projects) and brownfield (existing project enhancement) development approaches.

#### Core Directory Structure

- **Agents**: `.bmad-core/agents/` - Specialized AI agents with YAML headers defining roles, capabilities, and dependencies
- **Agent Teams**: `.bmad-core/agent-teams/` - Coordinated multi-agent workflows
- **Templates**: `.bmad-core/templates/` - Document templates with markup language rules
- **Tasks**: `.bmad-core/tasks/` - Repeatable action instructions
- **Workflows**: `.bmad-core/workflows/` - Development sequence definitions
- **Checklists**: `.bmad-core/checklists/` - Quality assurance validation (e.g., `story-dod-checklist.md`)
- **Data**: `.bmad-core/data/` - Knowledge base and technical preferences
- **Configuration**: `.bmad-core/core-config.yaml` - BMAD behavior settings

### Agent File Reading and Dependency Resolution

**CRITICAL**: BMAD agents MUST automatically load and read additional files based on their YAML configuration headers. Each agent:

1. **Loads Dependencies**: Agents specify required resources in their YAML headers (templates, tasks, knowledge base data)
2. **Reads Project Documentation**: Agents automatically access project-specific documentation from `docs/` folder
3. **Follows Lean Context Principle**: Agents only load resources they need to maintain focused context
4. **Supports Recursive Dependencies**: The dependency resolution system recursively finds and bundles required resources

#### Dependency Path Resolution

When BMAD agents reference files, they follow this resolution order:

1. `.bmad-core/` subdirectories for framework resources
2. `docs/` directory for project-specific documentation
3. Root directory for project files

**Examples**:

- Agent references `prd-tmpl.yaml` → Loads from `.bmad-core/templates/prd-tmpl.yaml`
- Agent references `architect-checklist.md` → Loads from `.bmad-core/checklists/architect-checklist.md`
- Agent needs project architecture → Reads from `docs/project-architecture.md`

## Coding Standards

This project follows strict TypeScript development standards to ensure code quality, maintainability, and consistency across the codebase.

### TypeScript Guidelines

- **Type Safety**: Use TypeScript interfaces and strict typing throughout
- **Optional Parameter Handling**: Use explicit union types (`| undefined` or `| null`) instead of optional operators (`?`) for better type safety and clarity
  - ✅ Preferred: `parameter: string | undefined`
  - ❌ Avoid: `parameter?: string`
  - This makes null/undefined handling explicit and prevents accidental undefined access
  - For object properties that may not exist, use `| undefined` to be explicit about the possibility
- **Null vs Undefined**: Be consistent in choice between `null` and `undefined`
  - Use `| undefined` for values that may not be set or initialized
  - Use `| null` for values that are explicitly set to represent "no value"
  - Avoid mixing both in the same interface unless semantically meaningful
- **Async Patterns**: Always use `async/await` for asynchronous operations, avoid Promise chains
- **Error Handling**: Implement comprehensive error handling with try/catch blocks and proper error propagation

### Code Structure

- **Function Size**: Keep functions small and focused on a single responsibility
- **Naming Conventions**: Use consistent, descriptive naming following TypeScript/JavaScript conventions
  - Classes: PascalCase (e.g., `ServiceManager`, `AnalysisProvider`)
  - Methods/Functions: camelCase (e.g., `processFile`, `generateEmbeddings`)
  - Constants: UPPER_SNAKE_CASE (e.g., `DEFAULT_MODEL_NAME`)
  - Interfaces: PascalCase with 'I' prefix (e.g., `IServiceRegistry`)
- **File Organization**: Follow established patterns in `src/` directory structure

### Logging and Debugging

- **Logging Service**: Use the centralized `Log` service for all logging instead of `console.log`
- **Exceptions**: Workers (`src/workers/`) and webviews (`src/webview/`) may use `console.log` due to their isolated execution contexts
- **Debug Information**: Include meaningful context in log messages for troubleshooting

### Architecture Compliance

- **Dependency Injection**: Follow the established ServiceManager pattern for dependency management
- **Circular Dependencies**: Avoid circular dependencies using dependency inversion and phased initialization
- **Service Patterns**: Implement services as singletons where appropriate, with proper disposal methods
- **Interface Implementation**: Use interfaces to define contracts between services

### Testing Requirements

- **Test Coverage**: Write unit tests for new functionality using Vitest
- **Mocking**: Use proper mocking for dependencies in isolated unit tests
- **Integration Tests**: Include integration tests for service interactions
- **Test Naming**: Follow pattern `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx` for test files
