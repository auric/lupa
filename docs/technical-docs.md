# Lupa Technical Documentation

## 1. System Architecture

### 1.1 Architectural Overview

The Lupa follows a layered, service-oriented architecture with clear separation of concerns and dependency inversion to eliminate circular dependencies. The system features a modern React-based UI with full VSCode theme integration and performance optimizations. The system is designed around these key architectural principles:

- **Modular Services**: Each component is implemented as a self-contained service
- **Dependency Injection**: Services receive dependencies through their constructors with phased initialization
- **Singleton Pattern**: Core services are implemented as singletons to ensure consistent state
- **Event-Based Communication**: Services communicate through events for loose coupling
- **Worker Thread Isolation**: Computationally intensive tasks are isolated in worker threads
- **Reactive UI Updates**: UI components react to state changes in underlying services
- **Circular Dependency Resolution**: Uses dependency inversion with null injection followed by setter injection
- **Specialized Coordinators**: Decomposed architecture with focused coordinators for different concerns
- **Type Safety**: IServiceRegistry interface ensures compile-time service access validation

The overall architecture consists of these primary layers:

#### 1.1.1 Extension Layer

- Acts as the entry point to the extension
- Registers VS Code commands and event handlers
- Initializes the core services and coordinators
- Manages extension lifecycle (activation/deactivation)

#### 1.1.2 Coordination Layer

- **ServiceManager** (`src/services/serviceManager.ts`): Centralized dependency injection container with phased initialization and service reinitialization
- **PRAnalysisCoordinator** (`src/services/prAnalysisCoordinator.ts`): Lightweight coordinator that delegates to specialized coordinators
- **AnalysisOrchestrator** (`src/coordinators/analysisOrchestrator.ts`): Handles core PR analysis workflow
- **EmbeddingModelCoordinator** (`src/coordinators/embeddingModelCoordinator.ts`): Handles embedding model UI workflows, delegates service reinitialization to ServiceManager
- **CopilotModelCoordinator** (`src/coordinators/copilotModelCoordinator.ts`): Manages GitHub Copilot language model operations
- **DatabaseOrchestrator** (`src/coordinators/databaseOrchestrator.ts`): Manages database operations and optimization
- **CommandRegistry** (`src/coordinators/commandRegistry.ts`): Centralizes VS Code command registration

#### 1.1.3 Service Layer

- Contains specialized services for specific functionality domains
- Implements the core business logic of the extension
- Manages resources and state for specific domains
- Communicates with other services through well-defined interfaces

#### 1.1.4 Data Layer

- Handles persistence of embeddings, settings, and analysis results
- Provides efficient retrieval of relevant data
- Ensures data consistency and integrity
- Manages data migrations and schema evolution

#### 1.1.5 Worker Layer

- Executes CPU-intensive embedding generation in separate threads ([`embeddingGeneratorWorker.ts`](src/workers/embeddingGeneratorWorker.ts:1) managed by [`EmbeddingGenerationService`](src/services/embeddingGenerationService.ts:1), which is in turn used by [`IndexingService`](src/services/indexingService.ts:1)).
- Tokenization and analysis (LSP, diff parsing) primarily occur in the main extension thread or dedicated language server processes.
- Code chunking ([`WorkerCodeChunker`](src/workers/workerCodeChunker.ts:1)) is used internally by [`CodeChunkingService`](src/services/codeChunkingService.ts:1), which is invoked by [`IndexingService`](src/services/indexingService.ts:1) for main-thread chunking.
- Workers communicate with the main thread via structured messages.
- Worker threads manage their own resource allocation and cleanup for embedding models.

#### 1.1.6 UI Layer

- **React-Based Webview**: Modern React 19 architecture with TypeScript
- **Component-Based Design**: Modular, memoized components for optimal performance
- **VSCode Theme Integration**: Automatic light/dark theme detection with full integration
- **Syntax Highlighting**: react-syntax-highlighter with VSCode color schemes
- **Diff Visualization**: react-diff-view with responsive split/unified views
- **Handles user interactions and commands**
- **Provides feedback on long-running operations**
- **Supports different view modalities (webview, editor annotations, status bar)**

### 1.2 Service Initialization (Phase-Based)

The ServiceManager initializes services in four phases to resolve dependencies:
1. **Foundation**: Settings, logging, UI, Git services
2. **Core**: Model management and database services  
3. **Complex**: Indexing services (uses null injection then setter injection for circular dependencies)
4. **High-Level**: Context and analysis providers

#### 1.2.2 Analysis Workflow

1. **Context Retrieval**: Extract symbols from diff, query LSP for definitions/references, search embeddings for semantic similarity
2. **Context Optimization**: Use TokenManagerService to fit context within token limits via waterfall truncation
3. **Analysis Execution**: Send optimized prompt to language model via CopilotModelManager
4. **Result Presentation**: Display analysis results in React webview with context, diff, and analysis tabs

#### 1.2.3 Indexing Workflow

1. **File Discovery**: IndexingManager identifies files for processing
2. **Structure-Aware Chunking**: Parse code with Tree-sitter, break into coherent chunks
3. **Parallel Embedding Generation**: Generate embeddings in worker threads using Tinypool
4. **Storage**: Store results in hybrid SQLite + HNSWlib database

#### 1.2.4 Context Retrieval (Hybrid LSP + Embedding)

Combines LSP structural queries with semantic embedding search:
1. **Symbol Extraction**: Parse diff to identify key symbols and generate embedding queries
2. **LSP Search**: Query language server for symbol definitions and references  
3. **Embedding Search**: Use HNSWlib ANN index to find semantically similar code
4. **Context Optimization**: TokenManagerService applies waterfall truncation to fit token limits

### 1.3 Cross-Cutting Concerns

- **Error Handling**: Domain-specific error handling with fallback strategies
- **Performance**: Worker threads for CPU-intensive tasks, caching, incremental processing
- **Resource Management**: VS Code Disposable pattern, dynamic worker lifecycle
- **Status Management**: Contextual progress indicators with automatic cleanup
- **Dependency Resolution**: Phased initialization with null injection for circular dependencies

## 2. Core Components

The system consists of coordinators, services, and data layers with clear separation of concerns.

### 2.1 Coordination Layer

- **ServiceManager**: Centralized dependency injection with 4-phase initialization
- **PRAnalysisCoordinator**: Lightweight orchestrator delegating to specialized coordinators
- **Specialized Coordinators**: Analysis, embedding models, Copilot models, database, commands

### 2.2 Indexing System

- **IndexingService**: Processes individual files using `processFile()` method, delegates to chunking and embedding services
- **IndexingManager**: Orchestrates batch processing, model selection, and database persistence  
- **EmbeddingDatabaseAdapter**: Bridges indexing results with storage and search capabilities

### 2.3 Vector Database System

- **VectorDatabaseService**: Hybrid SQLite + HNSWlib storage, manages single active embedding model per workspace
- **CodeAnalysisService**: Tree-sitter based AST parsing, symbol identification, and structure-aware chunking

### 2.4 Context System

- **ContextProvider**: Orchestrates hybrid LSP + embedding context retrieval, parses diffs, extracts symbols
- **TokenManagerService**: Manages token allocation, implements waterfall truncation, optimizes context to fit model limits

### 2.5 Analysis System

- **AnalysisProvider**: Manages analysis workflow, mode selection, prompt engineering, and response processing
- **CopilotModelManager**: Interfaces with VS Code Language Model API, handles model discovery and token management

### 2.6 Git Integration

- **GitService**: Interfaces with VS Code Git extension for repository access, branch/commit management, diff generation
- **GitOperationsManager**: Coordinates Git operations, provides selection UI, prepares diffs for analysis

### 2.7 UI System

- **UIManager**: Creates React-based webviews, manages VS Code webview lifecycle
- **React Architecture**: Modern React 19 with memoized components, custom hooks, VSCode theme integration
- **StatusBarService**: Contextual progress indicators with automatic cleanup and unique operation IDs

### 2.8 Settings Management

- **WorkspaceSettingsService**: Persistent storage, workspace-specific configuration, settings migration

## 3. Key Algorithms

### 3.1 Embedding Generation

1. **File Selection**: Identify and filter files based on language support and patterns
2. **Structure-Aware Chunking**: Use Tree-sitter to parse code into coherent chunks at function/class boundaries  
3. **Parallel Embedding**: Generate embeddings in worker threads using Hugging Face models
4. **Storage**: Store results in hybrid SQLite + HNSWlib database

### 3.2 Context Retrieval (Hybrid LSP + Embedding)

1. **Symbol Extraction**: Parse diff to identify key symbols and generate embedding queries
2. **LSP Search**: Query language server for symbol definitions and references
3. **Embedding Search**: Use HNSWlib ANN index to find semantically similar code chunks
4. **Context Optimization**: Apply waterfall truncation via TokenManagerService to fit token limits

### 3.3 Token Management & Waterfall Truncation Algorithm

The token management process ensures the final prompt respects the language model's input token limits using a sophisticated waterfall truncation strategy that prioritizes content by importance.

#### 3.3.1 Waterfall Truncation Overview

The system implements a **true waterfall allocation strategy** where higher-priority content receives full token allocation before lower-priority content gets remaining tokens. This ensures that the most critical information (typically diff content) is preserved even under severe token constraints.

**Priority Order (Default)**:
1. `diff` - Code changes being analyzed (highest priority)
2. `embedding` - Semantically similar code context  
3. `lsp-reference` - Symbol usage locations
4. `lsp-definition` - Symbol definition locations (lowest priority)

**Key Principles**:
- **Full Allocation First**: Each content type attempts to use its complete token requirement
- **Remaining Token Distribution**: If content exceeds available tokens, it's truncated to fit exactly
- **Graceful Degradation**: Content that cannot fit even with truncation is removed entirely
- **Separate Field Processing**: Different context types (`embeddingContext`, `lspReferenceContext`, `lspDefinitionContext`) are truncated independently

#### 3.3.2 Waterfall Algorithm Implementation

The waterfall truncation process follows these precise steps:

1.  **Fixed Token Calculation**: Calculate non-truncatable components including system prompt, message overhead, and formatting overhead

2.  **Available Content Budget**: Determine available tokens for content by subtracting fixed tokens from target limit

3.  **Priority-Order Processing**: Iterate through content types in configured priority order (diff → embedding → lsp-reference → lsp-definition)

4.  **Full Allocation Attempt**: Each content type attempts to use its complete token requirement from remaining budget

5.  **Truncation to Fit**: If content exceeds remaining tokens, truncate it to fit exactly within the remaining budget

6.  **Removal Fallback**: Content that cannot be meaningfully truncated (too small after truncation) is removed entirely

7.  **Budget Update**: Subtract allocated tokens from remaining budget for next content type

8.  **Termination**: Process stops when no tokens remain or all content types processed

#### 3.3.3 Legacy Token Management Algorithm

1.  **System Prompt & Diff Structure Tokenization:**

    - The `AnalysisProvider` provides the system prompt and the parsed diff structure (`DiffHunk[]`) to `TokenManagerService` (or the service calculates them).
    - `TokenManagerService` estimates tokens for:
      - The system prompt.
      - The structural parts of the interleaved diff (file headers, hunk headers, `+`/`-`/` ` lines, and placeholders/separators for context like "--- Relevant Context ---"). This is the `diffStructureTokens` calculated in `AnalysisProvider`.

2.  **Budget Calculation for Context Snippets:**

    - `TokenManagerService.calculateTokenAllocation` uses the model's total token limit (via `CopilotModelManager`), subtracts tokens for the system prompt, the `diffStructureTokens`, and a safety/formatting buffer. The result is the `contextAllocationTokens` budget _specifically for the content of the context snippets_.

3.  **Context Snippet Optimization (`TokenManagerService.optimizeContext`):**

    - Receives the full list of `ContextSnippet` objects (from LSP and embeddings) and the `contextAllocationTokens` budget.
    - Sorts snippets by relevance: embedding results (by similarity score) > LSP references > LSP definitions, optimized for PR analysis needs.
    - Iteratively adds sorted snippets to a "selected list" as long as their cumulative token count (including small buffers for inter-snippet newlines) fits within `contextAllocationTokens`.
    - If a snippet doesn't fit fully but significant budget remains, it attempts partial truncation (e.g., keeping headers, a portion of the content, and adding a `[File content partially truncated...]` message). The token cost of the truncated snippet (including the message) must fit.
    - Returns the `optimizedSnippets` array and a `wasTruncated` flag.

4.  **Final Prompt Construction (in `AnalysisProvider`):**

    - The `AnalysisProvider` iterates through the `parsedDiff` (`DiffHunk[]`).
    - For each diff hunk, it appends the hunk's diff lines.
    - It then finds the _optimized snippets_ from the list returned by `TokenManagerService.optimizeContext` that are associated with the current `hunkId`.
    - These selected, optimized snippets are appended after their respective diff hunk.
    - This creates the final interleaved prompt content.

5.  **UI Context String Generation (`TokenManagerService.formatContextSnippetsToString`):**
    - Separately, `TokenManagerService` formats the list of _optimized snippets_ into a single, readable markdown string (with "## Definitions Found (LSP)", etc., headers) for display in the UI's context tab. This string indicates if overall truncation occurred.

This approach ensures that the budget calculation for context snippets correctly accounts for the tokens already consumed by the non-snippet parts of the interleaved prompt.

### 3.4 Analysis Workflow

1. **Mode Selection**: Configure analysis mode and system prompt
2. **Context Retrieval**: Extract and optimize context using waterfall truncation
3. **Model Interaction**: Send structured prompt to language model  
4. **Result Presentation**: Display analysis in React webview with navigation

## 4. Core Data Structures

### 4.1 Database Schema (Hybrid SQLite + HNSWlib)

- **Files Table**: File metadata (id, path, hash, language, indexing status)
- **Chunks Table**: Code chunk content and offsets within files  
- **Embeddings Table**: Metadata mapping chunk IDs to HNSWlib numerical labels
- **HNSWlib ANN Index**: Actual embedding vectors for efficient similarity search

### 4.2 Key Data Structures

- **ProcessingResult**: File processing outcome with embeddings, chunk offsets, and metadata
- **ContextSnippet**: Context snippets with type ('lsp-definition' | 'lsp-reference' | 'embedding'), content, and relevance scores
- **DiffHunk**: Structured diff representation with file paths and line changes
- **TokenAllocation**: Token budget allocation for system prompt, diff, context, and overhead components

## 5. Implementation Guidelines

### 5.1 Service Implementation

- **Interface Definition**: Clear interfaces with documented methods and error conditions
- **Dependency Injection**: Constructor-based injection with support for circular dependency resolution
- **Resource Management**: VS Code Disposable pattern with proper cleanup
- **Error Handling**: Domain-specific error handling with fallback strategies

### 5.2 Database Patterns

- **Hybrid Storage**: SQLite for metadata, HNSWlib for vector operations
- **Transaction Safety**: Use transactions for multi-step operations
- **Query Safety**: Parameterized queries to prevent injection
- **Connection Management**: On-demand connections with proper cleanup

### 5.3 Performance Guidelines

- **Memory**: Release large objects, monitor ANN index size, use streaming for large files
- **CPU**: Worker threads for embedding generation, support operation cancellation
- **I/O**: Async file operations, batch database writes, efficient ANN index loading
