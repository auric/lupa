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

### 1.2 Component Interactions

The components interact through these primary mechanisms:

#### 1.2.1 Service Initialization Flow (Phase-Based)

1. **Extension Activation**: When the extension activates, it creates the `PRAnalysisCoordinator`
2. **ServiceManager Creation**: PRAnalysisCoordinator creates ServiceManager for dependency injection
3. **Phase 1 - Foundation Services**: `WorkspaceSettingsService`, `ResourceDetectionService`, `LoggingService`, `StatusBarService`, `UIManager`, `GitOperationsManager`
4. **Phase 2 - Core Services**: `EmbeddingModelSelectionService`, `CopilotModelManager`, `VectorDatabaseService`
5. **Phase 3 - Complex Services**: `IndexingManager` → `IndexingService` → `EmbeddingDatabaseAdapter` (breaks circular dependency via null injection then setter injection)
6. **Phase 4 - High-Level Services**: `ContextProvider`, `AnalysisProvider`
7. **Coordinator Creation**: Specialized coordinators are created with the service registry
8. **Command Registration**: VS Code commands are registered through CommandRegistry
9. **Event Subscription**: Services subscribe to events from other services

#### 1.2.2 Analysis Workflow

1.  **Command Invocation**: User invokes the "Analyze PR" command.
2.  **PR Selection**: User selects the PR or changes to analyze via `GitOperationsManager`.
3.  **Mode Selection**: User selects the analysis mode via `UIManager`.
4.  **Diff Extraction**: `GitOperationsManager` provides the relevant diff text.
5.  **Context Retrieval (`ContextProvider`)**:
    - Analyzes the diff to identify key symbols and changes.
    - **LSP Queries:** Uses VS Code's LSP (`executeDefinitionProvider`, `executeReferenceProvider`) to find precise definitions and usages of identified symbols across the workspace. Extracts relevant code snippets.
    - **Embedding Search:** Generates embeddings for diff chunks and queries the `EmbeddingDatabaseAdapter` (using an optimized backend like HNSWlib) for semantically similar code snippets from the indexed workspace.
    - Returns both structured LSP results and embedding-based context strings.
6.  **Context Combination & Optimization (`AnalysisProvider`, `TokenManagerService`)**:
    - Formats LSP results (definitions, usages) into markdown.
    - Combines formatted LSP context and embedding context.
    - Uses `TokenManagerService` to ensure the combined context fits within the language model's token limits, potentially pruning less relevant parts.
7.  **Analysis Execution (`AnalysisProvider`, `CopilotModelManager`)**:
    - Constructs the final prompt including the system prompt, PR diff, and the combined/optimized context.
    - Sends the prompt to the selected language model via `CopilotModelManager`.
8.  **Result Presentation (`UIManager`)**:
    - Receives the analysis from `AnalysisProvider`.
    - Displays the analysis results, potentially highlighting or linking context snippets back to their source or type (LSP vs. embedding).

#### 1.2.3 Indexing Workflow

1.  **File Discovery & Prioritization**: The `IndexingManager` identifies source files in the workspace. For continuous indexing, it checks which files have changed since the last run. For a full re-index, all supported files are selected.
2.  **Model Selection**: `EmbeddingModelSelectionService` determines the optimal embedding model (default: `Xenova/all-MiniLM-L6-v2`, Jina models being phased out) based on system resources and user configuration. The `ServiceManager` ensures the `VectorDatabaseService` is configured with the correct embedding dimension for this model.
3.  **Single-File Processing**: The `IndexingManager` orchestrates multiple calls to `IndexingService.processFile()`, processing files one at a time with proper error handling and progress reporting.
4.  **Structure-Aware Chunking**: For each file, `IndexingService` uses `CodeChunkingService` (which internally uses `CodeAnalysisService`) to parse the code and break it into structurally coherent chunks on the main extension thread.
5.  **Parallel Embedding Generation**: The resulting chunks for a file are passed to `EmbeddingGenerationService`, which manages a `Tinypool` worker pool. Each worker (`embeddingGeneratorWorker.ts`) generates an embedding for a single chunk in a separate process, ensuring the main thread remains responsive.
6.  **Synchronous Results**: Once all chunks for a single file have been embedded, `IndexingService` constructs and returns a complete `ProcessingResult` object.
7.  **Immediate Storage**: The `IndexingManager` receives the complete `ProcessingResult` and immediately passes it to the `EmbeddingDatabaseAdapter` to be saved in the `VectorDatabaseService` (both SQLite and the HNSWlib index).
8.  **Status Updates**: `IndexingManager` manages a `vscode.Progress` notification window for overall progress and contextual status bar indicators using the `StatusBarService` with unique operation IDs and automatic cleanup.

#### 1.2.4 Context Retrieval Workflow (Hybrid LSP + Embedding)

The context retrieval workflow now employs a hybrid approach, combining precise structural information via Language Server Protocol (LSP) with broader semantic similarity via embeddings. The integration of an Approximate Nearest Neighbor (ANN) library (HNSWlib) is fully implemented for the embedding search component.

1.  **Diff Parsing & Symbol/Query Extraction (`ContextProvider`):**

    - The input PR diff is parsed into structured `DiffHunk` objects.
    - `extractMeaningfulChunksAndSymbols` is called:
      - It identifies key symbols (functions, classes, variables) within added/modified lines using `CodeAnalysisService.findSymbols` on the full file content corresponding to diff locations. These symbols are tagged with their file path and position.
      - It generates a diverse set of `embeddingQueries` from the diff, including the identified symbol names, small code snippets around these symbols, and small, entirely new code blocks.

2.  **LSP-Based Structural Search (`ContextProvider`):**

    - For each identified symbol, `findSymbolDefinition` and `findSymbolReferences` are called using `vscode.commands.executeCommand` to query the active language server.
    - The returned `vscode.Location[]` are used by `getSnippetsForLocations` to fetch surrounding code, which is then formatted into markdown snippets. These become `ContextSnippet` objects with `type: 'lsp-definition'` or `type: 'lsp-reference'` and high relevance scores.

3.  **Embedding-Based Semantic Search (`ContextProvider` -> `EmbeddingDatabaseAdapter` -> `VectorDatabaseService`):**

    - The `embeddingQueries` are used to generate query embeddings via the active `IndexingService`.
    - `EmbeddingDatabaseAdapter.findRelevantCodeContextForChunks` calls `VectorDatabaseService.findSimilarCode`.
    - `VectorDatabaseService.findSimilarCode` (which uses HNSWlib) queries the ANN index with these vectors to get the K nearest numerical labels and their distances.
    - Metadata (chunk content, file path, etc.) for these labels is fetched from SQLite.
    - Results are converted to `SimilaritySearchResult` objects, which are then transformed into `ContextSnippet` objects with `type: 'embedding'` and relevance scores based on similarity.

4.  **Context Aggregation (`ContextProvider`):**

    - All `ContextSnippet` objects (from LSP and embeddings) are collected.
    - If no relevant snippets are found, `getFallbackContextSnippets` is invoked.

5.  **Context Optimization & Prompt Construction (`AnalysisProvider` -> `TokenManagerService`):**

    - The `AnalysisProvider` receives the `HybridContextResult` (containing `parsedDiff` and the array of `ContextSnippet` objects).
    - `TokenManagerService.optimizeContext` prunes the `ContextSnippet` array based on relevance scores and available token budget.
    - `AnalysisProvider` then constructs the final LLM prompt by interleaving diff hunks (from `parsedDiff`) with their associated, _optimized_ context snippets.
    - `TokenManagerService.formatContextSnippetsToString` is used to generate a summary string of the context for UI display or logging, but the prompt itself uses the interleaved structure.

6.  **Context Delivery (`AnalysisProvider`):**
    - The interleaved prompt (diff + linked context) is sent to the LLM.
    - The `optimizedContext` string (summary of selected snippets) is returned for UI display.

### 1.3 Cross-Cutting Concerns

These aspects affect multiple components across the system:

#### 1.3.1 Error Handling Strategy

- Each service implements domain-specific error handling
- Errors are categorized as recoverable or non-recoverable
- Recoverable errors trigger fallback mechanisms
- Non-recoverable errors are reported to the user with guidance
- Error state is propagated through status updates

#### 1.3.2 Performance Considerations

- Resource-intensive operations are performed in worker threads
- Progress reporting allows for cancelation of long-running operations
- Batch processing prevents UI freezing
- Caching is implemented at multiple levels
- Incremental indexing minimizes resource usage

#### 1.3.3 Resource Management

- Services implement the VS Code Disposable pattern
- Resources are released in reverse order of acquisition
- Worker threads are created and destroyed dynamically
- Memory usage is monitored and optimized
- File handles and database connections are properly managed

#### 1.3.4 Status Management Pattern

- **Contextual Progress**: Status indicators appear only during active operations
- **Unique Operation IDs**: Each operation type uses consistent IDs (e.g., 'indexing', 'pr-analysis')
- **Try/Finally Cleanup**: Progress indicators are guaranteed to be removed via try/finally blocks
- **No Global State**: StatusBarService operates as a stateless UI utility
- **Automatic Lifecycle**: Status items are created on-demand and auto-disposed

#### 1.3.5 Circular Dependency Resolution Strategy

- **Dependency Inversion**: Using interfaces and abstract dependencies
- **Null Injection Pattern**: Creating services with null dependencies, then injecting via setters
- **Phased Initialization**: ServiceManager respects dependency order through 4 distinct phases
- **Service Registry**: Type-safe access to all services through IServiceRegistry interface
- **Setter Injection**: Complete circular dependencies after initial creation

## 2. Core Components

### 2.0 Architecture Summary

- Lightweight `PRAnalysisCoordinator` (~117 lines) delegating to specialized coordinators
- `ServiceManager` with phased initialization and dependency inversion
- Specialized coordinators for different concerns (analysis, models, database, commands)
- Eliminated circular dependencies through null injection + setter injection pattern
- Clear separation between embedding models (MiniLM) and Copilot language models

### 2.1 Coordination Architecture

#### 2.1.1 ServiceManager (Dependency Injection Container)

The `ServiceManager` (`src/services/serviceManager.ts`) is the centralized dependency injection container that eliminates circular dependencies:

**Phased Initialization:**
- **Phase 1 - Foundation**: Services with no dependencies (settings, logging, UI, Git)
- **Phase 2 - Core**: Model management and database services
- **Phase 3 - Complex**: Breaks circular dependencies using null injection then setter injection pattern
- **Phase 4 - High-Level**: Services that depend on complex services

**Circular Dependency Resolution:**
- `IndexingManager` is created with null `EmbeddingDatabaseAdapter`
- `IndexingService` is extracted from the manager
- `EmbeddingDatabaseAdapter` is created with the `IndexingService`
- Adapter is injected back into the manager via setter injection

#### 2.1.2 PRAnalysisCoordinator (Lightweight Orchestrator)

The refactored `PRAnalysisCoordinator` (`src/services/prAnalysisCoordinator.ts`) is now a lightweight component that delegates to specialized coordinators:

**Responsibilities:**
- Creates and manages the `ServiceManager`
- Instantiates specialized coordinators with the service registry
- Provides external access to coordinators for testing/integration
- Handles disposal of all coordinators and services

#### 2.1.3 Specialized Coordinators

**AnalysisOrchestrator** (`src/coordinators/analysisOrchestrator.ts`):
- Handles core PR analysis workflow orchestration
- Manages UI interactions and Git operations for analysis

**EmbeddingModelCoordinator** (`src/coordinators/embeddingModelCoordinator.ts`):
- Manages embedding model selection and switching (MiniLM focus)
- Handles database reindexing when models change

**CopilotModelCoordinator** (`src/coordinators/copilotModelCoordinator.ts`):
- Manages GitHub Copilot language model operations
- Separate from embedding model management for clarity

**DatabaseOrchestrator** (`src/coordinators/databaseOrchestrator.ts`):
- Manages database operations and optimization
- Handles storage statistics and maintenance

**CommandRegistry** (`src/coordinators/commandRegistry.ts`):
- Centralizes VS Code command registration
- Maps commands to appropriate coordinator methods
- Reduces complexity in main coordinator

#### 2.1.3 Analysis Workflow Orchestration

- Coordinates the PR analysis workflow across services
- Manages transitioning between workflow states
- Ensures consistent error handling across the workflow
- Provides cancellation capabilities for long-running operations

#### 2.1.4 Resource Management

- Implements VS Code Disposable pattern
- Properly disposes of all initialized services
- Ensures resource cleanup on extension deactivation
- Manages worker thread lifecycle

### 2.2 Indexing System

The indexing system consists of several components working together to generate and store embeddings for code.

#### 2.2.1 Indexing Service

The [`IndexingService`](src/services/indexingService.ts:1) (src/services/indexingService.ts) processes individual files for chunking and embedding generation. Its primary method, `processFile`, processes a single file and returns a `ProcessingResult`. It delegates to [`CodeChunkingService`](src/services/codeChunkingService.ts:1) and [`EmbeddingGenerationService`](src/services/embeddingGenerationService.ts:1).

- **Orchestrates Chunking**: Uses [`CodeChunkingService`](src/services/codeChunkingService.ts:1) to process files. [`CodeChunkingService`](src/services/codeChunkingService.ts:1) internally utilizes [`WorkerCodeChunker`](src/workers/workerCodeChunker.ts:1) (and [`CodeAnalysisService`](src/services/codeAnalysisService.ts:1)) to read files and break them into manageable code chunks. This chunking happens on the main thread, typically one file at a time.
- **Orchestrates Embedding Generation**: After [`CodeChunkingService`](src/services/codeChunkingService.ts:1) successfully chunks a file, [`IndexingService`](src/services/indexingService.ts:1) passes the resulting `ChunkForEmbedding[]` to [`EmbeddingGenerationService`](src/services/embeddingGenerationService.ts:1). [`EmbeddingGenerationService`](src/services/embeddingGenerationService.ts:1) manages a `Tinypool` worker pool (running [`embeddingGeneratorWorker.ts`](src/workers/embeddingGeneratorWorker.ts:1)) and dispatches individual chunk embedding tasks to these workers.
- **Single-File Processing**: Uses `processFile(file: FileToProcess, token?: vscode.CancellationToken)` method that processes one file at a time, applying Single Responsibility Principle.
- **Synchronous Result**: Returns a complete `ProcessingResult` for the processed file, containing embeddings, chunk offsets, and metadata.
- **Error Handling**: Implements custom error types (`ChunkingError`, `EmbeddingError`) with proper cause chaining for better error context.
- **Resource Cleanup**: Supports cancellation through `AbortSignal` with proper resource cleanup using try/finally blocks.
- **Cancellation Support**: Supports cancellation of in-progress indexing operations, propagating signals to chunking and embedding tasks.
- **Focus on Processing**: Pure processing logic without UI concerns; status updates are handled by `IndexingManager`.

Key interactions:

- Receives individual files to process from `IndexingManager` via `processFile()` method calls.
- Uses [`CodeChunkingService`](src/services/codeChunkingService.ts:1) for structure-aware code chunking of individual files.
- Uses [`EmbeddingGenerationService`](src/services/embeddingGenerationService.ts:1) for parallel embedding generation of chunks from a file.
- Returns complete `ProcessingResult` for each processed file to its caller (typically `IndexingManager`).
- Does not handle status updates; focuses purely on processing logic.

#### 2.2.2 Indexing Manager

The `IndexingManager` (src/services/indexingManager.ts) provides higher-level indexing control:

- **Model Selection**: Selects appropriate embedding model.
- **Continuous Indexing**: Manages background indexing of workspace files.
- **Full Reindexing**: Coordinates full database rebuilds.
- **File Discovery**: Finds relevant files for indexing.
- **Batch Orchestration**: Orchestrates multiple `indexingService.processFile(...)` calls to process files sequentially or in controlled batches.
- **Data Persistence**: For each completed file processing result, it is responsible for saving the `ProcessingResult` via the `EmbeddingDatabaseAdapter`.

Key interactions:

- Uses `EmbeddingModelSelectionService` to select models.
- Creates and manages `IndexingService` instances.
- Calls `indexingService.processFile` for each file that needs processing.
- Uses `EmbeddingDatabaseAdapter` to save each `ProcessingResult`.
- The `IndexingService` updates the last indexing timestamp in `WorkspaceSettingsService` upon successful completion.
- `IndexingManager` manages its own `vscode.Progress` display for notifications and contextual status bar indicators using unique operation IDs.

#### 2.2.3 Embedding Database Adapter

The `EmbeddingDatabaseAdapter` (src/services/embeddingDatabaseAdapter.ts) bridges indexing and storage:

- **Result Processing**: Processes embedding results from indexing
- **Storage Management**: Manages storing embeddings in database
- **Similarity Search**: Enhances vector similarity search
- **Result Enhancement**: Enhances search results with additional context

Key interactions:

- Receives results from `IndexingManager` (which obtains them from `IndexingService`)
- Uses `VectorDatabaseService` for storage operations
- Provides search capabilities to `ContextProvider`
- Is initialized with `WorkspaceSettingsService`; underlying `VectorDatabaseService` handles more direct settings interactions for database metadata.

### 2.3 Vector Database System

The vector database system manages the storage and retrieval of embeddings and code chunks.

#### 2.3.1 Vector Database Service

The `VectorDatabaseService` (src/services/vectorDatabaseService.ts) manages embedding storage and retrieval, now leveraging HNSWlib for efficient vector search:

- **Single Active Model Focus**: The database (both SQLite metadata and the ANN index) is tied to a single, currently active embedding model for the workspace. If the model changes, the database must be rebuilt.
- **Schema Management**: Creates and maintains the SQLite database schema for files, chunks, and _embedding metadata_ (chunk ID, ANN label, creation timestamp). Vectors themselves are primarily managed by the ANN index.
- **Transaction Handling**: Ensures data consistency for SQLite write operations.
- **ANN Index Management**:
  - Initializes and manages an `hnswlib.HierarchicalNSW` instance for Approximate Nearest Neighbor search.
  - The ANN index is initialized with the dimension of the currently active embedding model.
  - Implements persistence for the ANN index (`saveAnnIndex`, `loadAnnIndex`), storing it typically alongside the SQLite DB file.
- **Embedding Storage**:
  - When `storeEmbeddings` is called:
    - Assigns a unique numerical label to each embedding vector.
    - Adds the vector and its label to the `hnswlib.HierarchicalNSW` index.
    - Stores the `chunkId` and its corresponding `label` (along with `createdAt`, `id`) in the SQLite `embeddings` table. The actual vector is _not_ stored in SQLite.
- **Similarity Search**:
  - When `findSimilarCode` is called:
    - The HNSWlib index is queried with the `queryVector` to get the K nearest numerical labels and their distances.
    - These labels are then used to look up the associated `chunkId` and other metadata (content, file path) from the SQLite `chunks` and `files` tables.
    - Distances are converted to similarity scores.
- **Data Deletion**: Handles deletion of embeddings from both the ANN index (marking points for deletion) and SQLite metadata.
- **Database Optimization**: Provides methods to optimize the SQLite database (VACUUM, ANALYZE). The ANN index might have its own optimization considerations depending on the library.

Key interactions:

- Receives storage requests (chunk metadata, vectors) from `EmbeddingDatabaseAdapter`.
- Provides search capabilities (labels from ANN, then metadata from SQLite) to `EmbeddingDatabaseAdapter`.
- Uses SQLite for persistent storage of all metadata.
- Uses `hnswlib-node` for ANN indexing and search.
- Receives current embedding model dimension via `setCurrentModelDimension` from `PRAnalysisCoordinator` to initialize/re-initialize the ANN index.

#### 2.3.2 Code Analysis Service

The `CodeAnalysisService` (`src/services/codeAnalysisService.ts`) analyzes code structure using Tree-sitter:

- **Language Parsing**: Parses code into an Abstract Syntax Tree (AST) using the appropriate Tree-sitter grammar.
- **Points of Interest Extraction**: Uses language-specific queries from `treeSitterQueries.ts` to find significant, high-level nodes (e.g., functions, classes) that serve as chunking breakpoints. It intentionally ignores smaller or less meaningful structures like individual import statements.
- **Symbol Identification**: Provides a `findSymbols` method to extract named symbols (functions, classes, etc.) from code, which is used by the `ContextProvider` to identify key entities in a diff.
- **Comment Association**: The `getLinesForPointsOfInterest` method correctly associates preceding comments and decorators with the code structures they document, ensuring that documentation is included in the same chunk as the code.

Key interactions:

- Used by `CodeChunkingService` (via `WorkerCodeChunker`) for structure-aware chunking.
- Used by `ContextProvider` for identifying symbols within diffs.
- Relies on Tree-sitter and the queries defined in `src/config/treeSitterQueries.ts`.

### 2.4 Context System

The context system finds, retrieves, and optimizes relevant code context from the workspace to aid the language model in analyzing Pull Requests. It employs a hybrid approach using Language Server Protocol (LSP) for structural understanding and embeddings with an Approximate Nearest Neighbor (ANN) index for semantic similarity.

#### 2.4.1 Context Provider

The `ContextProvider` (`src/services/contextProvider.ts`) orchestrates context retrieval:

- **Diff Parsing & Symbol/Query Extraction** (`ContextProvider`):
  - Parses the input PR diff into structured `DiffHunk` objects (each with a unique `hunkId`).
  - Calls its internal `extractMeaningfulChunksAndSymbols` method, which:
    - Uses `CodeAnalysisService.findSymbols` to identify key symbols (functions, classes, variables) within added/modified lines of the diff, considering the full file content.
    - Generates a set of `embeddingQueries` from the diff, including identified symbol names, small code snippets around these symbols, and small, entirely new code blocks.
- **LSP Context Retrieval**:
  - For each identified symbol, it asynchronously calls its `findSymbolDefinition` and `findSymbolReferences` methods (which use `vscode.commands.executeCommand` for LSP calls).
  - Uses `getSnippetsForLocations` to fetch surrounding code for the `vscode.Location[]` returned by LSP calls.
  - Formats these into `ContextSnippet` objects with `type: 'lsp-definition'` or `type: 'lsp-reference'`, assigning high relevance scores and associating them with the relevant `hunkId`(s).
- **Embedding-Based Semantic Context Retrieval**:
  - Uses `EmbeddingDatabaseAdapter.findRelevantCodeContextForChunks` with the `embeddingQueries`. This involves:
    - Generating embeddings for the queries via the active `IndexingService`.
    - Querying the `VectorDatabaseService` (which uses an HNSWlib ANN index) for similar vectors.
    - Fetching metadata for the results from SQLite.
  - Formats these results into `ContextSnippet` objects with `type: 'embedding'`, using similarity scores as relevance and associating them with relevant `hunkId`(s).
- **Context Aggregation**: Collects all `ContextSnippet` objects from both LSP and embedding searches.
- **Fallback**: If no primary context is found, invokes `getFallbackContextSnippets`.
- **Output**: Returns a `HybridContextResult` object containing the array of all `ContextSnippet` objects and the `parsedDiff` (array of `DiffHunk`).

Key interactions:

- Uses `CodeAnalysisService` for symbol identification within diffs.
- Uses VS Code API for LSP queries (`vscode.commands.executeCommand`).
- Uses `EmbeddingDatabaseAdapter` for semantic similarity search (which in turn uses `VectorDatabaseService` with HNSWlib).
- Provides `HybridContextResult` to `AnalysisProvider`.

#### 2.4.2 Token Manager Service

The `TokenManagerService` (`src/services/tokenManagerService.ts`) manages token allocation for the language model prompt:

- **Token Counting**: Accurately counts tokens for different components (system prompt, structured diff, context snippets) using the current language model's `countTokens` method (via `CopilotModelManager`).
- **Token Allocation**: Calculates the total token usage and compares it against the selected language model's limit, determining the budget available specifically for context snippets.
- **Context Optimization**: The `optimizeContext` method now receives an array of `ContextSnippet` objects. It prunes this list based on `relevanceScore` (embeddings > LSP references > LSP definitions) to fit within the `availableTokens` budget, prioritizing semantic similarity for PR analysis. It handles partial truncation of snippets if needed, adding appropriate truncation messages.
- **Context Formatting**: The `formatContextSnippetsToString` method takes an array of `ContextSnippet` objects and formats them into a single markdown string, typically used for UI display or logging, clearly labeling LSP and embedding sections.
- **Prompt Component Understanding**: Accounts for tokens used by the system prompt and the _interleaved structure_ of the diff and its linked context when calculating available tokens for context snippets.

Key interactions:

- Used by `AnalysisProvider` before sending the prompt to the LLM.
- Works with `CopilotModelManager` for model token limits and `countTokens` API.
- Receives an array of `ContextSnippet` from `AnalysisProvider` for optimization.

### 2.5 Analysis System

The analysis system interfaces with language models to analyze code changes.

#### 2.5.1 Analysis Provider

The `AnalysisProvider` (src/services/analysisProvider.ts) manages code analysis:

- **Mode Selection**: Implements different analysis modes
- **Prompt Engineering**: Creates effective prompts for models
- **Query Execution**: Sends queries to language models
- **Response Processing**: Processes and formats model responses
- **Follow-up Support**: Supports follow-up questions and refinement

Key interactions:

- Uses `ContextProvider` for relevant context
- Uses `CopilotModelManager` for model access
- Uses `TokenManagerService` for token optimization
- Provides analysis results to UI components

#### 2.5.2 Copilot Model Manager

The `CopilotModelManager` (src/models/copilotModelManager.ts) manages language models:

- **Model Discovery**: Discovers available language models
- **Model Selection**: Selects appropriate models for tasks
- **Fallback Strategies**: Implements fallback when models are unavailable
- **Version Management**: Manages model versions and compatibility
- **Token Management**: Provides token information for models

Key interactions:

- Interfaces with VS Code's Language Model API
- Used by `AnalysisProvider` for model access
- Works with `WorkspaceSettingsService` for preferences
- Provides model information to `TokenManagerService`

### 2.6 Git Integration

The Git integration system interfaces with Git repositories to extract changes.

#### 2.6.1 Git Service

The `GitService` (src/services/gitService.ts) interfaces with Git:

- **Repository Access**: Accesses Git repositories through VS Code
- **Branch Management**: Gets information about branches
- **Commit Access**: Accesses commit information and diffs
- **Diff Generation**: Generates diffs between refs
- **Change Tracking**: Tracks uncommitted changes

Key interactions:

- Interfaces with VS Code's Git extension
- Used by `GitOperationsManager` for Git operations
- Provides diff information to analysis workflow
- Reports repository status to coordinator

#### 2.6.2 Git Operations Manager

The `GitOperationsManager` (src/services/gitOperationsManager.ts) manages Git operations:

- **Operation Coordination**: Coordinates Git operations
- **Selection UI**: Provides UI for Git selection
- **Diff Preparation**: Prepares diffs for analysis
- **Error Handling**: Handles Git operation errors
- **Fallback Strategies**: Implements fallbacks for failed operations

Key interactions:

- Uses `GitService` for direct Git operations
- Provides diff information to `PRAnalysisCoordinator`
- Interfaces with VS Code's UI for selection
- Reports operation status to coordinator

### 2.7 UI Components

The UI system presents analysis results using a modern React-based architecture.

#### 2.7.1 UI Manager

The `UIManager` (src/services/uiManager.ts) manages UI components:

- **Webview Creation**: Creates React-based webviews for results
- **HTML Generation**: Generates HTML wrapper for React components
- **User Interaction**: Handles user input and selection
- **Progress Display**: Shows progress for long operations
- **React Integration**: Manages React component lifecycle

Key interactions:

- Used by `PRAnalysisCoordinator` for result display
- Interfaces with VS Code's webview API
- Uses `StatusBarService` for status updates
- Provides selection interfaces to coordinator

#### 2.7.2 React UI Architecture

The webview uses a modern React architecture with performance optimizations:

**Main Components:**
- **`AnalysisView.tsx`**: Main container component using custom hooks
- **`AnalysisTab.tsx`**: Memoized analysis results display
- **`ContextTab.tsx`**: Memoized context information display
- **`DiffTab.tsx`**: Memoized diff viewer using react-diff-view
- **`MarkdownRenderer.tsx`**: Syntax-highlighted markdown with code block detection
- **`CopyButton.tsx`**: Reusable copy-to-clipboard functionality

**Custom Hooks:**
- **`useTheme.tsx`**: VSCode theme detection with luminance calculation
- **`useCopyToClipboard.tsx`**: Copy functionality with temporary state management

**Styling Architecture:**
- **`globals.css`**: Global VSCode theme integration and shadcn UI variables
- **`styles/markdown.css`**: Markdown and syntax highlighting styles
- **`styles/diff.css`**: react-diff-view VSCode theme integration
- **`styles/copy-button.css`**: Copy button specific styles

**Key Features:**
- **VSCode Theme Integration**: Automatic light/dark theme detection
- **Syntax Highlighting**: react-syntax-highlighter with VSCode color schemes
- **Code Block Detection**: Fixed react-markdown v9 compatibility
- **Copy Functionality**: Copy buttons on all code blocks with success feedback
- **Diff Viewer**: react-diff-view with full VSCode theme integration
- **Responsive Design**: Adaptive diff view (split/unified) based on window size
- **Performance Optimizations**: React.memo, hook extraction, CSS code splitting

**Implementation Details:**

The React UI implementation addresses several key technical challenges:

1. **react-markdown v9 Compatibility**: Fixed code block detection using parent element analysis, newline detection, and language class detection instead of the deprecated `inline` prop.

2. **VSCode Theme Integration**: Implemented automatic theme detection using CSS variable parsing and luminance calculation to determine light/dark mode.

3. **Language Hint Generation**: Fixed language detection for syntax highlighting by properly accessing the `language` property from `SupportedLanguage` objects.

4. **Performance Optimization**: Reduced main component from 425 lines to 117 lines through proper component decomposition and memoization.

5. **Modular Architecture**: Separated concerns into focused components with individual CSS files for better maintainability.

#### 2.7.3 Status Bar Service

The `StatusBarService` (src/services/statusBarService.ts) manages contextual, on-demand status display:

- **Contextual Progress**: Shows progress indicators only during active operations using unique IDs
- **Multiple Independent Items**: Manages multiple status items simultaneously without conflicts
- **Automatic Cleanup**: Ensures progress indicators are always removed via try/finally patterns
- **Temporary Messages**: Shows success/error feedback with auto-disposal after timeout
- **No Global State**: Operates as a UI utility without maintaining central state

Key interactions:

- Used by coordinators and managers for operation-specific status updates
- Interfaces with VS Code's status bar API
- Provides contextual feedback during long-running operations
- Automatically manages lifecycle of status indicators

### 2.8 Settings Management

The settings system manages user preferences and workspace configuration.

#### 2.8.1 Workspace Settings Service

The `WorkspaceSettingsService` (src/services/workspaceSettingsService.ts) manages settings:

- **Setting Storage**: Stores settings persistently
- **Setting Retrieval**: Retrieves settings with defaults
- **Workspace Specificity**: Manages workspace-specific settings
- **Settings Migration**: Handles settings format migration
- **Default Management**: Provides sensible defaults

Key interactions:

- Used by all services for configuration
- Interfaces with VS Code's storage API
- Saves user preferences between sessions
- Provides workspace-specific configuration

## 3. Implementation Algorithms

### 3.1 Embedding Generation Algorithm

The embedding generation process follows these steps:

1. **File Selection**

   - Identify files for processing based on changes, requests, or scanning
   - Filter files based on supported languages and exclusion patterns
   - Prioritize files based on relevance to current context

2. **Chunking Preparation**

   - For each file, read its content
   - Determine the language based on file extension
   - Select appropriate chunking strategy based on language

3. **Structure-Aware Chunking**

   - **Breakpoint Identification**: The file is parsed using Tree-sitter to identify the start lines of major structural elements (classes, namespaces, functions) as defined in `treeSitterQueries.ts`.
   - **Segment Creation**: The code is split into segments based on these breakpoints. The content before the first major structure is treated as a "header" chunk.
   - **Token Validation**: Each segment is checked against the model's token limit.
   - **Fallback for Oversized Chunks**: If a segment (representing a large class or function) exceeds the token limit, it is passed to a line-by-line basic chunker, which splits it into smaller pieces that respect the token limit.
   - **Finalization**: Chunks are finalized by trimming extraneous whitespace, but no artificial overlaps are added.

4. **Embedding Generation**

   - For each chunk, generate embedding vectors using the selected model
   - Apply appropriate pooling strategy (mean, max, etc.)
   - Normalize vectors if specified

5. **Result Processing and Return**
   - [`IndexingService`](src/services/indexingService.ts:1) collects chunking details and embedding results for a file.
   - It constructs the final `ProcessingResult` for that file.
   - [`IndexingService`](src/services/indexingService.ts:1) returns this complete `ProcessingResult` to the caller.
   - `IndexingManager` receives the result and handles its persistence, typically by calling `EmbeddingDatabaseAdapter` to store the data.

### 3.2 Similarity Search & Context Retrieval Algorithm (Hybrid LSP + Embedding with ANN)

The context retrieval process combines LSP-based structural search with embedding-based semantic search using an HNSWlib ANN index:

1.  **Diff Parsing & Symbol/Query Extraction (`ContextProvider`):**

    - The input PR diff is parsed into `DiffHunk` objects, each assigned a unique `hunkId`.
    - `extractMeaningfulChunksAndSymbols` analyzes the diff:
      - It uses `CodeAnalysisService.findSymbols` on full file content (mapped from diff locations) to identify symbols in added/modified lines.
      - It generates `embeddingQueries` (key identifiers, small surrounding code snippets, small new blocks) from the diff.

2.  **LSP-Based Structural Search (`ContextProvider`):**

    - For each identified symbol, `vscode.executeDefinitionProvider` and `vscode.executeReferenceProvider` are called.
    - Code snippets around the resulting `vscode.Location[]` are fetched via `getSnippetsForLocations`.
    - These are formatted into `ContextSnippet` objects (`type: 'lsp-definition'` or `'lsp-reference'`) with high relevance scores and associated `hunkId`(s).

3.  **Embedding-Based Semantic Search (`ContextProvider` -> `EmbeddingDatabaseAdapter` -> `VectorDatabaseService`):**

    - Embeddings are generated for the `embeddingQueries` (via `IndexingService`).
    - `VectorDatabaseService.findSimilarCode` is called:
      - It queries the HNSWlib ANN index with the query embeddings to get K nearest numerical labels and distances.
      - It fetches metadata (chunk content, file path) for these labels from its SQLite `chunks` and `files` tables.
      - Distances are converted to similarity scores.
    - Results are converted to `ContextSnippet` objects (`type: 'embedding'`) with relevance based on similarity scores and associated `hunkId`(s).

4.  **Context Aggregation & Initial Filtering (`ContextProvider`):**

    - All `ContextSnippet` objects (LSP, embedding) are collected.
    - Basic filtering/ranking (e.g., `rankAndFilterResults`) might be applied by `ContextProvider` before passing to `AnalysisProvider`.
    - If no primary context is found, `getFallbackContextSnippets` is called.
    - The `ContextProvider` returns a `HybridContextResult` (containing the list of all `ContextSnippet`s and the `parsedDiff`).

5.  **Context Optimization & Prompt Construction (`AnalysisProvider` -> `TokenManagerService`):**

    - The `AnalysisProvider` receives the `HybridContextResult`.
    - `TokenManagerService.calculateTokenAllocation` determines the token budget available specifically for context snippets, considering the system prompt and the token cost of the _interleaved diff structure_.
    - `TokenManagerService.optimizeContext` receives the full list of `ContextSnippet`s and prunes it based on relevance scores (embeddings > LSP refs > LSP defs) to fit the budget, prioritizing semantic similarity for PR analysis. It handles partial truncation.
    - The `AnalysisProvider` then constructs the final LLM prompt by interleaving `DiffHunk`s from `parsedDiff` with their associated, _optimized_ `ContextSnippet`s.

6.  **Final Context for UI (`AnalysisProvider` -> `TokenManagerService`):**
    - `TokenManagerService.formatContextSnippetsToString` creates a formatted string summary of the _optimized_ context snippets for UI display.

### 3.3 Token Management Algorithm

The token management process ensures the final prompt, which now includes an interleaved structure of diff hunks and their specific context snippets, respects the language model's input token limits.

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

### 3.4 Analysis Workflow Algorithm

The analysis process follows these steps:

1. **Mode Selection**

   - Determine analysis mode based on user selection
   - Select appropriate system prompt for the mode
   - Configure token allocation based on mode requirements

2. **Context Retrieval**

   - Extract query from diff/changes
   - Retrieve relevant context using similarity search
   - Optimize context to fit token limits
   - Format context for model input

3. **Prompt Construction**

   - Combine system prompt, diff/changes, and context
   - Structure prompt to maximize model effectiveness
   - Include specific instructions based on analysis mode
   - Format prompt according to model requirements

4. **Model Interaction**

   - Select appropriate language model
   - Send prompt to model
   - Handle streaming response if supported
   - Monitor for token limit errors or other failures

5. **Result Processing**

   - Parse model response
   - Structure response for display
   - Extract actionable insights
   - Format for display in UI

6. **Result Presentation**
   - Display results in appropriate format
   - Provide navigation between analysis, context, and diff
   - Enable follow-up questions or refinement
   - Support interaction with results

## 4. Core Data Structures

#### 4.1 Database Schema

The database system uses a hybrid approach: SQLite for structured metadata and HNSWlib for a high-performance Approximate Nearest Neighbor (ANN) vector index. The schema is designed to support a single active embedding model per workspace.

##### 4.1.1 Files Table (SQLite)

- **id**: `TEXT PRIMARY KEY` - Unique identifier for the file (UUID).
- **path**: `TEXT NOT NULL UNIQUE` - Workspace-relative path to the file.
- **hash**: `TEXT NOT NULL` - SHA-256 hash of the file content to detect changes.
- **last_modified**: `INTEGER NOT NULL` - File modification timestamp.
- **language**: `TEXT` - Detected language of the file (e.g., 'typescript').
- **is_indexed**: `BOOLEAN NOT NULL DEFAULT 0` - Flag indicating if the file has been successfully indexed.
- **size**: `INTEGER NOT NULL DEFAULT 0` - Size of the file in bytes.

##### 4.1.2 Chunks Table (SQLite)

- **id**: `TEXT PRIMARY KEY` - Unique identifier for the code chunk (UUID).
- **file_id**: `TEXT NOT NULL` - Foreign key referencing `files.id`.
- **content**: `TEXT NOT NULL` - The raw text content of the code chunk.
- **start_offset**: `INTEGER NOT NULL` - The chunk's starting character offset in the original file.
- **end_offset**: `INTEGER NOT NULL` - The chunk's ending character offset in the original file.
- **parent_structure_id**: `TEXT` - (Legacy) No longer populated by the current chunking strategy.
- **structure_order**: `INTEGER` - (Legacy) No longer populated by the current chunking strategy.
- **is_oversized**: `BOOLEAN` - (Legacy) No longer populated by the current chunking strategy.
- **structure_type**: `TEXT` - (Legacy) No longer populated by the current chunking strategy.

##### 4.1.3 Embeddings Table (SQLite - Metadata for ANN Index)

- **id**: `TEXT PRIMARY KEY` - Unique identifier for the embedding metadata entry (UUID).
- **chunk_id**: `TEXT NOT NULL UNIQUE` - Foreign key referencing `chunks.id`.
- **label**: `INTEGER UNIQUE NOT NULL` - The numerical label used as the key for this chunk's vector in the HNSWlib ANN index.
- **created_at**: `INTEGER NOT NULL` - Timestamp of when the embedding was created.

#### 4.1.4 Metadata Table (SQLite)

- `key`: TEXT PRIMARY KEY - Key for the metadata entry (e.g., 'last_indexed', 'embedding_model')
- `value`: TEXT NOT NULL - Value of the metadata entry

#### 4.1.5 ANN Index (HNSWlib - Separate File, e.g., `embeddings.ann.idx`)

- Stores the actual `number[]` embedding vectors.
- Indexed by numerical labels which correspond to the `label` column in the SQLite `embeddings` table.
- The dimension of vectors in this index is determined by the currently active embedding model.

### 4.2 In-Memory Data Structures

#### 4.2.1 Code Structure Representation (Unchanged)

- `type`: string - Type of the structure (function, class, method, etc.)
- `name`: string | undefined - Name of the structure if available
- `range`: CodeRange - Position range in the document
- `children`: CodeStructure[] - Child structures
- `parent`: CodeStructure | undefined - Parent structure
- `text`: string - The text content of the structure

#### 4.2.2 Embedding Processing Result (`ProcessingResult` in `indexingTypes.ts`)

This structure (`ProcessingResult`) represents the outcome of processing a single file for embeddings, orchestrated by `IndexingService`. It's returned directly by `IndexingService.processFile()` and combines chunking information and the resulting embedding vectors for the file. This `ProcessingResult` is then typically passed to `EmbeddingDatabaseAdapter` for storage.

- `fileId`: string - Unique identifier of the processed file.
- `filePath`: string - The workspace-relative path to the file.
- `success`: boolean - Overall success status for generating embeddings for this file. True if all intended chunks were successfully embedded.
- `embeddings`: `number[][]` - An array of embedding vectors. Each `number[]` corresponds to a successfully embedded chunk from the file. The order matches `chunkOffsets` and the arrays within `metadata`.
- `chunkOffsets`: `number[]` - An array of numbers, where each number is the starting character offset of a chunk within the original file. The order matches `embeddings` and the arrays within `metadata`.
- `metadata`: `ChunkMetadata` - An object containing arrays of metadata, where each index corresponds to a chunk:
  - `parentStructureIds`: `(string | null)[]` - (Legacy) This array is present but will be populated with `null` by the current chunker.
  - `structureOrders`: `(number | null)[]` - (Legacy) This array is present but will be populated with `null` by the current chunker.
  - `isOversizedFlags`: `(boolean | null)[]` - (Legacy) This array is present but will be populated with `null` by the current chunker.
  - `structureTypes`: `(string | null)[]` - (Legacy) This array is present but will be populated with `null` by the current chunker.
- `error?`: string - An optional string containing an error message if file-level processing failed or to aggregate errors from individual chunk processing.

#### 4.2.3 Similarity Search Result Format (`SimilaritySearchResult` in `embeddingTypes.ts`)

- `chunkId`: string - Identifier of the matched chunk from `chunks` table
- `fileId`: string - Identifier of the file containing the chunk from `files` table
- `filePath`: string - Path to the file
- `content`: string - Content of the matched chunk
- `startOffset`: number - Start position of the chunk in the file
- `endOffset`: number - End position of the chunk in the file
- `score`: number - Similarity score (0-1) from ANN search

#### 4.2.4 Context Snippet Format (`ContextSnippet` in `contextTypes.ts`)

- `id`: string - Unique identifier for the snippet.
- `type`: `'lsp-definition' | 'lsp-reference' | 'embedding'` - Source of the snippet.
- `content`: string - The formatted markdown content of the snippet.
- `relevanceScore`: number - A score indicating relevance (e.g., 1.0 for LSP def, 0.0-1.0 for embeddings).
- `filePath?`: string - Original file path of the snippet.
- `startLine?`: number - Original start line of the snippet in its file.
- `associatedHunkIdentifiers?`: string[] - IDs of diff hunks this snippet is primarily related to.

#### 4.2.5 Diff Hunk Structure (`DiffHunk`, `DiffHunkLine` in `contextTypes.ts`)

- **`DiffHunkLine`**:
  - `oldStart`, `oldLines`, `newStart`, `newLines`: Standard diff hunk header info.
  - `lines`: string[] - Array of diff lines (`+`, `-`, ` `).
  - `hunkId?`: string - Unique identifier for this hunk (e.g., `filePath:newStart`).
- **`DiffHunk`**:
  - `filePath`: string - Path of the file being diffed.
  - `hunks`: `DiffHunkLine[]` - Array of hunks for this file.

#### 4.2.6 Hybrid Context Result (`HybridContextResult` in `contextTypes.ts`)

- `snippets`: `ContextSnippet[]` - The aggregated list of context snippets from all sources.
- `parsedDiff`: `DiffHunk[]` - The structured representation of the input diff.

#### 4.2.7 Token Allocation Format (`TokenAllocation` in `tokenManagerService.ts`)

- `totalAvailableTokens`: number - Maximum tokens for the LLM, after safety margin.
- `totalRequiredTokens`: number - Total tokens for system prompt + _interleaved diff structure_ + _all potential context snippets_ + other overhead, before context optimization.
- `systemPromptTokens`: number - Tokens for the system prompt.
- `diffTextTokens`: number - Tokens for the _interleaved diff structure_ (including diff lines and context placeholders/separators).
- `contextTokens`: number - Tokens for the _preliminary formatted string of all potential context snippets_ (before optimization).
- `userMessagesTokens`: number - Tokens for user messages (if any).
- `assistantMessagesTokens`: number - Tokens for assistant messages (if any).
- `otherTokens`: number - Reserved for general formatting.
- `fitsWithinLimit`: boolean - Whether `totalRequiredTokens` fits `totalAvailableTokens`.
- `contextAllocationTokens`: number - The specific token budget calculated for the _content of the context snippets_ after accounting for system prompt, diff structure, and buffer.

## 5. Implementation Guidelines

### 5.1 Component Implementation Strategy

#### 5.1.1 Service Implementation Pattern

Services should follow this implementation pattern:

1. **Interface Definition**

   - Define a clear interface for the service
   - Document all methods and parameters
   - Specify error conditions and handling

2. **Singleton Management**

   - Implement getInstance() static method
   - Support proper singleton reset for testing
   - Handle initialization state correctly

3. **Dependency Injection**

   - Receive dependencies through constructor
   - Support deferred dependency resolution for circular dependencies
   - Validate dependencies during initialization

4. **Resource Management**

   - Implement VS Code Disposable pattern
   - Clean up resources in dispose() method
   - Release resources in reverse acquisition order

5. **Error Handling**
   - Categorize errors as recoverable or non-recoverable
   - Implement domain-specific error handling
   - Provide clear error messages to users
   - Implement fallback strategies for recoverable errors

#### 5.1.2 Database Interaction Pattern

Database interactions should follow this pattern:

1. **Connection Management**

   - Open connections on demand
   - Handle connection errors gracefully
   - Implement connection pooling for performance
   - Properly close connections after use

2. **Transaction Handling**

   - Use transactions for multi-step operations
   - Implement proper error handling within transactions
   - Rollback on error, commit on success
   - Handle nested transaction requests correctly

3. **Query Execution**

   - Use parameterized queries to prevent SQL injection
   - Handle query errors with appropriate context
   - Log query performance metrics for optimization
   - Implement retry logic for transient errors

4. **Result Processing**
   - Convert database results to domain objects
   - Handle missing or null values appropriately
   - Validate result integrity before returning
   - Implement pagination for large result sets

#### 5.1.3 Worker Thread Pattern

Worker threads, specifically `embeddingGeneratorWorker.ts` managed by `Tinypool`, should follow this pattern:

1.  **Task Definition (Data for `Tinypool.run()`):**

    - Input data for the worker's main function (e.g., `processEmbeddingTask`) includes:
      ```typescript
      export interface EmbeddingTaskData {
        chunkText: string;
        modelName: string;
        modelBasePath: string;
        embeddingOptions: EmbeddingOptions;
      }
      ```
    - Cancellation is primarily managed by Tinypool (e.g., via `AbortSignal` if the pool/task supports it, or by the pool terminating the worker).

2.  **Resource Initialization (within the worker):**

    - On first task execution or if the `modelName` changes, the worker initializes the Hugging Face `pipeline` for feature extraction.
      - `const extractor = await pipeline('feature-extraction', modelName, { quantized: true, modelFileName: modelPath });`
    - This pipeline (model and tokenizer) is cached in a global variable within the worker for reuse across subsequent calls _to the same worker thread_ as long as the model parameters don't change.
    - Handles initialization failures gracefully, reporting errors back to the main thread.

3.  **Processing (within the worker's main function):**

    - Iterates through `chunksToProcess`.
    - For each chunk's `content`, calls `extractor(chunk.content, { pooling: 'mean', normalize: true })`.
    - Collects the resulting `number[]` embeddings.
    - The worker itself doesn't typically report granular progress _per chunk_ back to the main thread during a single `run` call. Progress is usually inferred by the main thread as tasks complete.
    - Cancellation checks (if manually implemented beyond Tinypool's capabilities) would involve checking an `AbortSignal` if passed.

4.  **Result Formatting (Return value of worker's main function):**
    - Returns a structured result, e.g., an object like:
      ```typescript
      export interface EmbeddingTaskResult {
        embedding: number[] | null;
        error?: string;
      }
      ```
    - Includes a top-level `error` for issues like model loading failure.

#### 5.1.4 ANN Index Interaction Pattern (HNSWlib)

Interactions with the HNSWlib ANN index should follow this pattern:

1.  **Initialization (`VectorDatabaseService`):**

    - On service startup, or when the embedding model (and thus dimension) changes, initialize `HierarchicalNSW` with the correct `space` ('cosine') and `dim` (model's embedding dimension).
    - Attempt to load a persisted index file (`readIndexSync`).
    - If loading fails or no file exists, initialize a new empty index (`initIndex`).

2.  **Adding Points (`VectorDatabaseService.storeEmbeddings`):**

    - Assign a unique, sequential numerical `label` to each new embedding vector.
    - Store the mapping: `chunkId` (from SQLite `chunks` table) <-> `label` (in SQLite `embeddings` table).
    - Add the vector and its numerical `label` to the HNSW index (`annIndex.addPoint(vector, label)`).
    - Periodically check if `annIndex.getCurrentCount()` approaches `annIndex.getMaxElements()`. If so, resize the index using `annIndex.resizeIndex()` before adding more points.
    - Persist the HNSW index to disk (`writeIndexSync`) periodically after significant batches or on shutdown to save changes.

3.  **Searching (`VectorDatabaseService.findSimilarCode`):**

    - Perform a K-nearest neighbor search on the HNSW index using `annIndex.searchKnn(queryVector, K)`. This returns numerical labels and distances.
    - Convert distances to similarity scores (e.g., `1 - distance` for cosine).
    - Use the returned numerical labels to query the SQLite `embeddings` table to retrieve the corresponding `chunkId`s.
    - Join with `chunks` and `files` tables using `chunkId` to get the actual code content and file paths.

4.  **Deleting Points (`VectorDatabaseService` deletion methods):**

    - When a chunk/file is deleted, retrieve its associated numerical `label`(s) from the SQLite `embeddings` table.
    - Mark these labels for deletion in the HNSW index using `annIndex.markDelete(label)`.
    - Note: HNSWlib doesn't immediately remove data; `markDelete` flags it. The index might need to be rebuilt or re-saved to reclaim space if many deletions occur (library dependent).
    - Delete corresponding metadata from SQLite tables.

5.  **Persistence (`VectorDatabaseService`):**
    - Save the HNSW index to a file (`writeIndexSync`) on dispose and periodically after modifications.
    - Load the index from the file (`readIndexSync`) on initialization. Handle file-not-found or corrupted-index scenarios by creating a new index.

### 5.2 Error Handling Strategy

#### 5.2.1 Error Categories

Errors should be categorized as:

1. **Initialization Errors**

   - Occur during service or component initialization
   - Usually non-recoverable without user intervention
   - Should provide clear guidance on resolution
   - May require extension restart

2. **Operational Errors**

   - Occur during normal operation
   - May be recoverable with fallback strategies
   - Should be logged with appropriate context
   - Should provide clear user feedback

3. **Resource Errors**

   - Occur due to resource constraints
   - May be recoverable by releasing or reallocating resources
   - Should include resource utilization metrics
   - Should suggest mitigation strategies

4. **User Input Errors**
   - Occur due to invalid user input
   - Should provide clear guidance on correct input
   - Should preserve user intent where possible
   - Should not require extension restart

#### 5.2.2 Error Handling Approaches

1. **Try-Catch Pattern**

   - Use try-catch blocks around operation boundaries
   - Catch specific error types for targeted handling
   - Provide context in error messages
   - Log detailed error information for debugging

2. **Error Propagation**

   - Propagate errors up to appropriate handling level
   - Enrich errors with context as they propagate
   - Ensure errors include stack traces
   - Preserve original error cause

3. **Fallback Strategies**

   - Implement service-specific fallback strategies
   - Degrade functionality gracefully when possible
   - Provide clear indication of fallback activation
   - Log fallback activation for monitoring

4. **Error Reporting**
   - Report errors to users with appropriate detail
   - Avoid technical jargon in user-facing messages
   - Provide actionable guidance for resolution
   - Include error codes for reference

### 5.3 Performance Optimization Guidelines

#### 5.3.1 Resource Management

1.  **Memory Management**
    - Release large objects (e.g., diff strings, context strings, parsed trees) when no longer needed.
    - Be mindful of the in-memory ANN index (e.g., HNSWlib) size if used. Implement strategies to reload it if memory pressure is high or provide user options for memory limits.
    - Use streaming approaches if processing extremely large files or contexts, where possible.
    - Monitor extension host memory usage.
2.  **CPU Utilization**
    - Offload embedding generation and potentially complex diff analysis to worker threads (`IndexingService`).
    - LSP queries are handled by the language server process, typically separate.
    - Ensure ANN search (e.g., HNSWlib) is efficient; it's CPU-intensive but typically fast for reasonable index sizes.
    - Support cancellation of long-running operations (analysis, context retrieval).
3.  **I/O Operations**
    - Minimize synchronous file reads/writes. Use `vscode.workspace.fs` for asynchronous operations.
    - Batch database writes (`VectorDatabaseService` transactions).
    - Loading the ANN index from disk (if applicable) should be done efficiently.
    - LSP queries involve inter-process communication; ensure they don't excessively block.

#### 5.3.2 Optimization Techniques

1. **Caching Strategy**

   - Implement multi-level caching (memory, disk)
   - Use appropriate cache invalidation strategies
   - Monitor cache hit/miss rates
   - Tune cache sizes based on resource availability

2. **Lazy Initialization**

   - Initialize resources only when needed
   - Implement on-demand loading of large resources
   - Release resources when not in active use
   - Support reinitialization after resource release

3. **Incremental Processing**

   - Process large datasets in smaller increments
   - Report progress during incremental processing
   - Support cancellation between increments
   - Implement priority-based processing order

4. **Background Processing**
   - Move non-critical operations to background
   - Implement priority queuing for background tasks
   - Throttle background operations based on system load
   - Pause background operations during user interaction

## 6. Extension Points

### 6.1 Analysis Mode Extension

The system supports custom analysis modes through the following extension points:

#### 6.1.1 Analysis Mode Definition

- Create a new entry in the AnalysisMode enum
- Define a system prompt template for the mode
- Implement mode-specific token allocation strategy
- Register the mode with the analysis provider

#### 6.1.2 Mode Selection Integration

- Add the mode to the mode selection UI
- Provide clear description of the mode
- Implement mode-specific options if needed
- Update mode selection handler

### 6.2 Embedding Model Extension

The system supports custom embedding models through the following extension points:

#### 6.2.1 Embedding Model Definition

- Define the model information in the EmbeddingModel enum
- Specify model resources and requirements
- Implement model-specific initialization
- Configure chunking parameters for the model

#### 6.2.2 Model Selection Integration

- Add the model to the model selection UI
- Update the EmbeddingModelSelectionService
- Implement model-specific token counting
- Configure fallback strategy for the model

### 6.3 UI Extension

The system supports UI customization through the following extension points:

#### 6.3.1 Result View Customization

- Define custom view for analysis results
- Implement custom HTML generation
- Register view with the UI manager
- Update view selection handler

#### 6.3.2 Status Bar Customization

- Define custom status display format
- Implement custom status message generation
- Register with the status bar service
- Update status reporting across services

### 6.4 Integration Extension

The system supports external integrations through the following extension points:

#### 6.4.1 GitHub Integration

- Define GitHub API integration points
- Implement authentication and authorization
- Register with the PR analysis coordinator
- Update analysis workflow to support GitHub

#### 6.4.2 CI/CD Integration

- Define CI/CD pipeline integration points
- Implement command-line interface
- Register with the PR analysis coordinator
- Update analysis workflow to support CI/CD

## 7. System Evolution

### 7.1 Version Compatibility

#### 7.1.1 VS Code API Compatibility

- Document required VS Code API version
- Implement version detection and fallbacks
- Support graceful degradation for older versions
- Provide clear messaging for version requirements

#### 7.1.2 Model Compatibility

- Document supported model versions
- Implement version detection and fallbacks
- Support graceful degradation for older models
- Provide clear messaging for version requirements

#### 7.1.3 Database Schema Evolution

- Implement schema version tracking
- Support schema migration for upgrades
- Preserve data during migrations when possible
- Provide clear messaging during migration

### 7.2 Feature Evolution

#### 7.2.1 Language Support Evolution

- Document language support roadmap
- Implement language detection and configuration
- Support gradual language feature adoption
- Provide clear messaging for language support

#### 7.2.2 Analysis Capability Evolution

- Document analysis capability roadmap
- Implement capability detection and configuration
- Support gradual capability adoption
- Provide clear messaging for capability support

#### 7.2.3 UI Evolution

- Document UI evolution roadmap
- Implement UI configuration and customization
- Support gradual UI feature adoption
- Provide clear messaging for UI feature support

## 8. Implementation Milestones

### 8.1 Foundation Milestone

Establish the core architecture and minimal functionality:

- Basic VS Code extension setup
- Core service implementations
- Database schema and storage
- Simple Git integration
- Basic embedding generation
- Minimal UI for results

### 8.2 Core Functionality Milestone

Implement the primary features of the system:

- Complete embedding generation with structure awareness
- Full Git integration with PR selection
- Basic context provider implementation
- Initial analysis provider with Copilot integration
- Enhanced UI with tabbed views
- Status bar integration

### 8.3 Advanced Features Milestone

Add advanced capabilities and optimizations:

- Multiple analysis modes
- Enhanced context optimization
- Improved similarity search
- Background indexing
- Performance optimizations
- Error recovery improvements

### 8.4 Integration Milestone

Implement external integrations and extensibility:

- GitHub/GitLab integration
- Extension point implementation
- CI/CD integration
- Team collaboration features
- Customizable reporting
- User preference management

## 9. Quality Assurance

### 9.1 Testing Strategy

#### 9.1.1 Unit Testing

- Test each service in isolation
- Mock dependencies for controlled testing
- Test error conditions and edge cases
- Measure code coverage

#### 9.1.2 Integration Testing

- Test service interactions
- Test end-to-end workflows
- Test with realistic data volumes
- Test performance characteristics

#### 9.1.3 Performance Testing

- Measure resource utilization
- Test with large repositories
- Test with complex PRs
- Benchmark against performance targets

### 9.2 Quality Metrics

#### 9.2.1 Reliability Metrics

- Error frequency and distribution
- Recovery success rate
- Mean time between failures
- User-facing error rate

#### 9.2.2 Performance Metrics

- Indexing speed
- Analysis latency
- Memory utilization
- CPU utilization

#### 9.2.3 User Experience Metrics

- Time to first result
- User interaction responsiveness
- Command execution latency
- User satisfaction

## 10. Deployment and Lifecycle

### 10.1 Packaging and Distribution

#### 10.1.1 VS Code Extension Packaging

- Package all required components
- Include model metadata
- Configure extension manifest
- Define activation events

#### 10.1.2 Distribution Channels

- VS Code Marketplace
- GitHub releases
- Direct download
- Update notifications

### 10.2 Installation and Setup

#### 10.2.1 System Requirements

- VS Code version requirements
- Hardware requirements
- Dependency requirements
- Network requirements

#### 10.2.2 Installation Process

- Installation steps
- Post-installation configuration
- First-run experience
- Troubleshooting guidance

### 10.3 Maintenance and Support

#### 10.3.1 Update Process

- Version compatibility checks
- Update notification
- Graceful update process
- Rollback capability

#### 10.3.2 Troubleshooting

- Diagnostic commands
- Logging configuration
- Problem reporting
- Self-help resources
