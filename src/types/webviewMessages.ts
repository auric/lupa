/**
 * Types for webview-to-extension-host communication
 */

// Base message structure
export interface WebviewMessage<T = any> {
    command: string;
    payload: T;
}

// OpenFile command types
export interface OpenFilePayload {
    filePath: string;
    line?: number;
    column?: number;
}

export interface OpenFileMessage extends WebviewMessage<OpenFilePayload> {
    command: 'openFile';
}

// ValidatePath command types
export interface ValidatePathPayload {
    filePath: string;
    requestId?: string;
}

export interface ValidatePathMessage extends WebviewMessage<ValidatePathPayload> {
    command: 'validatePath';
}

// PathValidationResult response types
export interface PathValidationResultPayload {
    filePath: string;
    isValid: boolean;
    requestId?: string;
    resolvedPath?: string;
}

export interface PathValidationResultMessage extends WebviewMessage<PathValidationResultPayload> {
    command: 'pathValidationResult';
}

// Theme update types
export interface ThemeUpdatePayload {
    kind: number;
    isDarkTheme: boolean;
}

export interface ThemeUpdateMessage extends WebviewMessage<ThemeUpdatePayload> {
    command: 'themeUpdate';
}

// Union type for all possible webview messages
export type WebviewMessageType = 
    | OpenFileMessage
    | ValidatePathMessage
    | PathValidationResultMessage
    | ThemeUpdateMessage;