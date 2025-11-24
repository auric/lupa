import React, { useState, useCallback, useEffect } from 'react';
import type { ToolInfo, FormValidationError } from '../../types/toolTestingTypes';
import { Checkbox } from '../../../components/ui/checkbox';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Button } from '../../../components/ui/button';

interface ParameterInputPanelProps {
  toolInfo: ToolInfo | undefined;
  initialParameters: Record<string, any>;
  onExecute: (parameters: Record<string, any>) => Promise<void>;
  isExecuting: boolean;
  validationErrors: FormValidationError[];
  onCancel: () => void;
}

interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: any;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    options?: string[];
  };
}

export const ParameterInputPanel: React.FC<ParameterInputPanelProps> = ({
  toolInfo,
  initialParameters,
  onExecute,
  isExecuting,
  validationErrors,
  onCancel
}) => {
  const [parameters, setParameters] = useState<Record<string, any>>(initialParameters);
  const [showOptionalParams, setShowOptionalParams] = useState(false);

  // Extract parameter info from tool schema
  const parameterInfos = React.useMemo(() => {
    if (!toolInfo?.schema) return [];

    const infos: ParameterInfo[] = [];
    const shape = (toolInfo.schema as any).def?.shape || {};

    Object.entries(shape).forEach(([name, zodField]: [string, any]) => {
      const fieldDef = zodField.def;
      let isOptional = fieldDef.type === 'optional';
      let actualField = isOptional ? fieldDef.innerType : zodField;
      let defaultValue = undefined;

      // Handle ZodDefault (has default value but is technically optional)
      if (actualField.def?.type === 'default') {
        defaultValue = actualField.def.defaultValue;
        actualField = actualField.def.innerType;
        isOptional = true; // Fields with defaults are optional
      }

      // Handle ZodOptional wrapping ZodDefault
      if (isOptional && actualField.def?.type === 'default') {
        defaultValue = actualField.def.defaultValue;
        actualField = actualField.def.innerType;
      }

      // Extract validation constraints
      let validation = {};
      if (actualField.def?.type === 'number') {
        const checks = actualField.def.checks || [];
        validation = {
          min: checks.find((c: any) => c.kind === 'min')?.value,
          max: checks.find((c: any) => c.kind === 'max')?.value,
        };
      }

      const param: ParameterInfo = {
        name,
        type: actualField.def?.type || 'string',
        required: !isOptional,
        description: fieldDef.description || actualField.def?.description || actualField.description,
        defaultValue,
        validation
      };

      infos.push(param);
    });

    return infos.sort((a, b) => {
      // Sort required fields first
      if (a.required && !b.required) return -1;
      if (!a.required && b.required) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [toolInfo?.schema]);

  // Reset parameters when tool changes
  useEffect(() => {
    if (toolInfo) {
      const newParams = { ...initialParameters };
      // Set default values for parameters
      parameterInfos.forEach(param => {
        if (param.defaultValue !== undefined && !(param.name in newParams)) {
          newParams[param.name] = param.defaultValue;
        }
      });
      setParameters(newParams);
    }
  }, [toolInfo, initialParameters, parameterInfos]);

  const handleParameterChange = useCallback((name: string, value: any) => {
    setParameters(prev => ({
      ...prev,
      [name]: value
    }));
  }, []);

  const handleExecute = useCallback(async () => {
    if (!toolInfo || isExecuting) return;

    // Filter out empty optional parameters
    const filteredParams = Object.entries(parameters).reduce((acc, [key, value]) => {
      const paramInfo = parameterInfos.find(p => p.name === key);
      if (paramInfo?.required || (value !== '' && value !== null && value !== undefined)) {
        acc[key] = value;
      }
      return acc;
    }, {} as Record<string, any>);

    await onExecute(filteredParams);
  }, [toolInfo, isExecuting, parameters, parameterInfos, onExecute]);

  const handleClearForm = useCallback(() => {
    const clearedParams = parameterInfos.reduce((acc, param) => {
      if (param.defaultValue !== undefined) {
        acc[param.name] = param.defaultValue;
      }
      return acc;
    }, {} as Record<string, any>);
    setParameters(clearedParams);
  }, [parameterInfos]);

  const getValidationError = useCallback((fieldName: string) => {
    return validationErrors.find(error => error.field === fieldName);
  }, [validationErrors]);

  const isFormValid = React.useMemo(() => {
    const requiredParams = parameterInfos.filter(p => p.required);
    return requiredParams.every(param => {
      const value = parameters[param.name];
      return value !== undefined && value !== '' && value !== null;
    }) && validationErrors.length === 0;
  }, [parameterInfos, parameters, validationErrors]);

  const requiredParams = parameterInfos.filter(p => p.required);
  const optionalParams = parameterInfos.filter(p => !p.required);

  if (!toolInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 text-muted-foreground">
        <div className="text-4xl mb-4">⚙️</div>
        <h3 className="text-lg font-semibold mb-2">Select a Tool</h3>
        <p className="text-sm max-w-xs">
          Choose a tool from the sidebar to configure its parameters
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6">
          {/* Tool Info Header */}
          <div className="mb-6 pb-6 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold">{toolInfo.name}</h2>
            </div>
            <p className="text-muted-foreground">{toolInfo.description}</p>
          </div>

          {/* Parameter Form */}
          <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); handleExecute(); }}>

            {/* Required Parameters */}
            {requiredParams.length > 0 && (
              <div className="space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Required Parameters</h4>
                {requiredParams.map(param => (
                  <ParameterField
                    key={param.name}
                    parameter={param}
                    value={parameters[param.name] !== undefined ? parameters[param.name] : (param.defaultValue !== undefined ? param.defaultValue : '')}
                    onChange={handleParameterChange}
                    error={getValidationError(param.name)}
                  />
                ))}
              </div>
            )}

            {/* Optional Parameters */}
            {optionalParams.length > 0 && (
              <div className="space-y-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start p-0 h-auto font-semibold text-muted-foreground hover:text-foreground"
                  onClick={() => setShowOptionalParams(!showOptionalParams)}
                  aria-expanded={showOptionalParams}
                >
                  <span className="mr-2">{showOptionalParams ? '▼' : '▶'}</span>
                  Optional Parameters ({optionalParams.length})
                </Button>

                {showOptionalParams && (
                  <div className="space-y-4 pt-2 pl-4 border-l-2 border-muted">
                    {optionalParams.map(param => (
                      <ParameterField
                        key={param.name}
                        parameter={param}
                        value={parameters[param.name] !== undefined ? parameters[param.name] : (param.defaultValue !== undefined ? param.defaultValue : '')}
                        onChange={handleParameterChange}
                        error={getValidationError(param.name)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* Fixed Action Footer */}
      <div className="p-4 border-t border-border bg-background flex gap-2 justify-end shrink-0">
        {isExecuting ? (
          <Button
            type="button"
            variant="destructive"
            onClick={onCancel}
          >
            <span className="mr-2 animate-spin">⟳</span>
            Cancel
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleClearForm}
            >
              Clear Form
            </Button>
            <Button
              type="button"
              onClick={handleExecute}
              disabled={!isFormValid}
              title={!isFormValid ? 'Please fill in all required parameters' : 'Execute tool'}
            >
              Execute Tool
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

interface ParameterFieldProps {
  parameter: ParameterInfo;
  value: any;
  onChange: (name: string, value: any) => void;
  error?: FormValidationError;
}

const ParameterField: React.FC<ParameterFieldProps> = React.memo(({
  parameter,
  value,
  onChange,
  error
}) => {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    let newValue: any = e.target.value;

    // Type conversion based on parameter type
    if (parameter.type === 'number') {
      newValue = newValue === '' ? undefined : Number(newValue);
    } else if (parameter.type === 'boolean') {
      newValue = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : newValue === 'true';
    }

    onChange(parameter.name, newValue);
  }, [parameter.name, parameter.type, onChange]);

  const renderInput = () => {
    const commonProps = {
      id: parameter.name,
      name: parameter.name,
      'aria-describedby': error ? `${parameter.name}-error` : parameter.description ? `${parameter.name}-desc` : undefined,
      'aria-invalid': !!error,
      'aria-required': parameter.required
    };

    // Boolean inputs
    if (parameter.type === 'boolean') {
      return (
        <div className="flex items-center space-x-2">
          <Checkbox
            id={parameter.name}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(parameter.name, checked)}
            aria-describedby={parameter.description ? `${parameter.name}-desc` : undefined}
          />
          <Label
            htmlFor={parameter.name}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Enable {parameter.name}
          </Label>
        </div>
      );
    }

    // Number inputs with enhanced styling
    if (parameter.type === 'number') {
      return (
        <div className="space-y-1">
          <Input
            type="number"
            {...commonProps}
            value={value !== undefined ? value : ''}
            onChange={handleChange}
            className={error ? 'border-destructive' : ''}
            placeholder={`Enter ${parameter.name}...`}
            min={parameter.validation?.min}
            max={parameter.validation?.max}
            step="any"
          />
          {(parameter.validation?.min !== undefined || parameter.validation?.max !== undefined) && (
            <div className="text-xs text-muted-foreground">
              {parameter.validation?.min !== undefined && parameter.validation?.max !== undefined
                ? `Range: ${parameter.validation.min} - ${parameter.validation.max}`
                : parameter.validation?.min !== undefined
                ? `Min: ${parameter.validation.min}`
                : `Max: ${parameter.validation.max}`
              }
            </div>
          )}
        </div>
      );
    }

    // File path inputs - detect common file path parameter names
    const isFilePathParam = parameter.name.toLowerCase().includes('path') || 
                           parameter.name.toLowerCase().includes('file') ||
                           parameter.description?.toLowerCase().includes('path') ||
                           parameter.description?.toLowerCase().includes('file');

    if (isFilePathParam) {
      return (
        <div className="space-y-1">
          <Input
            type="text"
            {...commonProps}
            value={value || ''}
            onChange={handleChange}
            className={`font-mono text-xs ${error ? 'border-destructive' : ''}`}
            placeholder={`Enter file path...`}
          />
          <div className="text-xs text-muted-foreground">
            File path (e.g., src/components/MyComponent.tsx)
          </div>
        </div>
      );
    }

    // Large text inputs - use textarea for content, text, or multi-line fields
    const isLargeText = parameter.name.toLowerCase().includes('content') ||
                       parameter.name.toLowerCase().includes('text') ||
                       parameter.name.toLowerCase().includes('message') ||
                       parameter.name.toLowerCase().includes('description') ||
                       parameter.type === 'array' ||
                       parameter.type === 'object';

    if (isLargeText) {
      const rows = parameter.type === 'object' ? 5 : 3;
      return (
        <div className="space-y-1">
          <textarea
            {...commonProps}
            value={value || ''}
            onChange={handleChange}
            className={`flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono ${error ? 'border-destructive' : ''}`}
            placeholder={parameter.type === 'object' ? 'Enter JSON object...' : 
                        parameter.type === 'array' ? 'Enter comma-separated values...' :
                        `Enter ${parameter.name}...`}
            rows={rows}
          />
          {(parameter.type === 'object' || parameter.type === 'array') && (
            <div className="text-xs text-muted-foreground">
              {parameter.type === 'object' ? 'JSON object format' : 'Comma-separated values'}
            </div>
          )}
        </div>
      );
    }

    // Default text input with enhanced styling
    return (
      <div className="space-y-1">
        <Input
          type="text"
          {...commonProps}
          value={value || ''}
          onChange={handleChange}
          className={error ? 'border-destructive' : ''}
          placeholder={`Enter ${parameter.name}...`}
        />
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={parameter.name} className="flex items-center gap-1">
        {parameter.name}
        {parameter.required && <span className="text-destructive" aria-label="required">*</span>}
      </Label>

      {renderInput()}

      {parameter.description && (
        <p id={`${parameter.name}-desc`} className="text-xs text-muted-foreground">
          {parameter.description}
        </p>
      )}

      {error && (
        <p id={`${parameter.name}-error`} className="text-xs font-medium text-destructive" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
});