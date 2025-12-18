import { vi } from 'vitest';

function createVSCodeMock() {
  const vscodeMock = {};
  return vscodeMock;
}

const vscodeMock = createVSCodeMock();

vscodeMock.TextDocument = vi.fn().mockImplementation(function() {
  this.getText = vi.fn().mockReturnValue('mocked document text');
  this.lineAt = vi.fn().mockReturnValue({ text: 'mocked line text' });
  this.offsetAt = vi.fn().mockReturnValue(10);
  this.positionAt = vi.fn(function(offset) {
    return new vscodeMock.Position(Math.floor(offset / 10), offset % 10);
  });
  this.lineCount = 100;
});

// Add mock for Position class - Vitest 4 requires function syntax for constructor mocks
vscodeMock.Position = vi.fn(function(line, character) {
  this.line = line;
  this.character = character;
  this.isEqual = vi.fn(function(other) { return other && other.line === line && other.character === character; });
  this.isBefore = vi.fn(function(other) { return other && (line < other.line || (line === other.line && character < other.character)); });
  this.isAfter = vi.fn(function(other) { return other && (line > other.line || (line === other.line && character > other.character)); });
  this.translate = vi.fn(function(lineDelta, characterDelta) {
    lineDelta = lineDelta || 0;
    characterDelta = characterDelta || 0;
    return new vscodeMock.Position(line + lineDelta, character + characterDelta);
  });
  this.with = vi.fn(function(lineOrChange, newChar) {
    let newLineVal = line;
    let newCharVal = character;
    if (typeof lineOrChange === 'number') {
      newLineVal = lineOrChange;
      if (newChar !== undefined) newCharVal = newChar;
    } else {
      if (lineOrChange.line !== undefined) {
        newLineVal = lineOrChange.line;
      }
      if (lineOrChange.character !== undefined) {
        newCharVal = lineOrChange.character;
      }
    }
    return new vscodeMock.Position(newLineVal, newCharVal);
  });
});

// Add custom mocks for Range class - Vitest 4 requires function syntax for constructor mocks
vscodeMock.Range = vi.fn().mockImplementation(function(startOrStartLine, endOrStartCharacter, endLine, endCharacter) {
  let startPos, endPos;
  if (typeof startOrStartLine === 'number' && typeof endOrStartCharacter === 'number') {
    startPos = new vscodeMock.Position(startOrStartLine, endOrStartCharacter);
    endPos = new vscodeMock.Position(endLine, endCharacter);
  } else {
    startPos = startOrStartLine;  // Assumed to be a Position instance
    endPos = endOrStartCharacter; // Assumed to be a Position instance
  }

  // Ensure startPos and endPos are valid before creating the range object
  if (!startPos || typeof startPos.line !== 'number' || typeof startPos.character !== 'number') {
    console.error('[VSCODE_MOCK Range] Invalid start position:', startPos);
    startPos = new vscodeMock.Position(0, 0); // Default fallback
  }
  if (!endPos || typeof endPos.line !== 'number' || typeof endPos.character !== 'number') {
    console.error('[VSCODE_MOCK Range] Invalid end position:', endPos);
    endPos = new vscodeMock.Position(0, 0); // Default fallback
  }

  this.start = startPos;
  this.end = endPos;
  this.isEmpty = startPos.isEqual(endPos);
  this.isSingleLine = startPos.line === endPos.line;
  this.contains = vi.fn(function(positionOrRange) {
    if (positionOrRange instanceof vscodeMock.Position) {
      return !positionOrRange.isBefore(startPos) && !positionOrRange.isAfter(endPos);
    }
    return !positionOrRange.start.isBefore(startPos) && !positionOrRange.end.isAfter(endPos);
  });
  this.isEqual = vi.fn(function(other) { return other && startPos.isEqual(other.start) && endPos.isEqual(other.end); });
  this.intersection = vi.fn();
  this.union = vi.fn();
  this.with = vi.fn();
});

// Add custom mocks for InlineCompletionItem class - Vitest 4 requires function syntax
vscodeMock.InlineCompletionItem = vi.fn().mockImplementation(function(insertText, range, command) {
  this.insertText = insertText;
  this.range = range;
  this.command = command;
  this.filterText = undefined;
});

// Add custom mocks for InlineCompletionList class - Vitest 4 requires function syntax
vscodeMock.InlineCompletionList = vi.fn().mockImplementation(function(items) {
  this.items = items;
});

// Add mock for FileType enum
vscodeMock.FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
};

// Add mock for FileStat interface - Vitest 4 requires function syntax for constructor mocks
vscodeMock.FileStat = vi.fn().mockImplementation(function(type, ctime, mtime, size) {
  this.type = type || vscodeMock.FileType.File;
  this.ctime = ctime || Date.now();
  this.mtime = mtime || Date.now();
  this.size = size || 0;
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
  // Define workspaceFolders as a mutable array within the mock
  workspaceFolders: [],
  asRelativePath: vi.fn((uriOrPath) => {
    // Basic mock: if it's a Uri, return its path, otherwise return the string itself.
    // Tests can override this with more specific behavior if needed.
    if (uriOrPath && typeof uriOrPath === 'object' && uriOrPath.fsPath) {
      return uriOrPath.fsPath;
    }
    return String(uriOrPath);
  }),
  fs: {
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
    writeFile: vi.fn().mockResolvedValue(),
    // Update stat mock to use FileType.File
    stat: vi.fn().mockResolvedValue({ type: vscodeMock.FileType.File, ctime: 0, mtime: 0, size: 0 }),
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

vscodeMock.ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3,
}

vscodeMock.ExtensionKind = {
  UI: 1,
  Workspace: 2,
}

vscodeMock.CancellationError = vi.fn().mockImplementation(function() {
  this.name = 'CancellationError';
  this.message = 'The operation was cancelled.';
  this.stack = new Error().stack;
  this.toString = function() {
    return `${this.name}: ${this.message}`;
  };
});

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
  Beside: -2, // Match VS Code's actual value
  Active: -1
};

vscodeMock.ColorThemeKind = {
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4
};

vscodeMock.SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25
};

vscodeMock.Uri = vi.fn(function (scheme, authority, path, query, fragment) {
  this.scheme = scheme;
  this.authority = authority;
  this.path = path;
  this.query = query;
  this.fragment = fragment;

  // Define fsPath as a getter to better mimic vscode.Uri behavior
  Object.defineProperty(this, 'fsPath', {
    get: () => {
      // This is a simplified fsPath for mock purposes.
      // Real vscode.Uri.fsPath involves platform-specific path handling.
      if (this.scheme === 'file') {
        // Assuming 'this.path' for file URIs already represents a file system path.
        // For example, if path is '/c:/foo/bar.txt' or 'c:\\foo\\bar.txt'
        return this.path;
      }
      // For non-file schemes, fsPath might be undefined or throw.
      // Depending on test needs, this could be adjusted.
      // For now, returning path or an empty string if not 'file' scheme.
      return this.scheme === 'file' ? this.path : '';
    },
    configurable: true // Allow re-configuration if needed in specific tests
  });

  this.toString = vi.fn((skipEncoding = false) => {
    // Simplified toString for mock
    let s = `${this.scheme}:`;
    if (this.authority) {
      s += `//${this.authority}`;
    }
    s += this.path;
    if (this.query) {
      s += `?${this.query}`;
    }
    if (this.fragment) {
      s += `#${this.fragment}`;
    }
    return s;
  });

  this.with = vi.fn((change) => {
    return new vscodeMock.Uri(
      change.scheme !== undefined ? change.scheme : this.scheme,
      change.authority !== undefined ? change.authority : this.authority,
      change.path !== undefined ? change.path : this.path,
      change.query !== undefined ? change.query : this.query,
      change.fragment !== undefined ? change.fragment : this.fragment
    );
  });

  this.toJSON = vi.fn(() => ({
    scheme: this.scheme,
    authority: this.authority,
    path: this.path,
    query: this.query,
    fragment: this.fragment,
    fsPath: this.fsPath, // Include fsPath in JSON representation
  }));
});

// Static methods for the Uri mock constructor
vscodeMock.Uri.file = vi.fn(filePath => {
  // For file URIs, the path component should be the absolute path.
  // The scheme is 'file', authority is empty for local files.
  const instance = new vscodeMock.Uri('file', '', filePath, '', '');
  // Ensure fsPath directly returns the input filePath for .file()
  Object.defineProperty(instance, 'fsPath', {
    value: filePath,
    writable: false, // fsPath is typically read-only
    configurable: true
  });
  return instance;
});

vscodeMock.Uri.parse = vi.fn((value, strict = false) => {
  // Extremely simplified parser for mock purposes.
  // A real URI parser is much more complex.
  try {
    const url = new URL(value); // Use built-in URL for basic parsing
    const instance = new vscodeMock.Uri(
      url.protocol.replace(':', ''),
      url.hostname + (url.port ? `:${url.port}` : ''),
      url.pathname,
      url.search.startsWith('?') ? url.search.substring(1) : url.search,
      url.hash.startsWith('#') ? url.hash.substring(1) : url.hash
    );
    if (instance.scheme === 'file') {
      // For file URIs, fsPath should be the decoded path.
      // URL.pathname for file URIs is usually like /C:/path/to/file on Windows.
      // This needs to be normalized.
      let fsPathValue = decodeURIComponent(url.pathname);
      // Remove leading slash for Windows drive letters, e.g., /C:/ -> C:/
      if (/^\/[a-zA-Z]:\//.test(fsPathValue)) {
        fsPathValue = fsPathValue.substring(1);
      }
      Object.defineProperty(instance, 'fsPath', {
        value: fsPathValue,
        writable: false,
        configurable: true
      });
    }
    return instance;
  } catch (e) {
    // Fallback for non-standard URIs or if URL parsing fails (e.g. just a path)
    // This is a very basic fallback and might not cover all cases.
    console.warn(`[VSCODE_MOCK Uri.parse] Failed to parse "${value}" with URL constructor, using basic file path assumption. Error: ${e.message}`);
    const instance = new vscodeMock.Uri('file', '', value, '', '');
    Object.defineProperty(instance, 'fsPath', {
      value: value, // Assume value is a file path
      writable: false,
      configurable: true
    });
    return instance;
  }
});

vscodeMock.Uri.joinPath = vi.fn((baseUri, ...pathSegments) => {
  if (!(baseUri instanceof vscodeMock.Uri)) {
    // Attempt to coerce if a plain object with fsPath is passed (common in tests)
    if (baseUri && typeof baseUri.fsPath === 'string' && typeof baseUri.scheme === 'string') {
      baseUri = new vscodeMock.Uri(baseUri.scheme, baseUri.authority || '', baseUri.path || '', baseUri.query || '', baseUri.fragment || '');
      // If it was a file URI, ensure fsPath is correctly set from the original fsPath
      if (baseUri.scheme === 'file' && typeof arguments[0].fsPath === 'string') {
        Object.defineProperty(baseUri, 'fsPath', {
          value: arguments[0].fsPath,
          writable: false,
          configurable: true
        });
      }
    } else {
      console.error('[VSCODE_MOCK Uri.joinPath] baseUri is not an instance of vscodeMock.Uri:', baseUri);
      // Fallback: treat baseUri as a string path and create a file URI
      const basePath = (typeof baseUri === 'string') ? baseUri : (baseUri?.fsPath || baseUri?.path || '');
      baseUri = vscodeMock.Uri.file(basePath);
    }
  }

  // Simplified path joining: assumes baseUri.path and pathSegments are filesystem-like paths.
  // This does not correctly handle URI encoding or complex path normalization like the real vscode.Uri.joinPath.
  let newPath = baseUri.path;
  for (const segment of pathSegments) {
    if (newPath.endsWith('/') && segment.startsWith('/')) {
      newPath += segment.substring(1);
    } else if (!newPath.endsWith('/') && !segment.startsWith('/')) {
      newPath += '/' + segment;
    } else {
      newPath += segment;
    }
  }
  // Basic normalization
  newPath = newPath.replace(/\/\//g, '/');

  const joinedUri = new vscodeMock.Uri(baseUri.scheme, baseUri.authority, newPath, baseUri.query, baseUri.fragment);
  // If the original baseUri was a file URI, the joined URI should also have a correctly derived fsPath.
  if (baseUri.scheme === 'file') {
    // This fsPath derivation is simplified. Real one handles URI decoding and platform specifics.
    let fsPathValue = joinedUri.path;
    if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(fsPathValue)) {
      fsPathValue = fsPathValue.substring(1); // e.g. /c:/foo -> c:/foo
    }
    Object.defineProperty(joinedUri, 'fsPath', {
      value: fsPathValue,
      writable: false,
      configurable: true
    });
  }
  return joinedUri;
});

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

// Add custom mocks for LanguageModelChatMessageRole
vscodeMock.LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2
};

// Add custom mocks for LanguageModelChatMessage - Vitest 4 requires function syntax
vscodeMock.LanguageModelChatMessage = vi.fn().mockImplementation(function(role, content, name) {
  this.role = role;
  this.content = content;
  this.name = name;
});

vscodeMock.LanguageModelChatMessage.User = vi.fn(function(content, name) {
  return {
    role: vscodeMock.LanguageModelChatMessageRole.User,
    content: content,
    name: name
  };
});

vscodeMock.LanguageModelChatMessage.Assistant = vi.fn(function(content, name) {
  return {
    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
    content: content,
    name: name
  };
});

// Add custom mocks for LanguageModelChat - Vitest 4 requires function syntax
vscodeMock.LanguageModelChat = vi.fn().mockImplementation(function(id, name, vendor, family, version, maxInputTokens) {
  this.id = id || 'mock-model-id';
  this.name = name || 'mock-model-name';
  this.vendor = vendor || 'mock-vendor';
  this.family = family || 'mock-family';
  this.version = version || '1.0';
  this.maxInputTokens = maxInputTokens || 4096;
  this.sendRequest = vi.fn().mockResolvedValue({});
  this.countTokens = vi.fn().mockResolvedValue(10);
});

// Add mocks for LanguageModelTextPart and LanguageModelToolCallPart
vscodeMock.LanguageModelTextPart = class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
};

vscodeMock.LanguageModelToolCallPart = class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
};

vscodeMock.LanguageModelToolResultPart = class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
};

// Add lm namespace
vscodeMock.lm = {
  selectChatModels: vi.fn().mockResolvedValue([]),
  onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })),
};

// Mock chat namespace and selectChatModels
vscodeMock.chat = {
  languageModels: {
    selectChatModels: vi.fn().mockResolvedValue([]),
    onDidChangeLanguageModels: vi.fn(() => ({ dispose: vi.fn() })),
    all: [],
  },
  createChatParticipant: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    iconPath: undefined,
    followupProvider: undefined,
  }),
};

// Mock env namespace (for vscode.env.appRoot, etc.)
vscodeMock.env = {
  appRoot: '/mock/vscode/app',
  appName: 'Visual Studio Code',
  language: 'en',
  machineId: 'mock-machine-id',
  sessionId: 'mock-session-id',
  uriScheme: 'vscode',
};

vscodeMock.ChatResponseFileTreePart = class ChatResponseFileTreePart {
  constructor(value, baseUri) {
    this.value = value;
    this.baseUri = baseUri;
  }
};

export const commands = vscodeMock.commands;
export const chat = vscodeMock.chat;
export const workspace = vscodeMock.workspace;
export const window = vscodeMock.window;
export const Uri = vscodeMock.Uri;
export const Position = vscodeMock.Position;
export const Range = vscodeMock.Range;
export const TextDocument = vscodeMock.TextDocument;
export const InlineCompletionItem = vscodeMock.InlineCompletionItem;
export const InlineCompletionList = vscodeMock.InlineCompletionList;
export const ConfigurationTarget = vscodeMock.ConfigurationTarget;
export const ExtensionMode = vscodeMock.ExtensionMode;
export const ExtensionKind = vscodeMock.ExtensionKind;
export const CancellationError = vscodeMock.CancellationError;
export const CancellationTokenSource = vscodeMock.CancellationTokenSource;
export const ProgressLocation = vscodeMock.ProgressLocation;
export const ViewColumn = vscodeMock.ViewColumn;
export const ColorThemeKind = vscodeMock.ColorThemeKind;
export const SymbolKind = vscodeMock.SymbolKind;
export const languages = vscodeMock.languages;
export const ThemeIcon = vscodeMock.ThemeIcon;
export const LanguageModelChatMessageRole = vscodeMock.LanguageModelChatMessageRole;
export const LanguageModelChatMessage = vscodeMock.LanguageModelChatMessage;
export const LanguageModelChat = vscodeMock.LanguageModelChat;
export const LanguageModelTextPart = vscodeMock.LanguageModelTextPart;
export const LanguageModelToolCallPart = vscodeMock.LanguageModelToolCallPart;
export const LanguageModelToolResultPart = vscodeMock.LanguageModelToolResultPart;
export const lm = vscodeMock.lm;
export const env = vscodeMock.env;

// Export the new mocks
export const FileType = vscodeMock.FileType;
export const FileStat = vscodeMock.FileStat;
export const ChatResponseFileTreePart = vscodeMock.ChatResponseFileTreePart;

// Default export for direct imports
export default vscodeMock;
