import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Button, Field, Flex, Textarea, Typography } from '@strapi/design-system';
import { PLUGIN_ID } from '../../pluginId';
import { getTranslation } from '../../utils/getTranslation';
import { RepairDialog } from './RepairDialog';
import { parseMappings } from '../../utils/parseMappings';
import { VisuallyHiddenInput } from './styles';

/** Matches the server limit (about 1 MB request body by default). */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Import dialog: paste an export or choose the exported file, preview the
 * result, then confirm. Existing values are never replaced.
 *
 * @param {Object} props Props.
 * @param {React.ReactElement} props.trigger Card that opens the dialog.
 * @param {(result: Object) => void} props.onApplied Called after a successful import.
 * @param {(pending: boolean) => void} props.onPendingChange Reports running requests.
 * @param {boolean} props.disabled Disables the trigger.
 * @returns {JSX.Element} Dialog.
 */
export const ImportDialog = ({ trigger, onApplied, onPendingChange, disabled }) => {
  const { formatMessage } = useIntl();
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState(null);
  const [version, setVersion] = useState(0);
  const fileInput = useRef(null);
  const parsed = parseMappings(text);

  const update = (next) => {
    setText(next);
    setVersion((value) => value + 1);
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError(
        formatMessage({
          id: getTranslation('import.file.tooLarge'),
          defaultMessage:
            'The file is larger than 1 MB. Export again: the export is split into files that can be imported.',
        })
      );
      return;
    }
    setFileError(null);
    update(await file.text());
  };

  const parseError =
    parsed.error === 'json'
      ? formatMessage({
          id: getTranslation('import.error.json'),
          defaultMessage: 'This is not valid JSON.',
        })
      : parsed.error === 'shape'
        ? formatMessage({
            id: getTranslation('import.error.shape'),
            defaultMessage: 'This is not a UUID export: the "mappings" object is missing.',
          })
        : null;

  return (
    <RepairDialog
      trigger={trigger}
      disabled={disabled}
      onApplied={(result) => {
        update('');
        onApplied(result);
      }}
      onPendingChange={onPendingChange}
      resetKey={version}
      endpoint={`/${PLUGIN_ID}/migration/import`}
      buildBody={(dryRun) => (parsed.value ? { mappings: parsed.value, dryRun } : null)}
      title={formatMessage({ id: getTranslation('import.title'), defaultMessage: 'Import UUIDs' })}
      description={formatMessage({
        id: getTranslation('import.description'),
        defaultMessage:
          'Restore UUIDs from an export. Only empty fields are filled; a value that another entry uses is skipped.',
      })}
      confirmTitle={formatMessage({
        id: getTranslation('import.confirm'),
        defaultMessage: 'Import these UUIDs?',
      })}
      confirmBody={formatMessage({
        id: getTranslation('import.confirmBody'),
        defaultMessage:
          'Empty UUID fields get the values from the file. Existing values are not changed.',
      })}
      applyLabel={formatMessage({ id: getTranslation('import.apply'), defaultMessage: 'Import' })}
    >
      <Flex direction="column" alignItems="stretch" gap={3}>
        <Flex gap={3} wrap="wrap" alignItems="center">
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            {formatMessage({
              id: getTranslation('import.file.choose'),
              defaultMessage: 'Choose exported file',
            })}
          </Button>
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('import.file.hint'),
              defaultMessage: 'JSON, up to 1 MB',
            })}
          </Typography>
          <VisuallyHiddenInput
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            tabIndex={-1}
            aria-hidden
            onChange={onFile}
          />
        </Flex>
        <Field.Root
          name="mappings"
          error={fileError || parseError || undefined}
          hint={formatMessage({
            id: getTranslation('import.field.hint'),
            defaultMessage: 'Or paste the content of a file created with "Export UUIDs".',
          })}
        >
          <Field.Label>
            {formatMessage({
              id: getTranslation('import.field.label'),
              defaultMessage: 'Export content',
            })}
          </Field.Label>
          <Textarea
            value={text}
            onChange={(event) => update(event.target.value)}
            rows={8}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          />
          <Field.Hint />
          <Field.Error />
        </Field.Root>
      </Flex>
    </RepairDialog>
  );
};
