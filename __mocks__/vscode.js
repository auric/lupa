import { vi } from 'vitest';

function createVSCodeMock() {
  const vscodeMock = {};
  return vscodeMock;
}

let vscodeMock = createVSCodeMock();

vscodeMock.TextDocument = vi.fn().mockImplementation(() => ({
  getText: vi.fn().mockReturnValue('mocked document text'),
  lineAt: vi.fn().mockReturnValue({ text: 'mocked line text' }),
  offsetAt: vi.fn().mockReturnValue(10),
  positionAt: vi.fn((offset) => {
    return new vscodeMock.Position(Math.floor(offset / 10), offset % 10);
  }),
  lineCount: 100
}));

// Add custom mocks for Position class
vscodeMock.Position = vi.fn().mockImplementation((line, character) => {
  return {
    line,
    character,
    translate: vi.fn(function (lineDelta, characterDelta) {
      return new vscodeMock.Position(this.line + lineDelta, this.character + characterDelta);
    })
  };
});

// Add custom mocks for Range class
vscodeMock.Range = vi.fn().mockImplementation((startOrStartLine, endOrStartCharacter, endLine, endCharacter) => {
  if (typeof startOrStartLine === 'number' && typeof endOrStartCharacter === 'number') {
    return {
      start: new vscodeMock.Position(startOrStartLine, endOrStartCharacter),
      end: new vscodeMock.Position(endLine, endCharacter),
      isEmpty: false,
      isSingleLine: startOrStartLine === endLine,
      contains: vi.fn(),
      isEqual: vi.fn(),
      intersection: vi.fn(),
      union: vi.fn(),
      with: vi.fn()
    };
  } else {
    return {
      start: startOrStartLine,
      end: endOrStartCharacter,
      isEmpty: false,
      isSingleLine: startOrStartLine.line === endOrStartCharacter.line,
      contains: vi.fn(),
      isEqual: vi.fn(),
      intersection: vi.fn(),
      union: vi.fn(),
      with: vi.fn()
    };
  }
});

// Add custom mocks for InlineCompletionItem class
vscodeMock.InlineCompletionItem = vi.fn().mockImplementation((insertText, range, command) => {
  return {
    insertText,
    range,
    command,
    filterText: undefined, // default values
  };
});

// Add custom mocks for InlineCompletionList class
vscodeMock.InlineCompletionList = vi.fn().mockImplementation((items) => {
  return {
    items,
  };
});

vscodeMock.workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined)
  }),
  openTextDocument: vi.fn().mockResolvedValue({
    getText: vi.fn().mockReturnValue(''),
    save: vi.fn().mockResolvedValue(true)
  }),
  applyEdit: vi.fn().mockResolvedValue(true),
  onDidChangeTextDocument: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn((_listener) => {
    return {
      dispose: vi.fn()
    };
  }),
  fs: {
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
    writeFile: vi.fn().mockResolvedValue(),
    stat: vi.fn().mockResolvedValue({
      type: 1
    }),
    copy: vi.fn().mockResolvedValue(),
    createDirectory: vi.fn().mockResolvedValue(),
    delete: vi.fn().mockResolvedValue()
  }
};

vscodeMock.commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn()
};

vscodeMock.ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3
};

vscodeMock.CancellationTokenSource = vi.fn(function () {
  // Using function() instead of arrow function so 'this' refers to the instance
  const listeners = [];

  // Create the token property on the instance
  this.token = {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn((listener) => {
      listeners.push(listener);
      return {
        dispose: vi.fn(() => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        })
      };
    })
  };

  // Add methods to the instance
  this.cancel = vi.fn(() => {
    this.token.isCancellationRequested = true;
    // Create a copy of listeners array before iteration
    [...listeners].forEach(listener => listener());
  });

  this.dispose = vi.fn();
});

vscodeMock.ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15
};

vscodeMock.ViewColumn = {
  One: 1,
  Two: 2,
  Beside: 2
};

vscodeMock.Uri = {
  file: vi.fn(path => ({ fsPath: path })),
  parse: vi.fn(),
  joinPath: vi.fn((base, ...paths) => {
    const joinedPath = [base.fsPath, ...paths].join('/');
    return {
      ...base,
      fsPath: joinedPath,
      toString: () => joinedPath,
    };
  }),
};

vscodeMock.languages = {
  registerInlineCompletionItemProvider: vi.fn(),
  registerCodeActionsProvider: vi.fn()
};

vscodeMock.ThemeIcon = vi.fn();

vscodeMock.window = {
  showQuickPick: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn().mockResolvedValue(undefined),
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  createOutputChannel: vi.fn().mockReturnValue({
    appendLine: vi.fn(),
    show: vi.fn()
  }),
  tabGroups: {
    activeTabGroup: {},
    all: [],
    onDidChangeTabGroups: vi.fn(),
    onDidChangeTabs: vi.fn()
  },
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: vi.fn(),
  onDidChangeVisibleTextEditors: vi.fn(),
  onDidChangeTextEditorSelection: vi.fn(),
  onDidChangeTextEditorVisibleRanges: vi.fn(),
  onDidChangeTextEditorOptions: vi.fn(),
  onDidChangeTextEditorViewColumn: vi.fn(),
  visibleNotebookEditors: [],
  onDidChangeVisibleNotebookEditors: vi.fn(),
  activeNotebookEditor: undefined,
  onDidChangeActiveNotebookEditor: vi.fn(),
  onDidChangeNotebookEditorSelection: vi.fn(),
  onDidChangeNotebookEditorVisibleRanges: vi.fn(),
  terminals: [],
  activeTerminal: undefined,
  onDidChangeActiveTerminal: vi.fn(),
  onDidOpenTerminal: vi.fn(),
  onDidCloseTerminal: vi.fn(),
  onDidChangeTerminalState: vi.fn(),
  state: {},
  onDidChangeWindowState: vi.fn(),
  showTextDocument: vi.fn().mockResolvedValue(undefined),
  showNotebookDocument: vi.fn().mockResolvedValue(undefined),
  createTextEditorDecorationType: vi.fn(),
  showWorkspaceFolderPick: vi.fn().mockResolvedValue(undefined),
  showOpenDialog: vi.fn().mockResolvedValue(undefined),
  showSaveDialog: vi.fn().mockResolvedValue(undefined),
  createQuickPick: vi.fn().mockReturnValue({
    items: [],
    selectedItems: [],
    onDidAccept: vi.fn(),
    onDidChangeValue: vi.fn(),
    show: vi.fn(),
    hide: vi.fn()
  }),
  createInputBox: vi.fn().mockReturnValue({
    value: '',
    onDidAccept: vi.fn(),
    onDidChangeValue: vi.fn(),
    show: vi.fn(),
    hide: vi.fn()
  }),
  createOutputChannel: vi.fn().mockReturnValue({
    appendLine: vi.fn(),
    show: vi.fn()
  }),
  createWebviewPanel: vi.fn().mockReturnValue({
    webview: {
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn()
    },
    reveal: vi.fn(),
    dispose: vi.fn()
  }),
  setStatusBarMessage: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  withProgress: vi.fn((options, task) => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn()
    };
    return task({}, token);
  }),
  createStatusBarItem: vi.fn().mockReturnValue({
    text: '',
    tooltip: '',
    color: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  }),
  createTerminal: vi.fn().mockReturnValue({
    sendText: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  }),
  registerTreeDataProvider: vi.fn(),
  createTreeView: vi.fn().mockReturnValue({
    onDidChangeVisibility: vi.fn(),
    onDidChangeSelection: vi.fn(),
    reveal: vi.fn(),
    dispose: vi.fn()
  }),
  registerUriHandler: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerWebviewPanelSerializer: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerWebviewViewProvider: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerCustomEditorProvider: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerTerminalLinkProvider: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerTerminalProfileProvider: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  registerFileDecorationProvider: vi.fn().mockReturnValue({
    dispose: vi.fn()
  }),
  activeColorTheme: {},
  onDidChangeActiveColorTheme: vi.fn()
};

module.exports = vscodeMock;
