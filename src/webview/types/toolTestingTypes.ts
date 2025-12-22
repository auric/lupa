import * as z from 'zod';

// Base interfaces for tool testing
export interface ToolTestSession {
  id: string;
  toolName: string;
  parameters: Record<string, any>;
  results?: ToolTestResult[];
  timestamp: Date;
  executionTime?: number;
  status: 'pending' | 'running' | 'completed' | 'error';
  error?: string;
}

export interface ToolTestResult {
  id: string;
  data: any;
  timestamp: Date;
  executionTime: number;
  status: 'success' | 'error';
  error?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  schema: z.ZodType;
  lastUsed?: Date;
  usageCount: number;
  isFavorite: boolean;
}

export interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: any;
}

export interface FormValidationError {
  field: string;
  message: string;
  type: 'required' | 'invalid' | 'format' | 'range';
}

export interface ToolTestingViewProps {
  initialTool?: string;
  initialParameters?: Record<string, any>;
}

// Message types for webview communication
export interface WebviewMessage {
  type: string;
  payload?: any;
}

export interface ToolExecutionMessage extends WebviewMessage {
  type: 'executetool';
  payload: {
    toolName: string;
    parameters: Record<string, any>;
    sessionId: string;
  };
}

export interface ToolExecutionResultMessage extends WebviewMessage {
  type: 'toolExecutionResult';
  payload: {
    sessionId: string;
    results: any[];
    executionTime: number;
    error?: string;
  };
}

