import * as vscode from 'vscode';
import { AnalysisOrchestrator } from './analysisOrchestrator';
import { EmbeddingModelCoordinator } from './embeddingModelCoordinator';
import { CopilotModelCoordinator } from './copilotModelCoordinator';
import { DatabaseOrchestrator } from './databaseOrchestrator';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * CommandRegistry handles all VS Code command registration
 * Centralizes command management and reduces coordinator complexity
 */
export class CommandRegistry implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry,
        private readonly analysisOrchestrator: AnalysisOrchestrator,
        private readonly embeddingModelCoordinator: EmbeddingModelCoordinator,
        private readonly copilotModelCoordinator: CopilotModelCoordinator,
        private readonly databaseOrchestrator: DatabaseOrchestrator
    ) { }

    /**
     * Register all extension commands
     */
    public registerAllCommands(): void {
        // Core analysis commands
        this.registerCommand('codelens-pr-analyzer.analyzePR', () =>
            this.analysisOrchestrator.analyzePR()
        );

        // Embedding model commands
        this.registerCommand('codelens-pr-analyzer.selectEmbeddingModel', () =>
            this.embeddingModelCoordinator.showEmbeddingModelSelectionOptions()
        );

        this.registerCommand('codelens-pr-analyzer.showEmbeddingModelsInfo', () =>
            this.embeddingModelCoordinator.showEmbeddingModelsInfo()
        );

        // Copilot language model commands
        this.registerCommand('codelens-pr-analyzer.showLanguageModelsInfo', () =>
            this.copilotModelCoordinator.showCopilotModelsInfo()
        );

        this.registerCommand('codelens-pr-analyzer.selectLanguageModel', () =>
            this.copilotModelCoordinator.showCopilotModelSelectionOptions()
        );

        // Database management commands
        this.registerCommand('codelens-pr-analyzer.manageDatabase', () =>
            this.databaseOrchestrator.showDatabaseManagementOptions()
        );

        // Indexing commands
        this.registerCommand('codelens-pr-analyzer.startContinuousIndexing', () =>
            this.services.indexingManager.startContinuousIndexing()
        );

        this.registerCommand('codelens-pr-analyzer.stopContinuousIndexing', () =>
            this.services.indexingManager.stopContinuousIndexing()
        );

        this.registerCommand('codelens-pr-analyzer.manageIndexing', () =>
            this.services.indexingService.showIndexingManagementOptions()
        );

        // Test webview command for development
        this.registerCommand('codelens-pr-analyzer.testWebview', () =>
            this.showTestWebview()
        );
    }

    /**
     * Show test webview with sample data for development
     */
    private showTestWebview(): void {
        const title = "Test PR Analysis - Sample Data";

        // Sample diff text
        const diffText = `diff --git a/src/services/analysisProvider.ts b/src/services/analysisProvider.ts
index 1234567..abcdefg 100644
--- a/src/services/analysisProvider.ts
+++ b/src/services/analysisProvider.ts
@@ -45,6 +45,10 @@ export class AnalysisProvider {
         const hybridContextResult = await this.contextProvider.getContextForDiff(
             diffText,
             gitRootPath,
+            undefined, // options
+            mode,
+            undefined, // systemPrompt
+            progressCallback,
             token
         );

@@ -78,7 +82,7 @@ export class AnalysisProvider {
         try {
             const model = await this.modelManager.getCurrentModel();
-            const systemPrompt = this.getSystemPromptForMode(mode);
+            const systemPrompt = this.tokenManager.getSystemPromptForMode(mode);

             const tokenComponents = {
                 systemPrompt,`;

        // Sample context with all types of data
        const context = `## Definitions Found (LSP)

**Definition in \`src/services/analysisProvider.ts\` (L23):**
\`\`\`typescript
    1: import * as vscode from 'vscode';
    2: import { ContextProvider } from './contextProvider';
    3: import { TokenManagerService } from './tokenManagerService';
    4: import { CopilotModelManager } from '../models/copilotModelManager';
    5: import { AnalysisMode } from '../types/modelTypes';
    6: import type {
    7:     ContextSnippet,
    8:     DiffHunk,
    9:     HybridContextResult
   10: } from '../types/contextTypes';
   11: import { Log } from './loggingService';
   12:
   13: /**
   14:  * AnalysisProvider handles the core analysis logic using language models
   15:  */
   16: export class AnalysisProvider implements vscode.Disposable {
   17:     private tokenManager: TokenManagerService;
   18:     /**
   19:      * Create a new AnalysisProvider
   20:      * @param contextProvider Provider for relevant code context
   21:      * @param modelManager Manager for language models
   22:      */
   23:     constructor(
   24:         private readonly contextProvider: ContextProvider,
   25:         private readonly modelManager: CopilotModelManager
   26:     ) {
   27:         this.tokenManager = new TokenManagerService(this.modelManager);
   28:     }
\`\`\`

**Definition in \`src/services/tokenManagerService.ts\` (L40):**
\`\`\`typescript
   35: /**
   36:  * Service for managing token calculations and optimizations
   37:  * Follows Single Responsibility Principle by focusing only on token management
   38:  */
   39: export class TokenManagerService {
   40:     // Standard overhead for different token components
   41:     private static readonly TOKEN_OVERHEAD_PER_MESSAGE = 5;
   42:     private static readonly FORMATTING_OVERHEAD = 50;
   43:     private static readonly SAFETY_MARGIN_RATIO = 0.95;
   44:     private static readonly TRUNCATION_MESSAGE = '\\n\\n[Context truncated to fit token limit. Some information might be missing.]';
   45:     private static readonly PARTIAL_TRUNCATION_MESSAGE = '\\n\\n[File content partially truncated to fit token limit]';
   46:
   47:     private currentModel: vscode.LanguageModelChat | null = null;
   48:     private modelDetails: { family: string; maxInputTokens: number } | null = null;
   49:
   50:     constructor(private readonly modelManager: CopilotModelManager) { }
\`\`\`

## References Found (LSP)

**Reference in \`src/services/contextProvider.ts\` (L156):**
\`\`\`typescript
  150:     async getContextForDiff(
  151:         diff: string,
  152:         gitRootPath: string,
  153:         options?: SimilaritySearchOptions,
  154:         analysisMode: AnalysisMode = AnalysisMode.Comprehensive,
  155:         _systemPrompt?: string,
  156:         progressCallback?: (processed: number, total: number) => void,
  157:         token?: vscode.CancellationToken
  158:     ): Promise<HybridContextResult> {
  159:         Log.info(\`Finding relevant context for PR diff (mode: \${analysisMode})\`);
  160:         const allContextSnippets: ContextSnippet[] = [];
  161:         const parsedDiffFileHunks = this.parseDiff(diff);
\`\`\`

**Reference in \`src/coordinators/analysisOrchestrator.ts\` (L89):**
\`\`\`typescript
   85:         try {
   86:             const result = await this.services.analysisProvider.analyzePullRequest(
   87:                 diffText,
   88:                 gitRootPath,
   89:                 selectedMode,
   90:                 (message, increment) => {
   91:                     progress.report({ message, increment });
   92:                 },
   93:                 token
   94:             );
   95:
   96:             return result;
   97:         } catch (error) {
   98:             if (error instanceof Error && error.message.includes('Operation cancelled')) {
   99:                 throw error;
  100:             }
  101:             throw new Error(\`Analysis failed: \${error instanceof Error ? error.message : String(error)}\`);
  102:         }
\`\`\`

## Semantically Similar Code (Embeddings)

### File: \`src/services/analysisProvider.ts\` (Relevance: 87.3%)
\`\`\`typescript
/**
 * Analyze PR using language models, now taking ContextSnippet[]
 */
private async analyzeWithLanguageModel(
    diffText: string,
    parsedDiff: DiffHunk[],
    allContextSnippets: ContextSnippet[],
    mode: AnalysisMode,
    token?: vscode.CancellationToken
): Promise<{ analysis: string; optimizedContext: string }> {
    try {
        const model = await this.modelManager.getCurrentModel();
        const systemPrompt = this.tokenManager.getSystemPromptForMode(mode);

        const preliminaryContextStringForAllSnippets = this.tokenManager.formatContextSnippetsToString(allContextSnippets, false);

        const tokenComponents = {
            systemPrompt,
            diffStructureTokens: calculatedDiffStructureTokens,
            context: preliminaryContextStringForAllSnippets,
        };

        const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

        const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
            allContextSnippets,
            allocation.contextAllocationTokens
        );

        const finalOptimizedContextStringForReturn = this.tokenManager.formatContextSnippetsForDisplay(optimizedSnippets, wasTruncated);

        return { analysis: responseText, optimizedContext: finalOptimizedContextStringForReturn };
    } catch (error) {
        throw new Error(\`Language model analysis failed: \${error instanceof Error ? error.message : String(error)}\`);
    }
}
\`\`\`

### File: \`src/services/tokenManagerService.ts\` (Relevance: 82.1%)
\`\`\`typescript
/**
 * Calculate token allocation for all components with a specific model
 */
public async calculateTokenAllocation(
    components: TokenComponents,
    analysisMode: AnalysisMode
): Promise<TokenAllocation> {
    await this.updateModelInfo();

    const maxInputTokens = this.modelDetails?.maxInputTokens || 8000;
    const safeMaxTokens = Math.floor(maxInputTokens * TokenManagerService.SAFETY_MARGIN_RATIO);

    const systemPromptTokens = components.systemPrompt
        ? await this.currentModel!.countTokens(components.systemPrompt) : 0;
    const diffTokens = components.diffStructureTokens !== undefined
        ? components.diffStructureTokens
        : (components.diffText ? await this.currentModel!.countTokens(components.diffText) : 0);

    const contextTokens = components.context
        ? await this.currentModel!.countTokens(components.context) : 0;

    const totalRequiredTokens = systemPromptTokens + diffTokens + contextTokens;
    const contextAllocation = Math.max(0, safeMaxTokens - (systemPromptTokens + diffTokens));

    return {
        totalAvailableTokens: safeMaxTokens,
        totalRequiredTokens,
        systemPromptTokens,
        diffTextTokens: diffTokens,
        contextTokens,
        fitsWithinLimit: totalRequiredTokens <= safeMaxTokens,
        contextAllocationTokens: contextAllocation
    };
}
\`\`\`

### File: \`src/types/contextTypes.ts\` (Relevance: 76.9%)
\`\`\`typescript
/**
 * Represents a snippet of code context for analysis
 */
export interface ContextSnippet {
    id: string;
    type: 'lsp-definition' | 'lsp-reference' | 'embedding';
    content: string;
    relevanceScore: number;
    filePath?: string;
    startLine?: number;
    associatedHunkIdentifiers?: string[];
}

/**
 * Result of hybrid context retrieval (LSP + embeddings)
 */
export interface HybridContextResult {
    snippets: ContextSnippet[];
    parsedDiff: DiffHunk[];
}

/**
 * Represents a file diff with hunks
 */
export interface DiffHunk {
    filePath: string;
    hunks: DiffHunkLine[];
}

/**
 * Represents a hunk within a diff
 */
export interface DiffHunkLine {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
    hunkId?: string;
}
\`\`\``;

        // Sample analysis text
        const analysis = `# PR Analysis Results

## 🔍 Overview
This pull request introduces improvements to the token management system by refactoring the system prompt handling from \`AnalysisProvider\` to \`TokenManagerService\`. This change improves separation of concerns and follows the Single Responsibility Principle.

## ✅ Positive Changes

### 1. **Improved Code Organization**
- **System prompt handling moved to TokenManagerService**: The \`getSystemPromptForMode\` method has been appropriately relocated from \`AnalysisProvider\` to \`TokenManagerService\`, where it logically belongs alongside other token-related functionality.

### 2. **Better Parameter Handling**
- **Enhanced method signature**: The \`getContextForDiff\` method now includes explicit parameters for \`options\`, \`mode\`, \`systemPrompt\`, and \`progressCallback\`, making the API more explicit and easier to understand.

### 3. **Single Responsibility Principle**
- **Clear separation of concerns**: \`AnalysisProvider\` now focuses on orchestrating the analysis workflow, while \`TokenManagerService\` handles all token-related operations including system prompts.

## 🔧 Technical Implementation

### Code Changes Analysis

\`\`\`typescript
// Before: AnalysisProvider handling system prompts
const systemPrompt = this.getSystemPromptForMode(mode);

// After: TokenManagerService handling system prompts
const systemPrompt = this.tokenManager.getSystemPromptForMode(mode);
\`\`\`

This change demonstrates:
- **Delegation pattern**: \`AnalysisProvider\` now delegates system prompt generation to the appropriate service
- **Method relocation**: \`getSystemPromptForMode\` has been moved to its logical home in \`TokenManagerService\`

### Parameter Enhancement

\`\`\`typescript
// Enhanced method signature with explicit parameters
const hybridContextResult = await this.contextProvider.getContextForDiff(
    diffText,
    gitRootPath,
    undefined, // options
    mode,
    undefined, // systemPrompt
    progressCallback,
    token
);
\`\`\`

## 📊 Impact Assessment

### **Positive Impact**
- ✅ **Maintainability**: Better code organization makes the codebase easier to maintain
- ✅ **Testability**: Clear separation of concerns improves unit testing capabilities
- ✅ **Readability**: Explicit parameter passing makes the code more self-documenting

### **Risk Assessment**
- ⚠️ **Low Risk**: This is a straightforward refactoring with minimal risk
- ⚠️ **Backward Compatibility**: Ensure all callers are updated to use the new method location

## 🎯 Recommendations

1. **Update Tests**: Verify that unit tests for \`AnalysisProvider\` and \`TokenManagerService\` are updated to reflect the new method location.

2. **Documentation**: Update any inline documentation or API docs that reference the old method location.

3. **Code Review**: Ensure all references to the old method have been updated throughout the codebase.

## 📋 Summary

This PR successfully improves the codebase architecture by:
- Moving system prompt handling to the appropriate service
- Enhancing method signatures with explicit parameters
- Following better separation of concerns principles

The changes are well-structured, maintain backward compatibility, and improve overall code quality. **Recommended for approval** with the suggestion to verify test coverage.`;

        // Display the test webview
        this.services.uiManager.displayAnalysisResults(title, diffText, context, analysis);
    }

    /**
     * Helper method to register a command and track disposables
     */
    private registerCommand(command: string, callback: (...args: any[]) => any): void {
        const disposable = vscode.commands.registerCommand(command, callback);
        this.disposables.push(disposable);
        this.context.subscriptions.push(disposable);
    }

    /**
     * Dispose of all registered commands
     */
    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}