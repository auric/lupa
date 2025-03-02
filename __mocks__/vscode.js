// ___mocks__/vscode.js
/* eslint-disable node/no-unpublished-require */
const vscodeMock = require('jest-mock-vscode').createVSCodeMock(jest);
/* eslint-enable node/no-unpublished-require */

vscodeMock.TextDocument = jest.fn().mockImplementation(() => ({
  getText: jest.fn().mockReturnValue('mocked document text'),
  lineAt: jest.fn().mockReturnValue({ text: 'mocked line text' }),
  offsetAt: jest.fn().mockReturnValue(10),
  positionAt: jest.fn((offset) => {
    return new vscodeMock.Position(Math.floor(offset / 10), offset % 10);
  }),
  lineCount: 100
}));

// Add custom mocks for Position class
vscodeMock.Position = jest.fn().mockImplementation((line, character) => {
  return {
    line,
    character,
    translate: jest.fn(function (lineDelta, characterDelta) {
      return new vscodeMock.Position(this.line + lineDelta, this.character + characterDelta);
    })
  };
});

// Add custom mocks for Range class
vscodeMock.Range = jest.fn().mockImplementation((startOrStartLine, endOrStartCharacter, endLine, endCharacter) => {
  if (typeof startOrStartLine === 'number' && typeof endOrStartCharacter === 'number') {
    return {
      start: new vscodeMock.Position(startOrStartLine, endOrStartCharacter),
      end: new vscodeMock.Position(endLine, endCharacter),
      isEmpty: false,
      isSingleLine: startOrStartLine === endLine,
      contains: jest.fn(),
      isEqual: jest.fn(),
      intersection: jest.fn(),
      union: jest.fn(),
      with: jest.fn()
    };
  } else {
    return {
      start: startOrStartLine,
      end: endOrStartCharacter,
      isEmpty: false,
      isSingleLine: startOrStartLine.line === endOrStartCharacter.line,
      contains: jest.fn(),
      isEqual: jest.fn(),
      intersection: jest.fn(),
      union: jest.fn(),
      with: jest.fn()
    };
  }
});

// Add custom mocks for InlineCompletionItem class
vscodeMock.InlineCompletionItem = jest.fn().mockImplementation((insertText, range, command) => {
  return {
    insertText,
    range,
    command,
    filterText: undefined, // default values
  };
});

// Add custom mocks for InlineCompletionList class
vscodeMock.InlineCompletionList = jest.fn().mockImplementation((items) => {
  return {
    items,
  };
});

vscodeMock.workspace = {
  getConfiguration: jest.fn().mockReturnValue({
    get: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined)
  }),
  openTextDocument: jest.fn().mockResolvedValue({
    getText: jest.fn().mockReturnValue(''),
    save: jest.fn().mockResolvedValue(true)
  }),
  applyEdit: jest.fn().mockResolvedValue(true),
  onDidChangeTextDocument: jest.fn(),
  fs: {
    readDirectory: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    writeFile: jest.fn().mockResolvedValue(),
    stat: jest.fn().mockResolvedValue({
      type: 1
    }),
    copy: jest.fn().mockResolvedValue(),
    createDirectory: jest.fn().mockResolvedValue(),
    delete: jest.fn().mockResolvedValue()
  }
};

vscodeMock.commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn()
};

vscodeMock.ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3
};

vscodeMock.CancellationTokenSource = jest.fn().mockImplementation(() => {
  let listeners = [];
  return {
    token: {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn((listener) => {
        listeners.push(listener);
        return {
          dispose: jest.fn(() => {
            listeners = listeners.filter(l => l !== listener);
          }),
        };
      }),
    },
    cancel: jest.fn(() => {
      listeners.forEach(listener => listener());
    }),
    dispose: jest.fn(),
  };
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
  file: jest.fn(path => ({ fsPath: path })),
  parse: jest.fn(),
  joinPath: jest.fn((base, ...paths) => {
    const joinedPath = [base.fsPath, ...paths].join('/');
    return {
      ...base,
      fsPath: joinedPath,
      toString: () => joinedPath,
    };
  }),
};

vscodeMock.languages = {
  registerInlineCompletionItemProvider: jest.fn(),
  registerCodeActionsProvider: jest.fn()
};

vscodeMock.ThemeIcon = jest.fn();

vscodeMock.window = {
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  createOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    show: jest.fn()
  }),
  tabGroups: {
    activeTabGroup: {},
    all: [],
    onDidChangeTabGroups: jest.fn(),
    onDidChangeTabs: jest.fn()
  },
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: jest.fn(),
  onDidChangeVisibleTextEditors: jest.fn(),
  onDidChangeTextEditorSelection: jest.fn(),
  onDidChangeTextEditorVisibleRanges: jest.fn(),
  onDidChangeTextEditorOptions: jest.fn(),
  onDidChangeTextEditorViewColumn: jest.fn(),
  visibleNotebookEditors: [],
  onDidChangeVisibleNotebookEditors: jest.fn(),
  activeNotebookEditor: undefined,
  onDidChangeActiveNotebookEditor: jest.fn(),
  onDidChangeNotebookEditorSelection: jest.fn(),
  onDidChangeNotebookEditorVisibleRanges: jest.fn(),
  terminals: [],
  activeTerminal: undefined,
  onDidChangeActiveTerminal: jest.fn(),
  onDidOpenTerminal: jest.fn(),
  onDidCloseTerminal: jest.fn(),
  onDidChangeTerminalState: jest.fn(),
  state: {},
  onDidChangeWindowState: jest.fn(),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
  showNotebookDocument: jest.fn().mockResolvedValue(undefined),
  createTextEditorDecorationType: jest.fn(),
  showWorkspaceFolderPick: jest.fn().mockResolvedValue(undefined),
  showOpenDialog: jest.fn().mockResolvedValue(undefined),
  showSaveDialog: jest.fn().mockResolvedValue(undefined),
  createQuickPick: jest.fn().mockReturnValue({
    items: [],
    selectedItems: [],
    onDidAccept: jest.fn(),
    onDidChangeValue: jest.fn(),
    show: jest.fn(),
    hide: jest.fn()
  }),
  createInputBox: jest.fn().mockReturnValue({
    value: '',
    onDidAccept: jest.fn(),
    onDidChangeValue: jest.fn(),
    show: jest.fn(),
    hide: jest.fn()
  }),
  createOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    show: jest.fn()
  }),
  createWebviewPanel: jest.fn().mockReturnValue({
    webview: {
      postMessage: jest.fn(),
      onDidReceiveMessage: jest.fn()
    },
    reveal: jest.fn(),
    dispose: jest.fn()
  }),
  setStatusBarMessage: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  withProgress: jest.fn((options, task) => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn()
    };
    return task({}, token);
  }),
  createStatusBarItem: jest.fn().mockReturnValue({
    text: '',
    tooltip: '',
    color: '',
    command: '',
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn()
  }),
  createTerminal: jest.fn().mockReturnValue({
    sendText: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn()
  }),
  registerTreeDataProvider: jest.fn(),
  createTreeView: jest.fn().mockReturnValue({
    onDidChangeVisibility: jest.fn(),
    onDidChangeSelection: jest.fn(),
    reveal: jest.fn(),
    dispose: jest.fn()
  }),
  registerUriHandler: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerWebviewPanelSerializer: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerWebviewViewProvider: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerCustomEditorProvider: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerTerminalLinkProvider: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerTerminalProfileProvider: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  registerFileDecorationProvider: jest.fn().mockReturnValue({
    dispose: jest.fn()
  }),
  activeColorTheme: {},
  onDidChangeActiveColorTheme: jest.fn()
};

module.exports = vscodeMock;
