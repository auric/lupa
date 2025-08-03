import { useState, useCallback, useRef } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import type { 
  ToolTestSession, 
  ToolTestResult, 
  FormValidationError
} from '../types/toolTestingTypes';

export const useToolExecution = () => {
  const vscode = useVSCodeApi();
  const [currentSession, setCurrentSession] = useState<ToolTestSession | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FormValidationError[]>([]);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  // Execute a tool test
  const executeToolTest = useCallback(async (
    toolName: string, 
    parameters: Record<string, any>
  ): Promise<ToolTestSession> => {
    // Clear previous errors
    setValidationErrors([]);
    
    // Create new session
    const session: ToolTestSession = {
      id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      toolName,
      parameters: { ...parameters },
      timestamp: new Date(),
      status: 'running',
      results: []
    };

    // Set up execution context
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    const startTime = performance.now();

    try {
      setCurrentSession(session);
      setIsExecuting(true);

      // Send execution request to extension
      const executionPromise = new Promise<ToolTestResult[]>((resolve, reject) => {
        const messageHandler = (event: MessageEvent) => {
          const message = event.data;
          
          if (message.type === 'toolExecutionResult' && message.payload.sessionId === session.id) {
            window.removeEventListener('message', messageHandler);
            
            if (message.payload.error) {
              reject(new Error(message.payload.error));
            } else {
              const results: ToolTestResult[] = message.payload.results.map((data: any, index: number) => ({
                id: `result-${index}`,
                data,
                timestamp: new Date(),
                executionTime: message.payload.executionTime || 0,
                status: 'success' as const
              }));
              resolve(results);
            }
          } else if (message.type === 'toolExecutionError' && message.payload.sessionId === session.id) {
            window.removeEventListener('message', messageHandler);
            reject(new Error(message.payload.error));
          }
        };

        window.addEventListener('message', messageHandler);
        
        // Set timeout for execution
        const timeout = setTimeout(() => {
          window.removeEventListener('message', messageHandler);
          reject(new Error('Tool execution timed out'));
        }, 30000); // 30 second timeout

        // Send execution request
        vscode?.postMessage({
          command: 'executeTool',
          payload: {
            sessionId: session.id,
            toolName,
            parameters
          }
        });

        // Handle abort
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          window.removeEventListener('message', messageHandler);
          reject(new Error('Tool execution was cancelled'));
        });
      });

      const results = await executionPromise;
      const executionTime = performance.now() - startTime;

      // Update session with results
      const completedSession: ToolTestSession = {
        ...session,
        results,
        executionTime: Math.round(executionTime),
        status: 'completed'
      };

      setCurrentSession(completedSession);
      return completedSession;

    } catch (error) {
      const executionTime = Math.round(performance.now() - startTime);

      // Update session with error
      const errorSession: ToolTestSession = {
        ...session,
        executionTime,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };

      setCurrentSession(errorSession);
      throw error;
    } finally {
      setIsExecuting(false);
      abortControllerRef.current = null;
    }
  }, [vscode]);

  // Cancel current execution
  const cancelExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    if (currentSession && currentSession.status === 'running') {
      setCurrentSession(prev => prev ? {
        ...prev,
        status: 'error',
        error: 'Execution cancelled by user'
      } : null);
    }
    
    setIsExecuting(false);
  }, [currentSession]);

  // Validate parameters against tool schema
  const validateParameters = useCallback((
    toolName: string,
    parameters: Record<string, any>,
    toolSchema: any
  ): FormValidationError[] => {
    const errors: FormValidationError[] = [];
    
    try {
      // Use Zod to validate parameters
      toolSchema.parse(parameters);
    } catch (zodError: any) {
      if (zodError.errors) {
        zodError.errors.forEach((error: any) => {
          const field = error.path.join('.');
          errors.push({
            field,
            message: error.message,
            type: error.code === 'invalid_type' ? 'invalid' : 
                  error.code === 'too_small' ? 'required' :
                  error.code === 'custom' ? 'format' : 'invalid'
          });
        });
      }
    }
    
    setValidationErrors(errors);
    return errors;
  }, []);

  // Clear current session
  const clearSession = useCallback(() => {
    if (isExecuting) {
      cancelExecution();
    }
    setCurrentSession(null);
    setValidationErrors([]);
  }, [isExecuting, cancelExecution]);

  return {
    // State
    currentSession,
    isExecuting,
    validationErrors,
    
    // Actions
    executeToolTest,
    cancelExecution,
    validateParameters,
    clearSession,
    
    // Utils
    isSessionRunning: currentSession?.status === 'running',
    hasValidationErrors: validationErrors.length > 0,
    canExecute: !isExecuting && validationErrors.length === 0
  };
};