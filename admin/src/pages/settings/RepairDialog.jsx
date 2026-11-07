import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Alert, Box, Button, Dialog, Flex, Modal, Typography } from '@strapi/design-system';
import { ConfirmDialog, useFetchClient } from '@strapi/strapi/admin';
import { getTranslation } from '../../utils/getTranslation';
import {
  CODE_MESSAGES,
  countChanges,
  describeError,
  describeResult,
  summarizeErrors,
} from '../../utils/report';

/**
 * Two-step repair dialog: "Preview changes" runs a dry run and shows the
 * counts inside the dialog; "Apply" is enabled only after a preview with
 * changes and asks for confirmation before writing. The dialog stays open on
 * errors so the action can be retried. Focus returns to the trigger card.
 *
 * @param {Object} props Component props.
 * @param {React.ReactElement} props.trigger Card that opens the dialog.
 * @param {string} props.title Dialog title.
 * @param {string} props.description What the repair does.
 * @param {string} props.endpoint Admin API path (POST).
 * @param {(dryRun: boolean) => (Object|null)} props.buildBody Request body, or null when not ready.
 * @param {string} props.confirmTitle Confirmation question.
 * @param {string} props.confirmBody Consequences of applying.
 * @param {string} props.applyLabel Verb for the apply button.
 * @param {(result: Object) => void} props.onApplied Called after a successful write.
 * @param {(pending: boolean) => void} [props.onPendingChange] Reports running requests.
 * @param {boolean} [props.disabled] Disables the trigger.
 * @param {React.ReactNode} [props.children] Options shown above the preview.
 * @param {number} [props.resetKey] Changing it discards the preview (options changed).
 * @returns {JSX.Element} Dialog with trigger.
 */
export const RepairDialog = ({
  trigger,
  title,
  description,
  endpoint,
  buildBody,
  confirmTitle,
  confirmBody,
  applyLabel,
  onApplied,
  onPendingChange,
  disabled = false,
  children,
  resetKey = 0,
}) => {
  const { formatMessage } = useIntl();
  const { post } = useFetchClient();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewKey, setPreviewKey] = useState(null);
  const [error, setError] = useState(null);
  const wrapperRef = useRef(null);
  const restoreFocusRef = useRef(false);

  // The trigger card is disabled while a request runs, so the dialog cannot
  // hand focus back when it closes after "Apply". Return it once enabled.
  useEffect(() => {
    if (open || pending || disabled || !restoreFocusRef.current) return undefined;
    restoreFocusRef.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      wrapperRef.current?.querySelector('button')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pending, disabled]);

  const currentPreview = previewKey === resetKey ? preview : null;
  const changes = countChanges(currentPreview);
  const previewProblems = currentPreview ? summarizeErrors(currentPreview) : [];
  const previewBlocked = Boolean(currentPreview?.failed || currentPreview?.aborted);

  const setBusy = (value) => {
    setPending(value);
    onPendingChange?.(Boolean(value));
  };

  const reset = () => {
    setPreview(null);
    setPreviewKey(null);
    setError(null);
    setConfirmOpen(false);
  };

  const onOpenChange = (next) => {
    if (pending) return;
    setOpen(next);
    if (!next) {
      restoreFocusRef.current = true;
      reset();
    }
  };

  const request = async (dryRun) => {
    const body = buildBody(dryRun);
    if (!body) return null;
    const { data } = await post(endpoint, body);
    return data;
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const data = await request(true);
      if (data) {
        setPreview(data);
        setPreviewKey(resetKey);
      }
    } catch (err) {
      setError(formatMessage(describeError(err)));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy('apply');
    setError(null);
    try {
      const data = await request(false);
      if (!data) return;
      if (data.failed || data.aborted) {
        const [first] = summarizeErrors(data);
        setError(formatMessage(CODE_MESSAGES[first?.code] ?? CODE_MESSAGES.REPAIR_FAILED));
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      restoreFocusRef.current = true;
      setOpen(false);
      reset();
      onApplied(data);
    } catch (err) {
      setError(formatMessage(describeError(err)));
      setConfirmOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const lines = describeResult(currentPreview);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Box ref={wrapperRef} height="100%">
        <Modal.Trigger disabled={disabled}>{trigger}</Modal.Trigger>
      </Box>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={4}>
            <Typography tag="p" variant="omega" textColor="neutral700">
              {description}
            </Typography>
            {children}
            {error && (
              <Alert
                variant="danger"
                closeLabel={formatMessage({
                  id: getTranslation('common.close'),
                  defaultMessage: 'Close',
                })}
                onClose={() => setError(null)}
              >
                {error}
              </Alert>
            )}
            {currentPreview && (
              <Box background="neutral100" hasRadius padding={4} role="status" aria-live="polite">
                <Flex direction="column" alignItems="stretch" gap={2}>
                  <Typography variant="sigma" tag="h3" textColor="neutral600">
                    {formatMessage({
                      id: getTranslation('repair.preview.title'),
                      defaultMessage: 'Preview',
                    })}
                  </Typography>
                  {lines.map((line) => (
                    <Typography key={line.id} tag="p" variant="omega">
                      {formatMessage(
                        { id: line.id, defaultMessage: line.defaultMessage },
                        line.values
                      )}
                    </Typography>
                  ))}
                  {previewProblems.map(({ code, count }) => (
                    <Typography key={code} tag="p" variant="pi" textColor="danger600">
                      {formatMessage(CODE_MESSAGES[code] ?? CODE_MESSAGES.SCAN_FAILED)}
                      {count > 1 ? ` (${count})` : ''}
                    </Typography>
                  ))}
                </Flex>
              </Box>
            )}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary" disabled={Boolean(pending)}>
              {formatMessage({ id: getTranslation('common.cancel'), defaultMessage: 'Cancel' })}
            </Button>
          </Modal.Close>
          <Flex gap={2} wrap="wrap" justifyContent="flex-end">
            <Button
              variant="secondary"
              onClick={runPreview}
              loading={pending === 'preview'}
              disabled={Boolean(pending) || !buildBody(true)}
            >
              {formatMessage({
                id: getTranslation('repair.preview.action'),
                defaultMessage: 'Preview changes',
              })}
            </Button>
            <Dialog.Root
              open={confirmOpen}
              onOpenChange={(next) => !pending && setConfirmOpen(next)}
            >
              <Dialog.Trigger>
                <Button
                  variant="danger"
                  disabled={Boolean(pending) || changes === 0 || previewBlocked}
                >
                  {formatMessage(
                    {
                      id: getTranslation('repair.apply.action'),
                      defaultMessage: '{action} ({count})',
                    },
                    { action: applyLabel, count: changes }
                  )}
                </Button>
              </Dialog.Trigger>
              <ConfirmDialog
                title={confirmTitle}
                variant="danger"
                endAction={
                  <Button
                    fullWidth
                    variant="danger"
                    onClick={apply}
                    loading={pending === 'apply'}
                    disabled={Boolean(pending)}
                  >
                    {applyLabel}
                  </Button>
                }
              >
                {confirmBody}
              </ConfirmDialog>
            </Dialog.Root>
          </Flex>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};
