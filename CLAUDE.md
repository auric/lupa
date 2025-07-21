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

### Analysis System

- **`AnalysisProvider`** (`src/services/analysisProvider.ts`) - Manages code analysis using Copilot models
- **`CopilotModelManager`** (`src/models/copilotModelManager.ts`) - Interfaces with VS Code's Language Model API (implements vscode.Disposable)
- **`TokenManagerService`** (`src/services/tokenManagerService.ts`) - Optimizes context to fit token limits
- **`ContextProvider`** (`src/services/contextProvider.ts`) - Singleton service that combines LSP queries with semantic similarity search

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
4. **Phase 4 - High-Level**: `ContextProvider`, `AnalysisProvider`

### Analysis Workflow

1. **Indexing**: Files are processed individually by `IndexingService.processFile()` which uses `CodeChunkingService` for structure-aware chunking, then `EmbeddingGenerationService` generates embeddings in parallel using worker threads. The `IndexingManager` orchestrates multiple single-file calls for batch processing.
2. **Storage**: Embeddings and metadata are stored via `VectorDatabaseService` (SQLite + HNSWlib)
3. **Analysis**: When analyzing PRs, `ContextProvider` combines LSP queries and embedding search to find relevant context
4. **Optimization**: `TokenManagerService` optimizes context to fit model limits
5. **Generation**: `AnalysisProvider` sends the optimized prompt to Copilot models via `CopilotModelManager`

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
- `vitest.setup.ts` - Test setup configuration

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

## BMAD Method Integration

**BMAD (Breakthrough Method for Agile AI-Driven Development)** is integrated for enhanced development workflows using specialized AI agents.

### BMAD File Locations

- **Agents**: `.bmad-core/agents/` - Specialized AI agents (pm, architect, dev, qa, sm, etc.)
- **Templates**: `.bmad-core/templates/` - Document templates (YAML format)
- **Tasks**: `.bmad-core/tasks/` - Repeatable action instructions
- **Workflows**: `.bmad-core/workflows/` - Development sequence definitions
- **Checklists**: `.bmad-core/checklists/` - Quality assurance validation
- **Data**: `.bmad-core/data/` - Knowledge base and preferences
- **Configuration**: `.bmad-core/core-config.yaml` - BMAD behavior settings

### Important Template Path Resolution

**CRITICAL**: When BMAD tasks reference templates or other dependencies, they are located in `.bmad-core/` subdirectories, NOT in the same directory as the task. For example:

- Task references `prd-tmpl.yaml` → Look in `.bmad-core/templates/prd-tmpl.yaml`
- Task references `architect-checklist.md` → Look in `.bmad-core/checklists/architect-checklist.md`

### BMAD Agent Usage

- **Claude Code**: Use `/agent-name` (e.g., `/bmad-master`, `/dev`, `/pm`)
- **Commands**: Use `*command` syntax (e.g., `*help`, `*create`, `*status`)
- **Document Requirements**: Place PRD at `docs/prd.md` and Architecture at `docs/architecture.md`

## Coding Standards

This project follows strict TypeScript development standards to ensure code quality, maintainability, and consistency across the codebase.

### TypeScript Guidelines

- **Type Safety**: Use TypeScript interfaces and strict typing throughout
- **Undefined Handling**: For potentially undefined data, use union types (`| undefined`) instead of optional object members
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
- **Test Naming**: Follow pattern `*.test.ts` or `*.spec.ts` for test files
