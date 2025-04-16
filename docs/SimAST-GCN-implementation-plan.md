# Implementation Plan for SimAST-GCN Based PR Analysis

This implementation plan outlines the steps to replace the current embedding-based indexing system with a more efficient SimAST-GCN approach using Tree-sitter for improved PR analysis context generation.

## 1. Project Structure Changes

### 1.1. New Files to Create

- `src/services/graphContextProvider.ts` - Core service implementing the SimAST-GCN approach
- `src/services/astSimplifier.ts` - Service for simplifying ASTs using Algorithm 1 from the paper
- `src/types/graphTypes.ts` - Type definitions for graph-based data structures

### 1.2. Files to Modify

- prAnalysisCoordinator.ts - Update to use GraphContextProvider
- tokenManagerService.ts - Adapt for graph-based context
- extension.ts - Update service registration

### 1.3. Files to Remove/Replace

- embeddingDatabaseAdapter.ts - Remove completely
- vectorDatabaseService.ts - Remove completely
- indexingService.ts - Remove or repurpose
- workerCodeChunker.ts - Remove or repurpose
- asyncIndexingProcessor.ts - Remove

## 2. Implementation Phases

### Phase 1: Core Tree-sitter AST Infrastructure

1. **Develop AST Simplifier**
   - Implement Algorithm 1 from the SimAST-GCN paper
   - Create language-specific node filters for redundant nodes
   - Implement parent-child reconnection logic
   - Add support for multiple languages

2. **Create Graph Representation Module**
   - Implement adjacency matrix generation
   - Develop node relationship tracking
   - Create utilities for graph traversal and analysis

### Phase 2: Graph Context Provider

1. **Implement GraphContextProvider**
   - Create core service that leverages TreeStructureAnalyzer
   - Implement AST simplification workflow
   - Build graph generation from simplified ASTs
   - Create context selection algorithms based on structure relationships

2. **Implement Context Relevance Algorithms**
   - Develop direct structural relationship identification
   - Implement parent/child relationship relevance scoring
   - Create structure navigation utilities

### Phase 3: PR Analysis Integration

1. **Update PRAnalysisCoordinator**
   - Replace embedding context generation with graph-based approach
   - Update context retrieval workflow
   - Integrate with existing analysis providers

2. **Adapt Token Manager Service**
   - Update token optimization for graph-based contexts
   - Adapt token allocation strategies
   - Support efficient context pruning

### Phase 4: Testing and Optimization

1. **Develop Testing Strategies**
   - Create test cases for AST simplification
   - Add tests for graph-based context relevance
   - Test with diverse PR scenarios

2. **Optimize Performance**
   - Implement caching for simplified ASTs
   - Add incremental processing for changed files
   - Optimize memory usage

## 3. Detailed Component Implementations

### 3.1 GraphContextProvider

**Key Responsibilities:**
- Interface with TreeStructureAnalyzer to obtain ASTs
- Simplify ASTs using the AST Simplifier
- Build graph representations of code
- Find relevant context based on PR changes
- Optimize context selection for token limits

**Key Methods:**
- `initialize()` - Set up resources and caching
- `getContextForDiff(diff: string)` - Main entry point for getting PR context
- `simplifyAst(ast: any, language: string)` - Apply AST simplification
- `buildGraph(simplifiedAst: any)` - Create graph representation
- `findRelatedStructures(changedStructures: CodeStructure[])` - Find context based on structural relationships
- `formatContextForLLM(structures: CodeStructure[])` - Format for analysis

### 3.2 ASTSimplifier

**Key Responsibilities:**
- Implement Algorithm 1 from SimAST-GCN paper
- Define node filtering rules for different languages
- Handle reconnection of parent-child relationships
- Preserve AST integrity during simplification

**Key Methods:**
- `simplifyAST(root, codeContent, filterSet)` - Main simplification algorithm
- `identifyAttributeNodes(ast, language)` - Find nodes to potentially remove
- `shouldKeepNode(node, language)` - Determine if a node should be kept
- `reconnectChildren(parent, removedNode)` - Reconnect children when removing nodes

### 3.3 PRAnalysisCoordinator Updates

**Key Changes:**
- Replace embedding context generation with graph-based approach
- Update context retrieval and optimization logic
- Integrate with existing analysis providers
- Handle fallbacks if graph-based approach fails

**Key Method Updates:**
- `getContextForAnalysis(diff: string)` - Update to use GraphContextProvider
- `analyzePullRequest(diff: string, options: AnalysisOptions)` - Update context integration

### 3.4 TokenManagerService Updates

**Key Changes:**
- Update token optimization for graph-based contexts
- Adapt token allocation strategies for structural context
- Support efficient pruning of less relevant structures

**Key Method Updates:**
- `optimizeContext(context: string[], tokenBudget: number)` - Update to preserve structural integrity
- `allocateTokens(diff: string, context: string[])` - Modify allocation strategy

## 4. Migration Steps

### Step 1: Create Core Infrastructure

1. Implement AST Simplifier
2. Create Graph Representation utilities
3. Build GraphContextProvider shell with basic functionality

### Step 2: Integration Points

1. Update PRAnalysisCoordinator to support both approaches during transition
2. Create adapter methods to map between old and new interfaces
3. Update TokenManagerService for graph context format

### Step 3: Removal of Embedding System

1. Switch PRAnalysisCoordinator to use only GraphContextProvider
2. Remove embedding-related code and services
3. Clean up unused dependencies and resources

### Step 4: Refinement

1. Optimize context selection algorithms
2. Implement language-specific improvements
3. Add caching and performance optimizations

## 5. Key Technical Considerations

### 5.1 AST Simplification Rules

- **JavaScript**: Remove modifier nodes, decorators as standalone nodes
- **JavaScript with JSX**: Add special handling for JSX elements in JavaScript
- **TypeScript**: Remove modifier nodes, decorators as standalone nodes
- **TypeScript with TSX**: Add special handling for JSX elements in TypeScript
- **Python**: Remove simple attribute nodes, preserve docstrings
- **Java**: Remove annotation containers, keep annotations as attributes
- **C++**: Simplify template syntax nodes, preserve template parameters
- **CSS**: Add rules for simplifying at-rules and selectors
- **Ruby**: Add special handling for method calls without parentheses
- **Rust**: Add handling for macros and traits

### 5.2 Graph Construction

- Create direct connections between semantically related nodes
- Weight edges based on relationship type and proximity
- Support bidirectional relationships for context traversal

### 5.3 Context Selection Strategy

- Focus on structural relationships to changed code
- Prioritize containing classes/functions over distant related code
- Include complete structural elements where possible
- Use breadth-first traversal with depth limiting for context expansion

### 5.4 Caching Strategy

- Cache simplified ASTs for unchanged files
- Store relationship graphs for frequent lookups
- Track file modifications to invalidate cache entries
- Use memory-efficient representations for long-lived structures

## 6. Performance Expectations

- **AST Simplification**: Expect ~45% reduction in node count per the paper
- **Context Retrieval**: 5-10x faster than vector similarity search
- **Memory Usage**: Significantly lower than embedding-based approach
- **Initial Parse Time**: Similar to current approach, but no embedding generation
- **Incremental Updates**: Much faster for changed files

## 7. Testing Plan

1. Unit test AST simplification with various language samples
2. Test graph construction accuracy and efficiency
3. Compare context relevance against current embedding approach
4. Test end-to-end PR analysis with various repository samples
5. Measure performance metrics against baseline

## 8. Fallback Strategies

1. Implement graceful degradation for unsupported languages
2. Provide alternative context selection for very large files
3. Add timeout protections for graph traversal operations
4. Create simple text-based fallback for critical failures

This implementation plan provides a roadmap for replacing the embedding-based indexing with the SimAST-GCN approach for improved PR analysis context generation.