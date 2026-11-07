/**
 * Settings > Auto UUID > UUID management.
 *
 * Shows the state of every UUID field (counts per content type), runs the
 * check, the repairs (with preview and confirmation) and the export/import
 * of UUID mappings. Each action is shown only to roles with the matching
 * permission; the server enforces the same permissions on every route.
 */
import { forwardRef, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { Alert, Badge, Box, Button, Checkbox, Flex, Grid, Typography } from '@strapi/design-system';
import {
  ArrowClockwise,
  Check,
  Download,
  Plus,
  Search,
  Sparkle,
  Upload,
  WarningCircle,
} from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification, useRBAC } from '@strapi/strapi/admin';
import { PLUGIN_ID } from '../pluginId';
import { getTranslation } from '../utils/getTranslation';
import { ALL_PERMISSIONS } from '../utils/permissions';
import { countChanges, describeError } from '../utils/report';
import { ImportDialog } from './settings/ImportDialog';
import { RepairDialog } from './settings/RepairDialog';
import {
  ActionCardButton,
  ActionIcon,
  Card,
  Fieldset,
  HeroBadge,
  HeroBanner,
  HeroText,
  ModelList,
  ModelRow,
  Mono,
} from './settings/styles';

const BADGE_TONES = {
  success: { backgroundColor: 'success100', textColor: 'success700' },
  warning: { backgroundColor: 'warning100', textColor: 'neutral800' },
  danger: { backgroundColor: 'danger100', textColor: 'danger700' },
  neutral: { backgroundColor: 'neutral150', textColor: 'neutral700' },
};

/**
 * @param {number|null|undefined} count Issue count.
 * @param {'warning'|'danger'} badTone Tone when the count is above zero.
 * @returns {'success'|'warning'|'danger'|'neutral'} Badge tone.
 */
const toneFor = (count, badTone) =>
  count === null || count === undefined ? 'neutral' : count > 0 ? badTone : 'success';

/**
 * Card with one counter and a text status, so meaning never depends on colour.
 *
 * @param {Object} props Props.
 * @returns {JSX.Element} Stat card.
 */
const StatCard = ({ label, value, tone, statusLabel, hint }) => {
  const { formatMessage } = useIntl();
  const known = value !== null && value !== undefined;
  return (
    <Card>
      <Flex direction="column" alignItems="flex-start" gap={2}>
        <Typography variant="sigma" tag="h3" textColor="neutral600">
          {label}
        </Typography>
        <Typography variant="alpha" tag="p" textColor="neutral800">
          {known ? (
            value
          ) : (
            <span
              aria-label={formatMessage({
                id: getTranslation('common.notAvailable'),
                defaultMessage: 'Not available',
              })}
            >
              —
            </span>
          )}
        </Typography>
        {statusLabel && <Badge {...BADGE_TONES[tone]}>{statusLabel}</Badge>}
        {hint && (
          <Typography variant="pi" textColor="neutral600">
            {hint}
          </Typography>
        )}
      </Flex>
    </Card>
  );
};

/**
 * Action card button. It forwards its ref because dialog triggers (Radix
 * `asChild`) attach their ref and focus handling to it.
 *
 * @param {Object} props Props.
 * @param {React.Ref<HTMLButtonElement>} ref Forwarded ref.
 * @returns {JSX.Element} Card button.
 */
const ActionCard = forwardRef(function ActionCard(
  { icon: Icon, tone, title, description, ...rest },
  ref
) {
  return (
    <ActionCardButton ref={ref} type="button" $tone={tone} {...rest}>
      <ActionIcon $tone={tone} aria-hidden>
        <Icon />
      </ActionIcon>
      <Typography variant="delta" tag="span" textColor="neutral800">
        {title}
      </Typography>
      <Typography variant="omega" tag="span" textColor="neutral600">
        {description}
      </Typography>
    </ActionCardButton>
  );
});

const SettingsPage = () => {
  const { formatMessage } = useIntl();
  const { get } = useFetchClient();
  const { toggleNotification } = useNotification();
  const headingId = useId();
  const {
    allowedActions: { canRead, canMigrate, canExport, canImport },
    isLoading: isLoadingPermissions,
  } = useRBAC(ALL_PERMISSIONS);

  const [stats, setStats] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [repairOptions, setRepairOptions] = useState({
    fixEmpty: true,
    fixInvalid: true,
    fixDuplicates: true,
    fixLegacy: false,
  });
  const [optionsVersion, setOptionsVersion] = useState(0);
  const [dismissed, setDismissed] = useState({});

  const t = (descriptor, values) => formatMessage(descriptor, values);
  const closeLabel = formatMessage({ id: getTranslation('common.close'), defaultMessage: 'Close' });
  const dismiss = (key) => () => setDismissed((prev) => ({ ...prev, [key]: true }));

  /** Loads the counts per field and the list of UUID fields. */
  const loadStats = useCallback(async () => {
    const { data } = await get(`/${PLUGIN_ID}/stats`);
    setStats(data);
    return data;
  }, [get]);

  useEffect(() => {
    if (isLoadingPermissions || !canRead) return undefined;
    let cancelled = false;
    get(`/${PLUGIN_ID}/stats`).then(
      ({ data }) => {
        if (cancelled) return;
        setStats(data);
        setLoadState('ready');
      },
      () => {
        if (!cancelled) setLoadState('error');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isLoadingPermissions, canRead, get]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadStats();
      setLoadState('ready');
      setChecked(false);
    } catch (err) {
      setLoadState((state) => (state === 'ready' ? state : 'error'));
      toggleNotification({ type: 'danger', message: t(describeError(err)) });
    } finally {
      setRefreshing(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      await get(`/${PLUGIN_ID}/diagnose`);
      const data = await loadStats();
      setChecked(true);
      toggleNotification({
        type: data?.hasErrors ? 'warning' : 'success',
        message: data?.hasErrors
          ? t({
              id: getTranslation('check.incomplete'),
              defaultMessage: 'Check finished, but some fields could not be checked.',
            })
          : t({ id: getTranslation('check.done'), defaultMessage: 'Check finished.' }),
      });
    } catch (err) {
      toggleNotification({ type: 'danger', message: t(describeError(err)) });
    } finally {
      setChecking(false);
    }
  };

  const onApplied = async (result) => {
    toggleNotification({
      type: 'success',
      message: t(
        {
          id: getTranslation('repair.applied'),
          defaultMessage:
            '{count, plural, =0 {No changes were needed.} one {# change saved.} other {# changes saved.}}',
        },
        { count: countChanges(result) }
      ),
    });
    try {
      await loadStats();
    } catch {
      setLoadState('error');
    }
  };

  const exportMappings = async () => {
    setExporting(true);
    try {
      const { data } = await get(`/${PLUGIN_ID}/migration/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `uuid-mappings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toggleNotification({
        type: 'success',
        message: t({
          id: getTranslation('export.done'),
          defaultMessage: 'UUID mappings exported.',
        }),
      });
    } catch (err) {
      toggleNotification({ type: 'danger', message: t(describeError(err)) });
    } finally {
      setExporting(false);
    }
  };

  const title = t({ id: getTranslation('settings.title'), defaultMessage: 'UUID management' });

  if (isLoadingPermissions) return <Page.Loading />;
  if (!canRead) return <Page.NoPermissions />;
  if (loadState === 'loading') return <Page.Loading />;

  const models = stats?.models ?? {};
  const modelEntries = Object.entries(models);
  const fieldStats = stats?.fields ?? [];
  const issues = stats?.issues ?? {};
  const scanHasErrors = Boolean(stats?.hasErrors);
  const needsRepair = Boolean(stats?.needsMigration) && !scanHasErrors;
  const anyPending = busy || checking || exporting || refreshing;

  const okLabel = t({ id: getTranslation('status.ok'), defaultMessage: 'OK' });
  const repairLabel = t({
    id: getTranslation('status.needsRepair'),
    defaultMessage: 'Needs repair',
  });
  const statusLabel = (count) =>
    count === null || count === undefined ? null : count > 0 ? repairLabel : okLabel;

  const toggleOption = (key) => (checkedValue) => {
    setRepairOptions((prev) => ({ ...prev, [key]: checkedValue === true }));
    setOptionsVersion((value) => value + 1);
  };
  const anyOption = Object.values(repairOptions).some(Boolean);

  const repairCommon = {
    onApplied,
    onPendingChange: setBusy,
    disabled: anyPending || scanHasErrors,
    applyLabel: t({ id: getTranslation('repair.apply.verb'), defaultMessage: 'Apply' }),
    confirmBody: t({
      id: getTranslation('repair.confirm.body'),
      defaultMessage:
        'Replaced UUIDs are gone for good: links, integrations and exports that use them stop working. Create a database backup or a UUID export first. This cannot be undone.',
    }),
  };

  return (
    <Page.Main aria-labelledby={headingId}>
      <Page.Title>{title}</Page.Title>
      <Layouts.Header
        id={headingId}
        title={title}
        subtitle={t({
          id: getTranslation('settings.subtitle'),
          defaultMessage: 'Check, repair and back up the UUID fields of all content types',
        })}
        primaryAction={
          <Button
            variant="secondary"
            startIcon={<ArrowClockwise aria-hidden />}
            onClick={refresh}
            loading={refreshing}
            disabled={anyPending && !refreshing}
          >
            {t({ id: getTranslation('settings.refresh'), defaultMessage: 'Refresh' })}
          </Button>
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6} paddingBottom={8} minWidth={0}>
          {loadState === 'error' && !dismissed.load && (
            <Alert
              closeLabel={closeLabel}
              onClose={dismiss('load')}
              variant="danger"
              title={t({
                id: getTranslation('load.error.title'),
                defaultMessage: 'The UUID status could not be loaded',
              })}
              action={
                <Button variant="danger-light" size="S" onClick={refresh} loading={refreshing}>
                  {t({ id: getTranslation('common.retry'), defaultMessage: 'Try again' })}
                </Button>
              }
            >
              {t({
                id: getTranslation('load.error.body'),
                defaultMessage: 'No repairs ran. Check the connection and try again.',
              })}
            </Alert>
          )}

          <HeroBanner aria-labelledby={`${headingId}-hero`}>
            <Flex justifyContent="space-between" alignItems="flex-start" gap={4} wrap="wrap">
              <Flex
                direction="column"
                alignItems="flex-start"
                gap={2}
                minWidth={0}
                flex="1 1 28rem"
              >
                <HeroText $size={1} $bold>
                  {t({ id: getTranslation('hero.eyebrow'), defaultMessage: 'Strapi Auto UUID' })}
                </HeroText>
                <HeroText as="h2" id={`${headingId}-hero`} $size={5} $bold>
                  {t({
                    id: getTranslation('hero.title'),
                    defaultMessage: 'Stable identifiers for your content',
                  })}
                </HeroText>
                <HeroText $size={2}>
                  {t({
                    id: getTranslation('hero.body'),
                    defaultMessage:
                      'Every entry gets a UUID on save. Duplicates are rejected, and values that should not change stay locked.',
                  })}
                </HeroText>
              </Flex>
              {stats?.version && <HeroBadge>v{stats.version}</HeroBadge>}
            </Flex>
          </HeroBanner>

          {scanHasErrors && !dismissed.scan && (
            <Alert
              closeLabel={closeLabel}
              onClose={dismiss('scan')}
              variant="warning"
              title={t({
                id: getTranslation('scan.incomplete.title'),
                defaultMessage: 'Some UUID fields could not be checked',
              })}
            >
              {t({
                id: getTranslation('scan.incomplete.body'),
                defaultMessage:
                  'Repairs are paused until every field can be checked. Review the field options in the Content-Type Builder, then refresh.',
              })}
            </Alert>
          )}

          {needsRepair && !dismissed.repair && (
            <Alert
              closeLabel={closeLabel}
              onClose={dismiss('repair')}
              variant="warning"
              title={t({
                id: getTranslation('repair.needed.title'),
                defaultMessage: 'Repair needed',
              })}
            >
              {t({
                id: getTranslation('repair.needed.body'),
                defaultMessage:
                  'Some entries have duplicate, malformed or missing UUIDs. Use "Repair all" to preview the changes.',
              })}
            </Alert>
          )}

          <Box tag="section" aria-labelledby={`${headingId}-stats`}>
            <Typography variant="delta" tag="h2" id={`${headingId}-stats`} textColor="neutral800">
              {t({ id: getTranslation('stats.title'), defaultMessage: 'Overview' })}
            </Typography>
            <Box paddingTop={4}>
              <Grid.Root gap={4}>
                {[
                  {
                    key: 'models',
                    label: t({
                      id: getTranslation('stats.models'),
                      defaultMessage: 'Content types',
                    }),
                    value: stats?.contentTypes,
                  },
                  {
                    key: 'fields',
                    label: t({ id: getTranslation('stats.fields'), defaultMessage: 'UUID fields' }),
                    value: stats?.totalFields,
                  },
                  {
                    key: 'entries',
                    label: t({ id: getTranslation('stats.entries'), defaultMessage: 'Entries' }),
                    value: stats?.totalEntries,
                  },
                  {
                    key: 'duplicates',
                    label: t({
                      id: getTranslation('stats.duplicates'),
                      defaultMessage: 'Duplicates',
                    }),
                    value: issues.duplicates,
                    tone: toneFor(issues.duplicates, 'danger'),
                    status: statusLabel(issues.duplicates),
                  },
                  {
                    key: 'empty',
                    label: t({ id: getTranslation('stats.empty'), defaultMessage: 'Empty' }),
                    value: issues.empty,
                    tone: toneFor(issues.empty, 'warning'),
                    status: statusLabel(issues.empty),
                  },
                  {
                    key: 'invalid',
                    label: t({ id: getTranslation('stats.invalid'), defaultMessage: 'Malformed' }),
                    value: issues.invalid,
                    tone: toneFor(issues.invalid, 'danger'),
                    status: statusLabel(issues.invalid),
                    hint:
                      issues.legacy > 0
                        ? t(
                            {
                              id: getTranslation('stats.legacy'),
                              defaultMessage:
                                '{count, plural, one {# value uses an older version or prefix} other {# values use an older version or prefix}}',
                            },
                            { count: issues.legacy }
                          )
                        : null,
                  },
                ].map(({ key, ...card }) => (
                  <Grid.Item
                    key={key}
                    col={4}
                    s={6}
                    xs={12}
                    direction="column"
                    alignItems="stretch"
                  >
                    <StatCard
                      label={card.label}
                      value={card.value}
                      tone={card.tone}
                      statusLabel={card.status}
                      hint={card.hint}
                    />
                  </Grid.Item>
                ))}
              </Grid.Root>
            </Box>
          </Box>

          <Box tag="section" aria-labelledby={`${headingId}-actions`}>
            <Typography variant="delta" tag="h2" id={`${headingId}-actions`} textColor="neutral800">
              {t({ id: getTranslation('actions.title'), defaultMessage: 'Actions' })}
            </Typography>
            <Box paddingTop={4}>
              <Grid.Root gap={4}>
                <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                  <ActionCard
                    icon={Search}
                    tone="primary"
                    onClick={runCheck}
                    disabled={anyPending}
                    aria-busy={checking}
                    title={t({ id: getTranslation('actions.check'), defaultMessage: 'Run check' })}
                    description={t({
                      id: getTranslation('actions.check.description'),
                      defaultMessage:
                        'Scan every UUID field, in all locales and in drafts and published versions.',
                    })}
                  />
                </Grid.Item>

                {canMigrate && (
                  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                    <RepairDialog
                      {...repairCommon}
                      endpoint={`/${PLUGIN_ID}/migration/run`}
                      buildBody={(dryRun) => (anyOption ? { dryRun, ...repairOptions } : null)}
                      resetKey={optionsVersion}
                      title={t({
                        id: getTranslation('repair.all.title'),
                        defaultMessage: 'Repair all',
                      })}
                      description={t({
                        id: getTranslation('repair.all.description'),
                        defaultMessage:
                          'Choose what to repair, preview the changes, then apply them. The oldest entry keeps a shared UUID; draft and published versions stay in sync.',
                      })}
                      confirmTitle={t({
                        id: getTranslation('repair.all.confirm'),
                        defaultMessage: 'Apply these UUID repairs?',
                      })}
                      trigger={
                        <ActionCard
                          icon={Sparkle}
                          tone="alternative"
                          title={t({
                            id: getTranslation('repair.all.title'),
                            defaultMessage: 'Repair all',
                          })}
                          description={t({
                            id: getTranslation('actions.repair.description'),
                            defaultMessage:
                              'Replace duplicate and malformed UUIDs and fill empty fields in one run.',
                          })}
                        />
                      }
                    >
                      <Fieldset>
                        <Typography variant="sigma" tag="legend" textColor="neutral600">
                          {t({ id: getTranslation('repair.options'), defaultMessage: 'Repair' })}
                        </Typography>
                        <Checkbox
                          checked={repairOptions.fixDuplicates}
                          onCheckedChange={toggleOption('fixDuplicates')}
                        >
                          {t({
                            id: getTranslation('repair.option.duplicates'),
                            defaultMessage: 'Duplicate UUIDs',
                          })}
                        </Checkbox>
                        <Checkbox
                          checked={repairOptions.fixInvalid}
                          onCheckedChange={toggleOption('fixInvalid')}
                        >
                          {t({
                            id: getTranslation('repair.option.invalid'),
                            defaultMessage: 'Malformed values',
                          })}
                        </Checkbox>
                        <Checkbox
                          checked={repairOptions.fixEmpty}
                          onCheckedChange={toggleOption('fixEmpty')}
                        >
                          {t({
                            id: getTranslation('repair.option.empty'),
                            defaultMessage: 'Empty fields',
                          })}
                        </Checkbox>
                        <Checkbox
                          checked={repairOptions.fixLegacy}
                          onCheckedChange={toggleOption('fixLegacy')}
                        >
                          {t({
                            id: getTranslation('repair.option.legacy'),
                            defaultMessage: 'Values in an older version or prefix (usually kept)',
                          })}
                        </Checkbox>
                        {!anyOption && (
                          <Typography variant="pi" textColor="danger600">
                            {t({
                              id: getTranslation('repair.option.required'),
                              defaultMessage: 'Select at least one option.',
                            })}
                          </Typography>
                        )}
                      </Fieldset>
                    </RepairDialog>
                  </Grid.Item>
                )}

                {canMigrate && (
                  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                    <RepairDialog
                      {...repairCommon}
                      endpoint={`/${PLUGIN_ID}/autofix`}
                      buildBody={(dryRun) => ({ dryRun })}
                      title={t({
                        id: getTranslation('repair.duplicates.title'),
                        defaultMessage: 'Replace duplicates',
                      })}
                      description={t({
                        id: getTranslation('repair.duplicates.description'),
                        defaultMessage:
                          'When several entries share a UUID, the oldest keeps it and the others get a new one.',
                      })}
                      confirmTitle={t({
                        id: getTranslation('repair.duplicates.confirm'),
                        defaultMessage: 'Replace the duplicate UUIDs?',
                      })}
                      trigger={
                        <ActionCard
                          icon={WarningCircle}
                          tone="danger"
                          title={t({
                            id: getTranslation('repair.duplicates.title'),
                            defaultMessage: 'Replace duplicates',
                          })}
                          description={t({
                            id: getTranslation('actions.duplicates.description'),
                            defaultMessage:
                              'Give every entry that shares a UUID with an older entry a new one.',
                          })}
                        />
                      }
                    />
                  </Grid.Item>
                )}

                {canMigrate && (
                  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                    <RepairDialog
                      {...repairCommon}
                      endpoint={`/${PLUGIN_ID}/generate-missing`}
                      buildBody={(dryRun) => ({ dryRun })}
                      title={t({
                        id: getTranslation('repair.missing.title'),
                        defaultMessage: 'Generate missing UUIDs',
                      })}
                      description={t({
                        id: getTranslation('repair.missing.description'),
                        defaultMessage:
                          'Fill empty UUID fields. Fields with auto-generation turned off are left empty.',
                      })}
                      confirmTitle={t({
                        id: getTranslation('repair.missing.confirm'),
                        defaultMessage: 'Generate the missing UUIDs?',
                      })}
                      confirmBody={t({
                        id: getTranslation('repair.missing.confirmBody'),
                        defaultMessage:
                          'Empty UUID fields get a new value. Existing values are not changed.',
                      })}
                      trigger={
                        <ActionCard
                          icon={Plus}
                          tone="success"
                          title={t({
                            id: getTranslation('repair.missing.title'),
                            defaultMessage: 'Generate missing UUIDs',
                          })}
                          description={t({
                            id: getTranslation('actions.missing.description'),
                            defaultMessage:
                              'Fill entries that were created before the UUID field existed.',
                          })}
                        />
                      }
                    />
                  </Grid.Item>
                )}

                {canExport && (
                  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                    <ActionCard
                      icon={Download}
                      tone="secondary"
                      onClick={exportMappings}
                      disabled={anyPending}
                      aria-busy={exporting}
                      title={t({
                        id: getTranslation('actions.export'),
                        defaultMessage: 'Export UUIDs',
                      })}
                      description={t({
                        id: getTranslation('actions.export.description'),
                        defaultMessage: 'Download every UUID with its entry as a JSON backup.',
                      })}
                    />
                  </Grid.Item>
                )}

                {canImport && (
                  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                    <ImportDialog
                      onApplied={onApplied}
                      onPendingChange={setBusy}
                      disabled={anyPending}
                      trigger={
                        <ActionCard
                          icon={Upload}
                          tone="warning"
                          title={t({
                            id: getTranslation('actions.import'),
                            defaultMessage: 'Import UUIDs',
                          })}
                          description={t({
                            id: getTranslation('actions.import.description'),
                            defaultMessage: 'Restore UUIDs from an export into empty fields.',
                          })}
                        />
                      }
                    />
                  </Grid.Item>
                )}
              </Grid.Root>
            </Box>
          </Box>

          <Box tag="section" aria-labelledby={`${headingId}-models`}>
            <Typography variant="delta" tag="h2" id={`${headingId}-models`} textColor="neutral800">
              {t({
                id: getTranslation('models.title'),
                defaultMessage: 'Content types with UUID fields',
              })}
            </Typography>
            <Box paddingTop={4}>
              {modelEntries.length === 0 ? (
                <Card>
                  <Typography tag="p" variant="omega" textColor="neutral600">
                    {loadState === 'error'
                      ? t({
                          id: getTranslation('models.unavailable'),
                          defaultMessage: 'The list is not available until the status loads.',
                        })
                      : t({
                          id: getTranslation('models.empty'),
                          defaultMessage:
                            'No content type has a UUID field yet. Add the UUID custom field in the Content-Type Builder.',
                        })}
                  </Typography>
                </Card>
              ) : (
                <ModelList>
                  {modelEntries.map(([uid, fields]) => {
                    const rows = fieldStats.filter((row) => row.uid === uid);
                    const failed = rows.some((row) => row.scanFailed);
                    const problems = rows.reduce(
                      (sum, row) =>
                        sum +
                        (row.duplicateCount || 0) +
                        (row.invalidCount || 0) +
                        (row.emptyCount || 0),
                      0
                    );
                    const tone = failed ? 'warning' : problems > 0 ? 'danger' : 'success';
                    return (
                      <ModelRow key={uid}>
                        <Flex
                          direction="column"
                          alignItems="flex-start"
                          gap={2}
                          minWidth={0}
                          flex="1 1 24rem"
                        >
                          <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                            <Mono>{uid}</Mono>
                          </Typography>
                          <Flex gap={2} wrap="wrap">
                            {fields.map((field) => (
                              <Badge key={field} {...BADGE_TONES.neutral}>
                                {field}
                              </Badge>
                            ))}
                          </Flex>
                        </Flex>
                        <Badge {...BADGE_TONES[tone]}>
                          <Flex gap={1} alignItems="center">
                            {tone === 'success' ? (
                              <Check aria-hidden />
                            ) : (
                              <WarningCircle aria-hidden />
                            )}
                            {failed
                              ? t({
                                  id: getTranslation('status.scanFailed'),
                                  defaultMessage: 'Not checked',
                                })
                              : problems > 0
                                ? t(
                                    {
                                      id: getTranslation('status.problems'),
                                      defaultMessage:
                                        '{count, plural, one {# problem} other {# problems}}',
                                    },
                                    { count: problems }
                                  )
                                : okLabel}
                          </Flex>
                        </Badge>
                      </ModelRow>
                    );
                  })}
                </ModelList>
              )}
              {checked && (
                <Box paddingTop={3}>
                  <Typography variant="pi" textColor="neutral600">
                    {t({
                      id: getTranslation('check.lastRun'),
                      defaultMessage: 'Counts are from the check you just ran.',
                    })}
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
};

export default SettingsPage;
