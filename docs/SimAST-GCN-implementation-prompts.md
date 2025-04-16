## Implementation Prompts (Step-by-Step)

### Prompt 1: Create AST Simplification Service

```
Create a new AST simplifier service that implements the SimAST-GCN Algorithm 1 for simplifying ASTs. Your implementation should:

1. Create a new file `src/services/astSimplifier.ts`
2. Define an `ASTSimplifier` class with methods to simplify Tree-sitter ASTs
3. Implement the core algorithm from the SimAST-GCN paper which:
   - Takes a Tree-sitter AST as input
   - Identifies attribute nodes that don't contain connection information
   - Removes redundant nodes while preserving the tree's integrity
   - Reconnects child nodes to their grandparents when parents are removed
4. Create language-specific filters for all supported languages to identify:
   - Which nodes to keep (containing Declaration or Statement)
   - Which nodes are redundant and can be removed
5. Support all languages from the SUPPORTED_LANGUAGES configuration
6. Include a method to traverse and analyze the simplified AST
7. Return the simplified AST with proper parent-child relationships
8. Handle edge cases such as empty trees or unsupported languages
9. Include detailed comments explaining the simplification process

Make sure to handle language-specific considerations like TypeScript decorators, JSX elements, and C++ templates appropriately.
```

### Prompt 2: Create Graph Representation Module

```
Create a new graph representation module that converts simplified ASTs into graph structures. Your implementation should:

1. Create a new file `src/services/astGraphBuilder.ts`
2. Define an `ASTGraphBuilder` class with methods to create graph representations from simplified ASTs
3. Implement methods to:
   - Convert AST nodes to graph nodes
   - Create edges between related nodes
   - Assign appropriate weights to edges based on relationship type
   - Build an adjacency matrix representation (as described in formula 4 of the SimAST-GCN paper)
4. Define graph node and edge types in a new file `src/types/graphTypes.ts`
5. Include utility methods for:
   - Finding paths between nodes
   - Calculating node importance
   - Identifying communities or clusters of related nodes
6. Implement efficient data structures for storing and querying the graph
7. Support serialization and deserialization of graph structures for caching
8. Include methods to visualize the graph for debugging (optional)
9. Handle all supported languages with appropriate customizations

Ensure the graph representation preserves the structural relationships identified in the simplified AST while making them available for efficient traversal and analysis.
```

### Prompt 3: Implement Neural Network Components with TensorFlow.js

Create the neural network components for the SimAST-GCN algorithm using TensorFlow.js. Your implementation should:

1. Create a new file `src/services/astNeuralProcessor.ts`
2. Implement a `NeuralASTProcessor` class that implements the SimAST-GCN architecture:
   - Import TensorFlow.js and initialize necessary dependencies
   - Implement the Bidirectional GRU component (Equation 7)
   - Implement the Graph Convolutional Network layers (Equations 5-6) with:
     - Normalized adjacency matrix calculation (L = A / (D + 1))
     - Weight matrices for each GCN layer
     - LeakyReLU activation function
   - Implement the retrieval-based attention mechanism (Equations 8-10)
   - Implement code difference calculation (r = r^O - r^R)
   - Create a prediction function using softmax (Equation 12)
3. Add methods to:
   - Process both original and revised code through the same pipeline
   - Convert Tree-sitter nodes to appropriate tensor representations
   - Apply graph convolution operations efficiently
   - Calculate attention weights
   - Generate final code representations
4. Ensure memory efficiency by:
   - Using proper tensor disposal
   - Managing graph sizes for large codebases
   - Implementing batched processing where appropriate
5. Provide serialization and deserialization of model parameters
6. Include abstracted interfaces to support different model configurations

Follow the exact mathematical formulations in the SimAST-GCN paper and ensure that the implementation handles sparse adjacency matrices efficiently.

### Prompt 4: Create Graph Context Provider

```
Create a new graph context provider that uses the simplified AST and graph structures to provide context for PR analysis. Your implementation should:

1. Create a new file `src/services/graphContextProvider.ts`
2. Define a `GraphContextProvider` class that implements vscode.Disposable
3. Add a constructor that accepts a TreeStructureAnalyzer dependency
4. Implement a core `getContextForDiff` method that:
   - Extracts changed files and regions from a PR diff
   - Parses the code into ASTs using TreeStructureAnalyzer
   - Simplifies the ASTs using ASTSimplifier
   - Converts simplified ASTs to graphs using ASTGraphBuilder
   - Identifies relevant nodes and their connections to the changes
   - Creates a prioritized list of context based on structural relationships
   - Formats the context for the LLM
5. Add methods to:
   - Determine relevance of code structures to changes
   - Filter and rank context by importance
   - Optimize context for token limits
   - Handle multi-file contexts
6. Support all languages in SUPPORTED_LANGUAGES
7. Include caching mechanisms for parsed ASTs and graphs
8. Add proper disposal of resources in the dispose method
9. Handle edge cases such as unsupported languages or parse failures

Ensure the context provider operates efficiently even for large PRs by using incremental processing and focusing on structurally relevant code.
```

### Prompt 5: Update PRAnalysisCoordinator

```
Update the PR Analysis Coordinator to use the new graph-based context system. Your implementation should:

1. Modify `src/services/prAnalysisCoordinator.ts` to:
   - Remove dependencies on embedding-based systems
   - Add dependencies for the new GraphContextProvider
   - Update initialization code to create the graph context provider
   - Replace context generation methods to use the new provider
2. Update the `getContextForAnalysis` method to:
   - Use GraphContextProvider instead of the embedding-based context
   - Format context appropriately for the language model
   - Handle fallbacks if graph context retrieval fails
3. Remove or comment out code related to:
   - Embedding database
   - Vector similarity search
   - Indexing operations
4. Update commands and user interactions to reflect the new approach
5. Ensure backward compatibility for any external components that might depend on the old system
6. Update error handling for the new context generation approach
7. Modify any progress reporting to reflect the new workflow

Ensure the coordinator properly integrates the new graph-based context system while maintaining the same interface and user experience.
```

### Prompt 6: Implement TokenManager Integration

```
Update the TokenManager service to work with graph-based context instead of embedding-based context. Your implementation should:

1. Modify `src/services/tokenManagerService.ts` to:
   - Accept graph-based context structures
   - Optimize context selection based on structural importance
   - Maintain token limits for different models
2. Implement structure-aware token optimization that:
   - Keeps complete functions/classes where possible
   - Prioritizes context based on graph relationship strength
   - Balances between change context and related context
3. Update context formatting methods to:
   - Present context in a way that preserves structural relationships
   - Include minimal but sufficient code for each included structure
   - Format multi-file contexts appropriately
4. Add utility methods to:
   - Estimate token counts for code structures
   - Allocate token budgets across different context sources
   - Track token usage efficiently
5. Handle edge cases such as:
   - Very large functions that exceed token limits
   - Multiple related structures that collectively exceed limits
   - Critical context that must be preserved regardless of token constraints

Ensure the token manager efficiently balances between providing comprehensive context and staying within the model's token limits.
```

### Prompt 7: Create Caching System

```
Implement a caching system for the graph-based code analysis to improve performance. Your implementation should:

1. Create a new file `src/services/astCacheManager.ts`
2. Define an `ASTCacheManager` class that:
   - Caches parsed ASTs keyed by file content hash
   - Caches simplified ASTs to avoid redundant processing
   - Caches graph structures for faster context retrieval
3. Implement methods for:
   - Adding items to the cache with appropriate expiration policies
   - Retrieving items from the cache with fallbacks
   - Invalidating cache entries when files change
   - Limiting cache size based on memory constraints
4. Add metrics and diagnostics to track:
   - Cache hit/miss rates
   - Memory usage
   - Processing time savings
5. Implement intelligent cache eviction strategies that consider:
   - Frequency of access
   - Recency of access
   - Processing cost of regenerating the item
6. Ensure thread safety for cache operations
7. Add proper cleanup in the dispose method
8. Include options for users to control cache behavior

Ensure the cache system significantly improves performance for repeated analysis of the same or similar files without consuming excessive memory.
```

### Prompt 8: Add Testing Infrastructure

```
Create a testing framework for the graph-based context system. Your implementation should:

1. Create test files for each new component:
   - `src/test/astSimplifier.test.ts`
   - `src/test/astGraphBuilder.test.ts`
   - `src/test/graphContextProvider.test.ts`
2. Implement test cases for:
   - AST simplification for various languages
   - Graph construction from simplified ASTs
   - Context retrieval for different types of PRs
   - Edge cases and error handling
3. Create mock data including:
   - Sample code in different languages
   - Sample PRs with various types of changes
   - Expected context results
4. Add integration tests that verify:
   - End-to-end context generation
   - Integration with PR analysis coordinator
   - Performance metrics
5. Implement benchmarking to compare:
   - Processing speed vs. embedding-based approach
   - Memory usage
   - Context quality
6. Create utilities for visual debugging of:
   - AST simplification
   - Graph construction
   - Context selection

Ensure the tests comprehensively verify the functionality, performance, and robustness of the new graph-based context system.
```

### Prompt 9: Create Configuration and Settings

```
Implement configuration options for the graph-based context system. Your implementation should:

1. Update `package.json` to add new configuration options for:
   - Enabling/disabling graph-based context
   - Controlling AST simplification behavior
   - Setting context depth limits
   - Configuring cache behavior
2. Create or update settings handler in `src/services/workspaceSettingsService.ts` to:
   - Read and validate the new settings
   - Provide default values
   - Handle settings changes
3. Add UI components for:
   - Displaying simplification and graph statistics
   - Controlling context generation behavior
   - Visualizing the context selection process
4. Implement migration from embedding-based settings
5. Add user documentation for the new settings
6. Create command palette entries for:
   - Clearing the AST cache
   - Regenerating context for current PR
   - Showing graph statistics

Ensure users have appropriate control over the new context system while maintaining a simple default experience.
```

### Prompt 10: Clean Up Legacy Code

```
Remove or refactor the legacy embedding-based code. Your implementation should:

1. Safely remove or comment out unused files:
   - `src/services/embeddingDatabaseAdapter.ts`
   - `src/services/vectorDatabaseService.ts`
   - `src/services/indexingService.ts`
   - `src/workers/workerCodeChunker.ts` (unless parts are reused)
   - `src/workers/asyncIndexingProcessor.ts`
2. Update references and imports throughout the codebase
3. Remove embedding-related commands from `package.json`
4. Update extension activation events if needed
5. Clean up any leftover database files
6. Update documentation to remove references to embeddings
7. Add deprecation notices for any APIs that might have been used by extensions
8. Implement graceful migration for users with existing embedding databases
9. Update status bar and UI components to remove embedding-related elements

Ensure the codebase is clean and coherent after removing the legacy code while maintaining backward compatibility where necessary.
```

These prompts should provide a step-by-step guide for implementing the SimAST-GCN approach in your PR analyzer. Each step builds on the previous ones to create a complete solution.