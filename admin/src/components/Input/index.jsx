import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import * as uuidLib from 'uuid';
import {
  Field,
  Flex,
  IconButton,
  TextInput,
} from '@strapi/design-system';
import { ArrowClockwise, Duplicate, Check } from '@strapi/icons';

const { v4: uuidv4, validate: validateUuid } = uuidLib;
const uuidv7 = uuidLib.v7 || uuidv4;

/**
 * UUID Input Component for Strapi v5
 *
 * Respects per-field CTB options:
 * - uuid-version: 'v4' (default) or 'v7'
 * - uuid-prefix: optional prefix string
 * - disable-auto-generate: if true, no auto-generation on mount
 * - allow-edit: if true, field is not read-only
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

  const hasGeneratedRef = useRef(false);
  const previousValueRef = useRef(value);

  const fieldOptions = attribute?.options || {};
  const uuidVersion = fieldOptions['uuid-version'] || 'v4';
  const uuidPrefix = fieldOptions['uuid-prefix'] || '';
  const disableAutoGenerate = fieldOptions['disable-auto-generate'] === true;
  const allowEdit = fieldOptions['allow-edit'] === true;

  const generateNewUuid = useCallback(() => {
    const raw = uuidVersion === 'v7' ? uuidv7() : uuidv4();
    return uuidPrefix ? `${uuidPrefix}${raw}` : raw;
  }, [uuidVersion, uuidPrefix]);

  const handleChange = useCallback((newValue) => {
    onChange({ target: { name, type: attribute.type, value: newValue } });
  }, [onChange, name, attribute.type]);

  useEffect(() => {
    if (!value && !hasGeneratedRef.current && !disableAutoGenerate) {
      hasGeneratedRef.current = true;
      handleChange(generateNewUuid());
    }
  }, [value, handleChange, disableAutoGenerate, generateNewUuid]);

  useEffect(() => {
    if (value !== previousValueRef.current) {
      previousValueRef.current = value;

      if (value) {
        const rawUuid = uuidPrefix && value.startsWith(uuidPrefix)
          ? value.slice(uuidPrefix.length)
          : value;
        setInvalidUUID(!validateUuid(rawUuid));
      } else {
        setInvalidUUID(false);
      }
    }
  }, [value, uuidPrefix]);

  const handleRefresh = useCallback(() => {
    setIsGenerating(true);
    handleChange(generateNewUuid());
    setInvalidUUID(false);
    setTimeout(() => setIsGenerating(false), 150);
  }, [handleChange, generateNewUuid]);

  const handleCopy = useCallback(async () => {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      /* clipboard API not available in this context */
    }
  }, [value]);

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
              readOnly={!allowEdit}
              onChange={allowEdit ? (e) => handleChange(e.target.value) : undefined}
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
