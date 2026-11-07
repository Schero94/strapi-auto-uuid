import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  Field,
  Flex,
  IconButton,
  TextInput,
} from '@strapi/design-system';
import { ArrowClockwise, Duplicate, Check } from '@strapi/icons';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  validateUuidFieldOptions,
} from '../../../../shared/uuid-field.js';
import { createUuidInputActions } from './actions.js';

/**
 * UUID Input Component for Strapi v5
 *
 * Respects per-field CTB options:
 * - uuid-version: 'v4' (default) or 'v7'
 * - uuid-prefix: optional 1-16 character prefix
 * - disable-auto-generate: if true, no auto-generation on mount
 * - allow-edit: if true, manual editing and regeneration are available
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
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const hasGeneratedRef = useRef(false);

  const fieldOptions = attribute?.options || {};
  const optionsResult = useMemo(
    () => validateUuidFieldOptions(fieldOptions),
    [
      fieldOptions['uuid-version'],
      fieldOptions['uuid-prefix'],
      fieldOptions['disable-auto-generate'],
      fieldOptions['allow-edit'],
    ]
  );
  const normalizedOptions = optionsResult.valid ? optionsResult.options : null;
  const disableAutoGenerate = normalizedOptions?.disableAutoGenerate === true;
  const allowEdit = normalizedOptions?.allowEdit === true;

  /** Creates a value matching the configured version and prefix. */
  const generateNewUuid = useCallback(() => {
    if (!normalizedOptions) return '';
    return generateUuidFieldValue(normalizedOptions);
  }, [normalizedOptions]);

  const inputActions = useMemo(
    () =>
      createUuidInputActions({
        allowEdit,
        options: normalizedOptions,
        generateValue: generateNewUuid,
        onChange,
        name,
        type: attribute?.type,
        value,
      }),
    [allowEdit, normalizedOptions, generateNewUuid, onChange, name, attribute?.type, value]
  );

  const handleChange = useCallback(
    (newValue) => {
      inputActions.change(newValue);
    },
    [inputActions]
  );

  useEffect(() => {
    if (!value && !hasGeneratedRef.current && !disableAutoGenerate && normalizedOptions) {
      hasGeneratedRef.current = true;
      handleChange(generateNewUuid());
    }
  }, [value, handleChange, disableAutoGenerate, generateNewUuid, normalizedOptions]);

  const handleRefresh = useCallback(() => {
    if (!inputActions.regenerate()) return;
    setIsGenerating(true);
    setTimeout(() => setIsGenerating(false), 150);
  }, [inputActions]);

  const handleCopy = useCallback(async () => {
    if (!(await inputActions.copy())) return;
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [inputActions]);

  const invalidUUID = Boolean(value && (!normalizedOptions || !isUuidFieldValue(value, normalizedOptions)));
  const fieldError = error || (!optionsResult.valid
    ? formatMessage({
        id: 'field-uuid.form.field.configError',
        defaultMessage: 'UUID field configuration is invalid. Check its version and prefix.',
      })
    : invalidUUID
    ? formatMessage({
        id: 'field-uuid.form.field.error',
        defaultMessage: 'The UUID value does not match this field version and prefix.',
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

          {allowEdit && (
            <IconButton
              onClick={handleRefresh}
              disabled={disabled || isGenerating || !normalizedOptions}
              aria-label={formatMessage({
                id: 'field-uuid.form.field.generate',
                defaultMessage: 'Generate new UUID',
              })}
              variant="secondary"
              withTooltip={false}
            >
              <ArrowClockwise />
            </IconButton>
          )}
        </Flex>

        <Field.Hint />
        <Field.Error />
      </Flex>
    </Field.Root>
  );
});

Input.displayName = 'UUIDInput';

export default Input;
