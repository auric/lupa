# VS Code Chat Response Streaming UI Patterns

Research on `ChatResponseStream` API for rich UI in chat participant responses.

## Overview

The `ChatResponseStream` class (exposed as `vscode.ChatResponseStream`) enables extensions to send structured, interactive content to the chat UI during analysis. It provides real-time streaming updates and rich content display.

## All Available Methods on ChatResponseStream

### 1. `markdown(value: string | MarkdownString)`

Sends markdown content to be displayed in the chat response.

```typescript
stream.markdown('## Analysis Results\n\nFound **5 issues** in the codebase.');
stream.markdown(new vscode.MarkdownString('Code: `const x = 1;`'));
```

**DTO Kind:** `markdownContent`

---

### 2. `progress(value: string, task?: (progress) => Thenable<string | void>)`

Displays a progress message with optional async task tracking. Shows a spinner icon.

```typescript
// Simple progress message
stream.progress('Reading file X...');

// Progress with task - message updates when task completes
stream.progress('Searching for symbols...', async (progress) => {
    const result = await searchSymbols();
    // Return a completion message
    return `Found ${result.length} symbols`;
});

// Progress with nested updates
stream.progress('Analyzing codebase...', async (progress) => {
    progress.report(new vscode.ChatResponseWarningPart('Large file detected'));
    progress.report(new vscode.ChatResponseReferencePart(uri));
    await doAnalysis();
});
```

**DTO Kind:** `progressMessage` (simple) or `progressTask` (with task)

**Key difference from `markdown()`:**

- `progress()` shows a spinner icon and is designed for dynamic updates
- `progress()` can be hidden when subsequent content arrives
- `markdown()` is for static content that accumulates

---

### 3. `thinkingProgress(thinkingDelta: ThinkingDelta)`

Specialized progress for displaying "thinking" or reasoning steps.

```typescript
stream.thinkingProgress({
    message: 'Analyzing code structure...',
    id: 'analysis-step-1',
});
```

**DTO Kind:** `thinking`

Can be collapsed, collapsed with preview, or fixed-height scrolling in the UI.

---

### 4. `button(value: Command)`

Displays a clickable button that triggers a VS Code command.

```typescript
stream.button({
    command: 'workbench.action.files.openFile',
    title: 'Open File',
    arguments: [vscode.Uri.file('/path/to/file.ts')],
});

stream.button({
    command: 'myExtension.applyFix',
    title: '$(wrench) Apply Fix',
    tooltip: 'Apply the suggested fix to the file',
});
```

**DTO Kind:** `command`

Rendered with CSS class `.chat-command-button`.

---

### 5. `reference(value, iconPath?, options?)`

Displays a reference to a file, location, or variable as a distinct item (not inline).

```typescript
// File reference
stream.reference(vscode.Uri.file('/path/to/file.ts'));

// Location reference (specific line)
stream.reference(
    new vscode.Location(
        vscode.Uri.file('/path/to/file.ts'),
        new vscode.Position(10, 0)
    )
);

// Reference with icon
stream.reference(uri, new vscode.ThemeIcon('file-code'));

// Reference with status (using reference2)
stream.reference2(uri, undefined, {
    status: {
        description: 'Modified',
        kind: vscode.ChatResponseReferencePartStatusKind.Complete,
    },
});

// Variable reference
stream.reference({ variableName: 'selection', value: uri });
```

**DTO Kind:** `reference`

Typically displayed in a "References" section or as standalone clickable items.

---

### 6. `anchor(value: Uri | Location | SymbolInformation, title?: string)`

Creates **inline** interactive links within markdown text (different from `reference()`).

```typescript
// Inline file link
stream.anchor(vscode.Uri.file('/path/to/file.ts'), 'file.ts');

// Inline location link (with line number)
stream.anchor(
    new vscode.Location(uri, new vscode.Position(42, 0)),
    'handleRequest()'
);

// Symbol link
stream.anchor(symbolInfo, 'MyClass.method()');
```

**DTO Kind:** `inlineReference`

**Key difference from `reference()`:**

- `anchor()` creates inline links embedded within text
- `reference()` creates standalone reference items
- Anchors are rendered as `InlineAnchorWidget` with hover info and context menus

---

### 7. `filetree(value: ChatResponseFileTree[], baseUri: Uri)`

Renders a hierarchical file tree structure.

```typescript
const fileTree: vscode.ChatResponseFileTree[] = [
    {
        name: 'src',
        children: [
            { name: 'index.ts' },
            { name: 'utils.ts' },
            {
                name: 'components',
                children: [{ name: 'Button.tsx' }, { name: 'Dialog.tsx' }],
            },
        ],
    },
    { name: 'package.json' },
];

stream.filetree(fileTree, vscode.Uri.file('/workspace'));
```

**DTO Kind:** `treeData`

The UI allows navigation between file trees using "Next/Previous File Tree" actions.

---

### 8. `warning(value: string | MarkdownString)`

Displays a warning message with warning icon and distinctive styling.

```typescript
stream.warning('This file has been modified since the analysis started.');
stream.warning(
    new vscode.MarkdownString('**Warning:** Large file may impact performance.')
);
```

**DTO Kind:** `warning`

Rendered with `Codicon.warning` icon and `--vscode-notificationsWarningIcon-foreground` color.

---

### 9. `confirmation(title, message, data, buttons?)`

Shows an inline confirmation dialog with custom buttons. **Proposed API.**

```typescript
stream.confirmation(
    'Apply Changes?',
    'This will modify 3 files. Are you sure?',
    { files: ['a.ts', 'b.ts', 'c.ts'] },
    ['Apply All', 'Review First', 'Cancel']
);
```

**DTO Kind:** `confirmation`

When user clicks a button:

- Fires `onDidClick` event
- Calls `chatService.sendRequest()` with `acceptedConfirmationData` or `rejectedConfirmationData`

---

### 10. `textEdit(target: Uri, edits: TextEdit | TextEdit[] | true)`

Streams proposed code changes with "Apply" functionality. **Proposed API.**

```typescript
// Stream text edits
stream.textEdit(vscode.Uri.file('/path/to/file.ts'), [
    vscode.TextEdit.replace(
        new vscode.Range(10, 0, 15, 0),
        'const newCode = "replaced";'
    ),
]);

// Signal edits are complete
stream.textEdit(uri, true);
```

**DTO Kind:** `textEdit`

Displays as a diff editor with "Apply Edits" action.

---

### 11. `notebookEdit(target: Uri, edits: NotebookEdit | NotebookEdit[] | true)`

Similar to `textEdit()` but for Jupyter notebooks.

```typescript
stream.notebookEdit(notebookUri, notebookEdits);
```

**DTO Kind:** `notebookEdit`

---

### 12. `codeCitation(value: Uri, license: string, snippet: string)`

Displays a code citation with source, license, and code snippet.

```typescript
stream.codeCitation(
    vscode.Uri.parse('https://github.com/example/repo'),
    'MIT',
    'function example() { return 42; }'
);
```

**DTO Kind:** `codeCitation`

---

### 13. `markdownWithVulnerabilities(value, vulnerabilities: ChatVulnerability[])`

Markdown with highlighted security vulnerabilities.

```typescript
stream.markdownWithVulnerabilities('Here is the code:', [
    {
        title: 'SQL Injection',
        description: 'Potential SQL injection vulnerability',
    },
]);
```

**DTO Kind:** `markdownVuln`

---

### 14. `prepareToolInvocation(toolName: string)`

Indicates a tool invocation is being prepared.

```typescript
stream.prepareToolInvocation('readFile');
```

**DTO Kind:** `prepareToolInvocation`

---

### 15. `clearToPreviousToolInvocation(reason)`

Clears chat response content up to the previous tool invocation.

```typescript
stream.clearToPreviousToolInvocation(
    ChatResponseClearToPreviousToolInvocationReason.Error
);
```

---

### 16. `externalEdit(target: Uri | Uri[], callback: () => Thenable<unknown>)`

Tracks edits made by external tools within a callback.

```typescript
stream.externalEdit([uri1, uri2], async () => {
    await externalTool.modifyFiles();
});
```

---

### 17. `push(part: ExtendedChatResponsePart)`

Generic method to push any `ChatResponsePart` to the stream.

```typescript
stream.push(new vscode.ChatResponseMarkdownPart('Custom content'));
```

---

## Rich Progress Visualization Patterns

### Pattern 1: Sequential Progress Steps

```typescript
async function analyzeWithProgress(stream: vscode.ChatResponseStream) {
    stream.progress('Reading workspace files...');
    const files = await readFiles();

    stream.progress('Analyzing code structure...');
    const structure = await analyzeStructure(files);

    stream.progress('Finding issues...');
    const issues = await findIssues(structure);

    stream.markdown(`Found **${issues.length}** issues.`);
}
```

### Pattern 2: Progress with Task Completion

```typescript
stream.progress('Searching for symbol definitions...', async () => {
    const symbols = await findSymbols('MyClass');
    return `Found ${symbols.length} definitions`; // Updates progress message
});
```

### Pattern 3: Progress with Nested References

```typescript
stream.progress('Analyzing dependencies...', async (progress) => {
    for (const file of files) {
        progress.report(
            new vscode.ChatResponseReferencePart(
                vscode.Uri.file(file.path),
                new vscode.ThemeIcon('file')
            )
        );
    }
    await analyzeDependencies();
    return 'Analysis complete';
});
```

---

## Inline Code References Pattern

### Using anchor() for inline file links

```typescript
// In markdown with inline file references
const loc = new vscode.Location(uri, new vscode.Position(42, 0));
stream.anchor(loc, 'processRequest()');
stream.markdown(' handles the incoming request.');

// Creates: [processRequest()] handles the incoming request.
// Where [processRequest()] is a clickable link to line 42
```

### Using reference() for source citations

```typescript
stream.markdown('## Source Files\n');
stream.reference(
    vscode.Uri.file('/src/handler.ts'),
    new vscode.ThemeIcon('file-code')
);
stream.reference(
    vscode.Uri.file('/src/utils.ts'),
    new vscode.ThemeIcon('file-code')
);
```

---

## Command Buttons Pattern

```typescript
// Action button
stream.button({
    command: 'myExtension.applyFix',
    title: '$(tools) Apply Fix',
    arguments: [{ fixId: 'fix-123' }],
});

// Navigation button
stream.button({
    command: 'vscode.open',
    title: '$(file) Open File',
    arguments: [vscode.Uri.file('/path/to/file.ts')],
});

// Refresh button
stream.button({
    command: 'myExtension.reanalyze',
    title: '$(refresh) Re-analyze',
});
```

---

## Collapsible Sections

Collapsible content is handled by:

- `ChatCollapsibleListContentPart` - for lists
- `ChatCollapsibleInputOutputContentPart` - for I/O display
- `ChatThinkingContentPart` - for thinking/reasoning (collapsible by default)

CSS classes:

- `.chat-used-context.chat-used-context-collapsed`
- `.chat-used-context-list.chat-thinking-collapsible`

The `thinkingProgress()` method creates collapsible thinking sections automatically.

---

## Updating Previous Content

### Can content be updated after streaming?

**Yes, but limited:**

1. **Progress messages with tasks** - When the task completes, the message updates:

    ```typescript
    stream.progress('Working...', async () => {
        await doWork();
        return 'Work complete!'; // Updates the original "Working..." message
    });
    ```

2. **Thinking progress** - Consecutive thinking parts are merged and updated in place.

3. **`clearToPreviousToolInvocation()`** - Can clear content back to a specific point.

4. **`textEdit()` with `true`** - Signals completion of edit streaming.

**What cannot be updated:**

- Regular markdown content accumulates, doesn't update
- References and anchors are immutable once pushed
- Buttons and file trees are static once rendered

---

## Complete Example: Rich Analysis Response

```typescript
async function provideAnalysisResponse(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
) {
    // Show initial progress
    stream.progress('Starting analysis...');

    // Header with markdown
    stream.markdown('# Code Analysis Results\n\n');

    // Progress with file references
    stream.progress('Reading source files...', async (progress) => {
        for (const file of sourceFiles) {
            progress.report(
                new vscode.ChatResponseReferencePart(
                    vscode.Uri.file(file),
                    new vscode.ThemeIcon('file-code')
                )
            );
        }
        return `Read ${sourceFiles.length} files`;
    });

    // Show file tree of analyzed files
    stream.markdown('## Analyzed Structure\n');
    stream.filetree(buildFileTree(sourceFiles), workspaceRoot);

    // Analysis findings with inline anchors
    stream.markdown('\n## Findings\n\n');
    stream.markdown('Found an issue in ');
    stream.anchor(
        new vscode.Location(issueUri, new vscode.Position(42, 0)),
        'processData()'
    );
    stream.markdown(':\n\n');

    // Warning for important issues
    stream.warning('This function has potential memory leak.');

    // Proposed fix with text edit
    stream.markdown('\n## Suggested Fix\n\n');
    stream.textEdit(issueUri, [vscode.TextEdit.replace(issueRange, fixedCode)]);

    // Action buttons
    stream.button({
        command: 'myExtension.applyFix',
        title: '$(check) Apply Fix',
    });

    stream.button({
        command: 'myExtension.showDetails',
        title: '$(info) More Details',
    });

    // Confirmation for destructive actions
    stream.confirmation(
        'Apply changes?',
        'This will modify the source file.',
        { action: 'apply', fileUri: issueUri.toString() },
        ['Apply', 'Cancel']
    );
}
```

---

## Summary: Method Quick Reference

| Method               | Purpose              | DTO Kind                         | Updates?              |
| -------------------- | -------------------- | -------------------------------- | --------------------- |
| `markdown()`         | Static text content  | `markdownContent`                | No (accumulates)      |
| `progress()`         | Spinner with status  | `progressMessage`/`progressTask` | Yes (task completion) |
| `thinkingProgress()` | Collapsible thinking | `thinking`                       | Yes (merge)           |
| `button()`           | Command trigger      | `command`                        | No                    |
| `reference()`        | Standalone file ref  | `reference`                      | No                    |
| `anchor()`           | Inline file link     | `inlineReference`                | No                    |
| `filetree()`         | Directory tree       | `treeData`                       | No                    |
| `warning()`          | Warning message      | `warning`                        | No                    |
| `confirmation()`     | User prompt          | `confirmation`                   | No                    |
| `textEdit()`         | Code changes         | `textEdit`                       | Signals complete      |
| `codeCitation()`     | Code attribution     | `codeCitation`                   | No                    |

---

## API Status Notes

Several methods are part of **proposed APIs**:

- `confirmation()` - `chatParticipantAdditions`
- `textEdit()` - `chatParticipantAdditions`
- `warning()` - `chatParticipantAdditions`
- `codeCitation()` - `chatParticipantAdditions`

To use proposed APIs, extensions must:

1. Declare `enabledApiProposals` in `package.json`
2. Include the appropriate `.d.ts` proposal files

---

## Architecture Notes

1. **Extension Host → Main Thread**: `ChatResponseStream` runs in extension host, converts parts to DTOs, sends via RPC (`$handleProgressChunk`)

2. **Batching**: Uses `queueMicrotask` to batch multiple updates efficiently

3. **Rendering**: `ChatListRenderer` handles all content types, creating appropriate content parts:
    - `ChatMarkdownContentPart`
    - `ChatProgressContentPart`
    - `ChatTreeContentPart`
    - `ChatConfirmationContentPart`
    - `ChatTextEditContentPart`
    - etc.
