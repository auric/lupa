# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CodeLens PR Analyzer** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It leverages both Language Server Protocol (LSP) queries and semantic similarity search via embeddings to provide intelligent context for PR analysis.

## Key Technologies

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build Tool**: Vite
- **Testing**: Vitest
- **Embedding Models**: Hugging Face Transformers (@huggingface/transformers)
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

# Prepare embedding models (downloads model files)
npm run prepare-models
```

## Architecture Overview

The extension follows a layered, service-oriented architecture with clear separation of concerns:

### Core Coordinator
- **`PRAnalysisCoordinator`** (`src/services/prAnalysisCoordinator.ts`) - Central orchestration component that initializes services, manages commands, and coordinates the analysis workflow

### Indexing System
- **`IndexingService`** (`src/services/indexingService.ts`) - Orchestrates file chunking and embedding generation using async generators
- **`IndexingManager`** (`src/services/indexingManager.ts`) - Manages continuous and full re-indexing workflows
- **`CodeChunkingService`** (`src/services/codeChunkingService.ts`) - Structure-aware code chunking using Tree-sitter
- **`EmbeddingGenerationService`** (`src/services/embeddingGenerationService.ts`) - Manages worker pool for parallel embedding generation
- **Worker**: `embeddingGeneratorWorker.ts` - Generates embeddings in separate processes using Hugging Face models

### Context Retrieval (Hybrid LSP + Embedding)
- **`ContextProvider`** (`src/services/contextProvider.ts`) - Combines LSP queries with semantic similarity search
  - Uses VS Code LSP for precise structural information (definitions, references)
  - Uses embedding-based search for semantic similarity via HNSWlib ANN index
- **`EmbeddingDatabaseAdapter`** (`src/services/embeddingDatabaseAdapter.ts`) - Bridges indexing and storage systems
- **`VectorDatabaseService`** (`src/services/vectorDatabaseService.ts`) - Manages SQLite metadata and HNSWlib vector index

### Analysis System
- **`AnalysisProvider`** (`src/services/analysisProvider.ts`) - Manages code analysis using Copilot models
- **`CopilotModelManager`** (`src/models/copilotModelManager.ts`) - Interfaces with VS Code's Language Model API
- **`TokenManagerService`** (`src/services/tokenManagerService.ts`) - Optimizes context to fit token limits

### Git Integration
- **`GitService`** (`src/services/gitService.ts`) - Interfaces with Git via VS Code's Git extension
- **`GitOperationsManager`** (`src/services/gitOperationsManager.ts`) - Manages Git operations and diff preparation

### UI and Status
- **`UIManager`** (`src/services/uiManager.ts`) - Creates webviews and handles user interactions
- **`StatusBarService`** (`src/services/statusBarService.ts`) - Manages VS Code status bar updates

## Data Flow

1. **Indexing**: Files are processed by `IndexingService` which uses `CodeChunkingService` for structure-aware chunking, then `EmbeddingGenerationService` generates embeddings in parallel using worker threads
2. **Storage**: Embeddings and metadata are stored via `VectorDatabaseService` (SQLite + HNSWlib)
3. **Analysis**: When analyzing PRs, `ContextProvider` combines LSP queries and embedding search to find relevant context
4. **Optimization**: `TokenManagerService` optimizes context to fit model token limits
5. **Generation**: `AnalysisProvider` sends the optimized prompt to Copilot models via `CopilotModelManager`

## Key File Locations

### Services
- `src/services/` - All service implementations
- `src/services/prAnalysisCoordinator.ts` - Main coordinator (entry point)

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
- Supports both Jina and MiniLM embedding models
- Model selection affects vector database configuration

## Extension Commands

The extension provides these VS Code commands:
- `codelens-pr-analyzer.analyzePR` - Analyze Pull Request
- `codelens-pr-analyzer.manageIndexing` - Manage indexing operations
- `codelens-pr-analyzer.selectEmbeddingModel` - Select embedding model
- `codelens-pr-analyzer.startContinuousIndexing` - Start background indexing
- `codelens-pr-analyzer.stopContinuousIndexing` - Stop background indexing

## Debugging

- Extension logs to VS Code Developer Console
- Use VS Code's extension host debugging for breakpoints
- Status bar shows real-time operation status
- Test with `F5` to launch extension development host