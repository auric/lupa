# VS Code API Patterns

When-to-use guidance and non-obvious patterns for common VS Code APIs.

## Commands

Use `registerTextEditorCommand` when you need guaranteed editor context:

```typescript
vscode.commands.registerTextEditorCommand('myext.format', (editor, edit) => {
    // editor and edit are guaranteed valid
    edit.replace(editor.selection, formatted);
});
```

Context menu registration in `package.json`:

```json
"menus": {
  "editor/context": [{
    "command": "myext.action",
    "when": "editorTextFocus && resourceLangId == typescript"
  }]
}
```

---

## TreeDataProvider

Key implementation points:

```typescript
class MyTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<
        TreeItem | undefined
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined); // undefined = refresh all
    }
}
```

Use `contextValue` for context-menu filtering:

```typescript
item.contextValue = element.isDirectory ? 'folder' : 'file';
```

---

## WebviewViewProvider

Security-critical: always set CSP and use `asWebviewUri`:

```typescript
webviewView.webview.options = {
    enableScripts: true,
    localResourceRoots: [this.extensionUri],
};

const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
);

// HTML with CSP
`<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource};">`;
```

Type-safe message protocol:

```typescript
type ToWebview =
    | { type: 'update'; data: Data }
    | { type: 'error'; message: string };
type FromWebview = { type: 'ready' } | { type: 'action'; payload: Payload };
```

---

## FileSystemWatcher

Use for change detection instead of polling:

```typescript
const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, '**/*.ts')
);
watcher.onDidChange((uri) => this.invalidateCache(uri));
context.subscriptions.push(watcher); // Always dispose
```

---

## Configuration

Watch for changes:

```typescript
context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('myext.setting')) {
            this.reloadSetting();
        }
    })
);
```

---

## Progress Reporting

For operations >500ms:

```typescript
await vscode.window.withProgress(
    {
        location: vscode.ProgressLocation.Notification,
        title: 'Analyzing',
        cancellable: true,
    },
    async (progress, token) => {
        for (
            let i = 0;
            i < files.length && !token.isCancellationRequested;
            i++
        ) {
            progress.report({
                increment: 100 / files.length,
                message: files[i].name,
            });
            await processFile(files[i]);
        }
    }
);
```
