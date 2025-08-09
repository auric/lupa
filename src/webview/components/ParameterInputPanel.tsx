import React, { useState, useCallback, useEffect } from 'react';
import type { ToolInfo, FormValidationError } from '../types/toolTestingTypes';
import { Checkbox } from '../../components/ui/checkbox';

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
      <div className="parameter-panel-empty">
        <div className="empty-state">
          <div className="empty-state-icon">⚙️</div>
          <h3 className="empty-state-title">Select a Tool</h3>
          <p className="empty-state-description">
            Choose a tool from the sidebar to configure its parameters
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="parameter-panel">
      {/* Scrollable Content */}
      <div className="parameter-panel-scroll">
        {/* Tool Info Header */}
        <div className="tool-info-header">
          <div className="tool-name-section">
            <h2 className="tool-name">{toolInfo.name}</h2>
          </div>
          <p className="tool-description">{toolInfo.description}</p>
        </div>

        {/* Parameter Form */}
        <div className="parameter-form-container">
          <form className="parameter-form" onSubmit={(e) => { e.preventDefault(); handleExecute(); }}>

            {/* Required Parameters */}
            {requiredParams.length > 0 && (
              <div className="parameter-section">
                <h4 className="parameter-section-title">Required Parameters</h4>
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
              <div className="parameter-section">
                <button
                  type="button"
                  className="parameter-section-toggle"
                  onClick={() => setShowOptionalParams(!showOptionalParams)}
                  aria-expanded={showOptionalParams}
                >
                  <span className="toggle-icon">{showOptionalParams ? '▼' : '▶'}</span>
                  Optional Parameters ({optionalParams.length})
                </button>

                {showOptionalParams && (
                  <div className="optional-parameters">
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
      <div className="parameter-actions">
        {isExecuting ? (
          <button
            type="button"
            className="btn btn-cancel"
            onClick={onCancel}
          >
            <span className="loading-spinner"></span>
            Cancel
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleExecute}
              disabled={!isFormValid}
              title={!isFormValid ? 'Please fill in all required parameters' : 'Execute tool'}
            >
              Execute Tool
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClearForm}
            >
              Clear Form
            </button>
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
        <div className="toolTesting-checkboxWrapper">
          <Checkbox
            id={parameter.name}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(parameter.name, checked)}
            aria-describedby={parameter.description ? `${parameter.name}-desc` : undefined}
            className="toolTesting-checkbox"
          />
          <label
            htmlFor={parameter.name}
            className="toolTesting-checkboxLabel"
          >
            Enable {parameter.name}
          </label>
        </div>
      );
    }

    // Number inputs with enhanced styling
    if (parameter.type === 'number') {
      return (
        <div className="toolTesting-numberInputWrapper">
          <input
            type="number"
            {...commonProps}
            value={value !== undefined ? value : ''}
            onChange={handleChange}
            className={`toolTesting-numberInput ${error ? 'error' : ''}`}
            placeholder={`Enter ${parameter.name}...`}
            min={parameter.validation?.min}
            max={parameter.validation?.max}
            step="any"
          />
          {(parameter.validation?.min !== undefined || parameter.validation?.max !== undefined) && (
            <div className="toolTesting-inputHint">
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
        <div className="toolTesting-fileInputWrapper">
          <input
            type="text"
            {...commonProps}
            value={value || ''}
            onChange={handleChange}
            className={`toolTesting-fileInput ${error ? 'error' : ''}`}
            placeholder={`Enter file path...`}
          />
          <div className="toolTesting-inputHint">
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
        <div className="toolTesting-textareaWrapper">
          <textarea
            {...commonProps}
            value={value || ''}
            onChange={handleChange}
            className={`toolTesting-textarea ${error ? 'error' : ''}`}
            placeholder={parameter.type === 'object' ? 'Enter JSON object...' : 
                        parameter.type === 'array' ? 'Enter comma-separated values...' :
                        `Enter ${parameter.name}...`}
            rows={rows}
          />
          {(parameter.type === 'object' || parameter.type === 'array') && (
            <div className="toolTesting-inputHint">
              {parameter.type === 'object' ? 'JSON object format' : 'Comma-separated values'}
            </div>
          )}
        </div>
      );
    }

    // Default text input with enhanced styling
    return (
      <div className="toolTesting-textInputWrapper">
        <input
          type="text"
          {...commonProps}
          value={value || ''}
          onChange={handleChange}
          className={`toolTesting-textInput ${error ? 'error' : ''}`}
          placeholder={`Enter ${parameter.name}...`}
        />
      </div>
    );
  };

  return (
    <div className="parameter-field toolTesting-parameterField">
      <label htmlFor={parameter.name} className="parameter-label toolTesting-parameterLabel">
        {parameter.name}
        {parameter.required && <span className="required-indicator toolTesting-requiredIndicator" aria-label="required">*</span>}
      </label>

      {renderInput()}

      {parameter.description && (
        <p id={`${parameter.name}-desc`} className="parameter-description toolTesting-parameterDescription">
          {parameter.description}
        </p>
      )}

      {error && (
        <p id={`${parameter.name}-error`} className="parameter-error toolTesting-parameterError" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
});