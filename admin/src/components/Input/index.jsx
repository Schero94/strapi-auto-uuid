'use strict';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { v4 as uuidv4, validate as validateUuid } from 'uuid';
import {
  Field,
  Flex,
  IconButton,
  TextInput,
} from '@strapi/design-system';
import { ArrowClockwise, Duplicate, Check } from '@strapi/icons';

/**
 * UUID Input Component for Strapi v5
 * 
 * Provides a read-only input field that displays a UUID v4.
 * Features:
 * - Auto-generates UUID if empty
 * - Validates existing UUID format
 * - Refresh button to generate new UUID
 * - Copy button to copy UUID to clipboard
 * - Read-only to prevent manual editing
 */
const Input = React.forwardRef((props, forwardedRef) => {
  const {
    attribute,
    disabled,
    error,
    hint,
    label,
    labelAction,
    name,
    onChange,
    required,
    value = '',
  } = props;

  const { formatMessage } = useIntl();
  const [invalidUUID, setInvalidUUID] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  // Track if we've already generated a UUID on mount to prevent loops
  const hasGeneratedRef = useRef(false);
  const previousValueRef = useRef(value);

  // Memoized change handler to avoid dependency issues
  const handleChange = useCallback((newValue) => {
    onChange({ target: { name, type: attribute.type, value: newValue } });
  }, [onChange, name, attribute.type]);

  // Generate UUID on mount if empty (runs only once)
  useEffect(() => {
    if (!value && !hasGeneratedRef.current) {
      hasGeneratedRef.current = true;
      const newUUID = uuidv4();
      handleChange(newUUID);
    }
  }, [value, handleChange]);

  // Validate UUID format when value changes
  useEffect(() => {
    if (value !== previousValueRef.current) {
      previousValueRef.current = value;
      
      if (value) {
        const isValid = validateUuid(value);
        setInvalidUUID(!isValid);
      } else {
        setInvalidUUID(false);
      }
    }
  }, [value]);

  // Generate new UUID
  const handleRefresh = useCallback(() => {
    setIsGenerating(true);
    const newUUID = uuidv4();
    handleChange(newUUID);
    setInvalidUUID(false);
    // Brief visual feedback
    setTimeout(() => setIsGenerating(false), 150);
  }, [handleChange]);

  // Copy UUID to clipboard
  const handleCopy = useCallback(async () => {
    if (!value) return;
    
    try {
      await navigator.clipboard.writeText(value);
      setIsCopied(true);
      // Reset after 2 seconds
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = value;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  }, [value]);

  // Build error message
  const fieldError = error || (invalidUUID
    ? formatMessage({
        id: 'field-uuid.form.field.error',
        defaultMessage: 'The UUID format is invalid.',
      })
    : null);

  return (
    <Field.Root
      name={name}
      id={name}
      error={fieldError}
      hint={hint}
      required={required}
    >
      <Flex direction="column" alignItems="stretch" gap={1}>
        <Field.Label action={labelAction}>
          {label || formatMessage({
            id: 'field-uuid.form.label',
            defaultMessage: 'UUID',
          })}
        </Field.Label>
        
        <Flex gap={2}>
          <div style={{ flex: 1 }}>
            <TextInput
              ref={forwardedRef}
              name={name}
              value={value}
              disabled={disabled}
              readOnly
              placeholder={formatMessage({
                id: 'field-uuid.form.placeholder',
                defaultMessage: 'UUID will be auto-generated',
              })}
              aria-label={formatMessage({
                id: 'field-uuid.form.label',
                defaultMessage: 'UUID',
              })}
              style={{
                fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace",
                letterSpacing: '0.5px',
              }}
            />
          </div>
          
          {/* Copy Button */}
          <IconButton
            onClick={handleCopy}
            disabled={disabled || !value}
            aria-label={formatMessage({
              id: 'field-uuid.form.field.copy',
              defaultMessage: 'Copy UUID to clipboard',
            })}
            variant={isCopied ? 'success' : 'secondary'}
            withTooltip={false}
            style={isCopied ? { 
              background: '#16A34A', 
              color: 'white',
              transition: 'all 0.2s ease',
            } : {}}
          >
            {isCopied ? <Check /> : <Duplicate />}
          </IconButton>
          
          {/* Refresh Button */}
          <IconButton
            onClick={handleRefresh}
            disabled={disabled || isGenerating}
            aria-label={formatMessage({
              id: 'field-uuid.form.field.generate',
              defaultMessage: 'Generate new UUID',
            })}
            variant="secondary"
            withTooltip={false}
          >
            <ArrowClockwise />
          </IconButton>
        </Flex>
        
        <Field.Hint />
        <Field.Error />
      </Flex>
    </Field.Root>
  );
});

Input.displayName = 'UUIDInput';

export default Input;
