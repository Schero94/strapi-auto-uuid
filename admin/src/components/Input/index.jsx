import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Box, Button, Dialog, Field, Flex, IconButton, TextInput } from '@strapi/design-system';
import { ArrowClockwise, Check, Duplicate } from '@strapi/icons';
import { ConfirmDialog, useClipboard, useNotification } from '@strapi/strapi/admin';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  validateUuidFieldOptions,
} from '../../../../shared/uuid-field.js';
import { getTranslation } from '../../utils/getTranslation';
import { createUuidInputActions, getUuidInputState } from './actions.js';

const MONO_STYLE = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' };

/**
 * Content Manager input for the UUID custom field.
 *
 * Honours the field options (version, prefix, auto-generation, manual
 * editing). The server is authoritative: it generates missing values on save
 * and validates every change, so this input never writes on mount.
 *
 * @param {Object} props Strapi custom field input props.
 * @param {React.Ref<HTMLInputElement>} ref Forwarded input ref.
 * @returns {JSX.Element} The field.
 */
const Input = forwardRef(function UuidInput(props, ref) {
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
  const { copy } = useClipboard();
  const { toggleNotification } = useNotification();
  const [isCopied, setIsCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The value the entry had when the form was opened.
  const [savedValue] = useState(value);
  const copiedTimer = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const version = attribute?.options?.['uuid-version'];
  const prefix = attribute?.options?.['uuid-prefix'];
  const disableAutoGenerate = attribute?.options?.['disable-auto-generate'];
  const allowEdit = attribute?.options?.['allow-edit'];
  const optionsResult = useMemo(
    () =>
      validateUuidFieldOptions({
        'uuid-version': version,
        'uuid-prefix': prefix,
        'disable-auto-generate': disableAutoGenerate,
        'allow-edit': allowEdit,
      }),
    [version, prefix, disableAutoGenerate, allowEdit]
  );
  const options = optionsResult.valid ? optionsResult.options : null;
  const state = getUuidInputState({
    options,
    savedValue: savedValue,
    disabled,
  });

  const actions = createUuidInputActions({
    allowEdit: state.canGenerate,
    options,
    generateValue: () => generateUuidFieldValue(options),
    onChange,
    name,
    type: attribute?.type,
    value,
    clipboard: {
      writeText: async (text) => {
        if (!(await copy(text))) throw new Error('copy failed');
      },
    },
  });

  const handleCopy = async () => {
    const copied = await actions.copy();
    if (!copied) {
      toggleNotification({
        type: 'warning',
        message: formatMessage({
          id: getTranslation('form.field.copyFailed'),
          defaultMessage: 'The UUID could not be copied. Select the value and copy it manually.',
        }),
      });
      return;
    }
    toggleNotification({
      type: 'success',
      message: formatMessage({
        id: getTranslation('form.field.copied'),
        defaultMessage: 'UUID copied.',
      }),
    });
    setIsCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setIsCopied(false), 2000);
  };

  const handleGenerate = () => {
    if (state.confirmReplace && value === savedValue) {
      setConfirmOpen(true);
      return;
    }
    actions.regenerate();
  };

  const invalid = Boolean(value) && (!options || !isUuidFieldValue(value, options));
  const fieldError =
    error ||
    (!options
      ? formatMessage({
          id: getTranslation('form.field.configError'),
          defaultMessage: 'The UUID field configuration is invalid. Check its version and prefix.',
        })
      : invalid && value !== savedValue
        ? formatMessage({
            id: getTranslation('form.field.error'),
            defaultMessage: "The value does not match this field's UUID version and prefix.",
          })
        : undefined);

  const placeholder =
    state.placeholder === 'enterManually'
      ? formatMessage({
          id: getTranslation('form.placeholder.manual'),
          defaultMessage: 'Enter a UUID',
        })
      : state.placeholder === 'generatedOnSave'
        ? formatMessage({
            id: getTranslation('form.placeholder'),
            defaultMessage: 'Generated when the entry is saved',
          })
        : undefined;

  const generateLabel = formatMessage({
    id: getTranslation('form.field.generate'),
    defaultMessage: 'Generate a new UUID',
  });

  return (
    <Field.Root name={name} id={name} error={fieldError} hint={hint} required={required}>
      <Flex direction="column" alignItems="stretch" gap={1}>
        <Field.Label action={labelAction}>
          {label || formatMessage({ id: getTranslation('form.label'), defaultMessage: 'UUID' })}
        </Field.Label>

        <Flex gap={2} alignItems="flex-start">
          <Box flex="1" minWidth={0}>
            <TextInput
              ref={ref}
              name={name}
              value={value ?? ''}
              disabled={disabled}
              readOnly={!state.editable}
              onChange={state.editable ? (event) => actions.change(event.target.value) : undefined}
              placeholder={placeholder}
              style={MONO_STYLE}
            />
          </Box>

          <IconButton
            onClick={handleCopy}
            disabled={!value}
            label={formatMessage({
              id: getTranslation('form.field.copy'),
              defaultMessage: 'Copy UUID',
            })}
            variant="secondary"
            size="M"
          >
            {isCopied ? <Check aria-hidden /> : <Duplicate aria-hidden />}
          </IconButton>

          {state.canGenerate && (
            <IconButton
              onClick={handleGenerate}
              disabled={!options}
              label={generateLabel}
              variant="secondary"
              size="M"
            >
              <ArrowClockwise aria-hidden />
            </IconButton>
          )}
        </Flex>

        <Field.Hint />
        <Field.Error />
      </Flex>

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ConfirmDialog
          title={formatMessage({
            id: getTranslation('form.confirm.title'),
            defaultMessage: 'Replace this UUID?',
          })}
          variant="danger-light"
          endAction={
            <Button
              fullWidth
              variant="danger-light"
              onClick={() => {
                actions.regenerate();
                setConfirmOpen(false);
              }}
            >
              {formatMessage({
                id: getTranslation('form.confirm.action'),
                defaultMessage: 'Replace UUID',
              })}
            </Button>
          }
        >
          {formatMessage({
            id: getTranslation('form.confirm.body'),
            defaultMessage:
              'Links and integrations that use the current value stop working after the entry is saved.',
          })}
        </ConfirmDialog>
      </Dialog.Root>
    </Field.Root>
  );
});

export default Input;
