'use strict';

/**
 * UUID Plugin - Settings Page
 * Modern settings page with styled-components and improved UX
 */
import React, { useState, useEffect } from 'react';
import { useIntl } from 'react-intl';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import styled, { keyframes, css } from 'styled-components';
import {
  Box,
  Button,
  Flex,
  Typography,
  Badge,
  Loader,
  Accordion,
  Alert,
  Checkbox,
  Modal,
} from '@strapi/design-system';
import {
  Check,
  WarningCircle,
  ArrowClockwise,
  Search,
  Cog,
  Plus,
  Stack,
  Download,
  Upload,
  Play,
} from '@strapi/icons';
import { PLUGIN_ID } from '../pluginId';

// Animations
const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
`;

const shimmer = keyframes`
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
`;

// Styled Components
const Container = styled(Box)`
  ${css`animation: ${fadeIn} 0.5s;`}
  max-width: 1200px;
  margin: 0 auto;
`;

const StickySaveBar = styled(Box)`
  position: sticky;
  top: 0;
  z-index: 10;
  background: ${props => props.theme.colors.neutral0};
  border-bottom: 1px solid ${props => props.theme.colors.neutral200};
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
`;

const HeaderBanner = styled(Box)`
  background: linear-gradient(135deg, #10B981 0%, #059669 100%);
  border-radius: 16px;
  padding: 32px;
  color: white;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(16, 185, 129, 0.25);
  margin-bottom: 32px;
  
  &::after {
    content: '';
    position: absolute;
    top: -50%;
    right: -50%;
    width: 200%;
    height: 200%;
    background: linear-gradient(
      45deg,
      transparent,
      rgba(255, 255, 255, 0.08),
      transparent
    );
    ${css`animation: ${shimmer} 3s infinite;`}
    pointer-events: none;
    z-index: 0;
  }
  
  & > * {
    position: relative;
    z-index: 1;
  }
`;

const StatCard = styled(Box)`
  background: ${props => props.theme.colors.neutral0};
  border: 1px solid ${props => props.theme.colors.neutral200};
  border-radius: 16px;
  padding: 28px;
  flex: 1;
  min-width: 200px;
  transition: all 0.2s ease;
  text-align: center;
  
  &:hover {
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
    transform: translateY(-4px);
  }
`;

const StatValue = styled.div`
  font-size: 3rem;
  font-weight: 800;
  color: ${props => props.$color || props.theme.colors.neutral800};
  line-height: 1;
  margin-bottom: 8px;
`;

const StatLabel = styled.div`
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: ${props => props.theme.colors.neutral600};
  font-weight: 600;
`;

const SectionTitle = styled.h2`
  font-size: 20px;
  font-weight: 700;
  color: ${props => props.theme.colors.neutral800};
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
`;

const ActionCard = styled(Box)`
  background: ${props => props.theme.colors.neutral0};
  border: 2px solid ${props => props.theme.colors.neutral200};
  border-radius: 16px;
  padding: 28px;
  transition: all 0.25s ease;
  cursor: pointer;
  height: 100%;
  display: flex;
  flex-direction: column;
  
  &:hover {
    border-color: ${props => props.$color || '#10B981'};
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
    transform: translateY(-6px);
  }
`;

const ActionIcon = styled.div`
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${props => props.$bg || '#DCFCE7'};
  margin-bottom: 20px;
  
  svg {
    width: 28px;
    height: 28px;
    color: ${props => props.$color || '#16A34A'};
  }
`;

const ActionTitle = styled.h3`
  font-size: 18px;
  font-weight: 700;
  color: ${props => props.theme.colors.neutral800};
  margin: 0 0 12px 0;
  line-height: 1.3;
`;

const ActionDescription = styled.p`
  font-size: 14px;
  color: ${props => props.theme.colors.neutral600};
  margin: 0;
  line-height: 1.6;
  flex: 1;
`;

const ActionGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 24px;
  margin-bottom: 32px;
`;

const ModelRow = styled(Flex)`
  padding: 20px 24px;
  background: ${props => props.theme.colors.neutral0};
  border: 1px solid ${props => props.theme.colors.neutral200};
  border-radius: 12px;
  margin-bottom: 12px;
  transition: all 0.2s ease;
  
  &:hover {
    background: ${props => props.theme.colors.neutral100};
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
`;

const ModelName = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: ${props => props.theme.colors.neutral800};
  margin-bottom: 8px;
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
`;

const StatusBadge = styled(Badge)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 13px;
  border-radius: 8px;
`;

const LoaderContainer = styled(Flex)`
  min-height: 400px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 16px;
`;

const FieldBadge = styled(Badge)`
  background: ${props => props.theme.colors.primary100};
  color: ${props => props.theme.colors.primary700};
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
`;

const LargeModalContent = styled(Modal.Content)`
  max-width: 800px !important;
  width: 90vw !important;
`;

const ImportTextarea = styled.textarea`
  width: 100%;
  min-height: 300px;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid ${props => props.theme.colors.neutral200};
  background: ${props => props.theme.colors.neutral100};
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  color: ${props => props.theme.colors.neutral800};
  
  &::placeholder {
    color: ${props => props.theme.colors.neutral500};
    font-size: 12px;
  }
  
  &:focus {
    outline: none;
    border-color: ${props => props.theme.colors.primary600};
    box-shadow: 0 0 0 2px ${props => props.theme.colors.primary100};
  }
`;

/**
 * Settings Page Component
 */
const SettingsPage = () => {
  const { formatMessage } = useIntl();
  const t = (id, defaultMessage, values) => formatMessage({ id: `${PLUGIN_ID}.${id}`, defaultMessage }, values);
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [models, setModels] = useState({});
  const [stats, setStats] = useState(null);
  const [diagnoseReport, setDiagnoseReport] = useState(null);
  const [migrationStatus, setMigrationStatus] = useState(null);
  const [error, setError] = useState(null);
  
  // Modal state
  const [showFixModal, setShowFixModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [fixReport, setFixReport] = useState(null);
  
  // Migration options
  const [migrationOptions, setMigrationOptions] = useState({
    fixEmpty: true,
    fixInvalid: true,
    fixDuplicates: true,
  });
  const [importData, setImportData] = useState('');

  /**
   * Fetches list of models using UUID fields
   */
  const fetchModels = async () => {
    try {
      const response = await get(`/${PLUGIN_ID}/models`);
      setModels(response.data?.models || {});
    } catch (err) {
      console.error('[UUID Settings] Failed to fetch models:', err);
    }
  };

  /**
   * Fetches comprehensive statistics
   */
  const fetchStats = async () => {
    try {
      const response = await get(`/${PLUGIN_ID}/stats`);
      setStats(response.data);
      setModels(response.data?.models || {});
    } catch (err) {
      console.error('[UUID Settings] Failed to fetch stats:', err);
      // Fallback to models endpoint
      await fetchModels();
    }
  };

  /**
   * Fetches migration status
   */
  const fetchMigrationStatus = async () => {
    try {
      const response = await get(`/${PLUGIN_ID}/migration/status`);
      setMigrationStatus(response.data);
    } catch (err) {
      console.error('[UUID Settings] Failed to fetch migration status:', err);
    }
  };

  /**
   * Runs diagnosis to find duplicate UUIDs
   */
  const runDiagnose = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await get(`/${PLUGIN_ID}/diagnose`);
      setDiagnoseReport(response.data);
      toggleNotification({
        type: 'success',
        message: t('settings.diagnose.success', 'Diagnosis completed successfully'),
      });
    } catch (err) {
      setError(t('settings.error.diagnose', 'Failed to run diagnosis'));
      toggleNotification({
        type: 'danger',
        message: t('settings.error.diagnose', 'Failed to run diagnosis'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Runs auto-fix to replace duplicate UUIDs
   */
  const runAutoFix = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await post(`/${PLUGIN_ID}/autofix`, { dryRun });
      setFixReport(response.data);
      
      if (!dryRun && response.data.totalFixed > 0) {
        toggleNotification({
          type: 'success',
          message: t('settings.autofix.success', '{count} duplicate(s) fixed', { count: response.data.totalFixed }),
        });
        await runDiagnose();
      }
    } catch (err) {
      setError(t('settings.error.autofix', 'Failed to run auto-fix'));
      toggleNotification({
        type: 'danger',
        message: t('settings.error.autofix', 'Failed to run auto-fix'),
      });
    } finally {
      setIsLoading(false);
      setShowFixModal(false);
    }
  };

  /**
   * Generates missing UUIDs for empty fields
   */
  const runGenerateMissing = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await post(`/${PLUGIN_ID}/generate-missing`, { dryRun });
      setFixReport(response.data);
      
      if (!dryRun && response.data.totalGenerated > 0) {
        toggleNotification({
          type: 'success',
          message: t('settings.generate.success', '{count} UUID(s) generated', { count: response.data.totalGenerated }),
        });
      }
    } catch (err) {
      setError(t('settings.error.generate', 'Failed to generate missing UUIDs'));
      toggleNotification({
        type: 'danger',
        message: t('settings.error.generate', 'Failed to generate missing UUIDs'),
      });
    } finally {
      setIsLoading(false);
      setShowGenerateModal(false);
    }
  };

  /**
   * Runs full migration to fix all UUID issues
   */
  const runMigration = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await post(`/${PLUGIN_ID}/migration/run`, {
        dryRun,
        ...migrationOptions,
      });
      setFixReport(response.data);
      
      if (!dryRun && response.data.totalFixed > 0) {
        toggleNotification({
          type: 'success',
          message: t('settings.migration.success', 'Migration completed: {count} entries fixed', { count: response.data.totalFixed }),
        });
        await fetchStats();
        await fetchMigrationStatus();
      }
    } catch (err) {
      setError(t('settings.error.migration', 'Failed to run migration'));
      toggleNotification({
        type: 'danger',
        message: t('settings.error.migration', 'Failed to run migration'),
      });
    } finally {
      setIsLoading(false);
      setShowMigrationModal(false);
    }
  };

  /**
   * Exports UUID mappings as JSON file
   */
  const exportMappings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await get(`/${PLUGIN_ID}/migration/export`);
      
      // Create and download file
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `uuid-mappings-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toggleNotification({
        type: 'success',
        message: t('settings.export.success', 'UUID mappings exported successfully'),
      });
    } catch (err) {
      setError(t('settings.error.export', 'Failed to export UUID mappings'));
      toggleNotification({
        type: 'danger',
        message: t('settings.error.export', 'Failed to export UUID mappings'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Imports UUID mappings from JSON
   */
  const importMappings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      let parsedData;
      try {
        parsedData = JSON.parse(importData);
      } catch {
        throw new Error('Invalid JSON format');
      }
      
      const response = await post(`/${PLUGIN_ID}/migration/import`, {
        mappings: parsedData,
        dryRun,
        overwrite: false,
      });
      
      setFixReport(response.data);
      
      if (!dryRun && response.data.imported > 0) {
        toggleNotification({
          type: 'success',
          message: t('settings.import.success', '{count} UUID(s) imported', { count: response.data.imported }),
        });
        await fetchStats();
      }
    } catch (err) {
      setError(t('settings.error.import', 'Failed to import UUID mappings'));
      toggleNotification({
        type: 'danger',
        message: err.message || t('settings.error.import', 'Failed to import UUID mappings'),
      });
    } finally {
      setIsLoading(false);
      setShowImportModal(false);
    }
  };

  // Load stats and migration status on mount
  useEffect(() => {
    fetchStats();
    fetchMigrationStatus();
  }, []);

  const modelCount = stats?.contentTypes ?? Object.keys(models).length;
  const fieldCount = stats?.totalFields ?? Object.values(models).reduce((sum, fields) => sum + fields.length, 0);
  const duplicateCount = stats?.issues?.duplicates ?? diagnoseReport?.totalDuplicates ?? null;
  const emptyCount = stats?.issues?.empty ?? null;
  const invalidCount = stats?.issues?.invalid ?? null;
  const totalEntries = stats?.totalEntries ?? null;
  const needsMigration = stats?.needsMigration ?? migrationStatus?.needsMigration ?? false;

  if (isLoading && !diagnoseReport) {
    return (
      <Container>
        <LoaderContainer>
          <Loader>{t('settings.loading', 'Loading...')}</Loader>
        </LoaderContainer>
      </Container>
    );
  }

  return (
    <Container>
      {/* Sticky Header */}
      <StickySaveBar paddingTop={5} paddingBottom={5} paddingLeft={6} paddingRight={6}>
        <Flex justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="alpha" fontWeight="bold" style={{ marginBottom: '4px', display: 'block' }}>
              {t('settings.title', 'UUID Management')}
            </Typography>
            <Typography variant="epsilon" textColor="neutral600">
              {t('settings.subtitle', 'Manage and maintain UUID fields across your content types')}
            </Typography>
          </Box>
          <Button
            startIcon={<ArrowClockwise />}
            onClick={() => { 
              fetchStats(); 
              fetchMigrationStatus();
              setDiagnoseReport(null); 
              setFixReport(null); 
            }}
            size="L"
            style={{
              background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
              color: 'white',
              fontWeight: '600',
              border: 'none',
              padding: '12px 24px',
            }}
          >
            {t('settings.refresh', 'Refresh')}
          </Button>
        </Flex>
      </StickySaveBar>

      {/* Content */}
      <Box paddingTop={8} paddingLeft={6} paddingRight={6} paddingBottom={10}>
        {/* Error Alert */}
        {error && (
          <Box marginBottom={6}>
            <Alert variant="danger" closeLabel="Close" onClose={() => setError(null)}>
              {error}
            </Alert>
          </Box>
        )}

        {/* Header Banner */}
        <HeaderBanner>
          <Flex justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Typography style={{ 
                color: 'rgba(255,255,255,0.7)', 
                fontSize: '12px', 
                textTransform: 'uppercase', 
                letterSpacing: '1px', 
                marginBottom: '12px', 
                display: 'block',
                fontWeight: '600'
              }}>
                {t('settings.plugin', 'Strapi Auto UUID Plugin')}
              </Typography>
              <Typography style={{ 
                color: 'white', 
                fontSize: '28px', 
                fontWeight: '800', 
                marginBottom: '12px',
                display: 'block',
                lineHeight: '1.2'
              }}>
                {t('settings.banner.title', 'UUID Field Manager')}
              </Typography>
              <Typography style={{ 
                color: 'rgba(255,255,255,0.9)', 
                fontSize: '15px',
                lineHeight: '1.6',
                maxWidth: '500px'
              }}>
                {t('settings.banner.description', 'Automatically generate and manage unique identifiers for your content')}
              </Typography>
            </Box>
            <Badge style={{ 
              background: 'rgba(255,255,255,0.2)', 
              color: 'white', 
              padding: '10px 18px', 
              fontWeight: '700',
              fontSize: '13px',
              borderRadius: '8px'
            }}>
              v1.0.0
            </Badge>
          </Flex>
        </HeaderBanner>

        {/* Migration Warning Banner */}
        {needsMigration && (
          <Box marginBottom={6}>
            <Alert 
              variant="warning" 
              title={t('settings.migration.needed', 'Migration Needed')}
              action={
                <Button variant="default" size="S" onClick={() => setShowMigrationModal(true)}>
                  {t('settings.actions.migration', 'Run Migration')}
                </Button>
              }
            >
              {t('settings.migration.warning', 'Some UUID fields have issues that need to be fixed. Run a migration to resolve them.')}
            </Alert>
          </Box>
        )}

        {/* Stats */}
        <Flex gap={4} marginBottom={8} wrap="wrap">
          <StatCard>
            <StatLabel>{t('settings.stats.models', 'Content Types')}</StatLabel>
            <StatValue>{modelCount}</StatValue>
          </StatCard>
          <StatCard>
            <StatLabel>{t('settings.stats.fields', 'UUID Fields')}</StatLabel>
            <StatValue>{fieldCount}</StatValue>
          </StatCard>
          <StatCard>
            <StatLabel>{t('settings.stats.entries', 'Total Entries')}</StatLabel>
            <StatValue>{totalEntries !== null ? totalEntries : '-'}</StatValue>
          </StatCard>
          <StatCard>
            <StatLabel>{t('settings.stats.duplicates', 'Duplicates')}</StatLabel>
            <StatValue $color={duplicateCount > 0 ? '#DC2626' : duplicateCount === 0 ? '#16A34A' : '#9CA3AF'}>
              {duplicateCount !== null ? duplicateCount : '-'}
            </StatValue>
          </StatCard>
          <StatCard>
            <StatLabel>{t('settings.stats.empty', 'Empty')}</StatLabel>
            <StatValue $color={emptyCount > 0 ? '#F59E0B' : emptyCount === 0 ? '#16A34A' : '#9CA3AF'}>
              {emptyCount !== null ? emptyCount : '-'}
            </StatValue>
          </StatCard>
          <StatCard>
            <StatLabel>{t('settings.stats.invalid', 'Invalid')}</StatLabel>
            <StatValue $color={invalidCount > 0 ? '#DC2626' : invalidCount === 0 ? '#16A34A' : '#9CA3AF'}>
              {invalidCount !== null ? invalidCount : '-'}
            </StatValue>
          </StatCard>
        </Flex>

        {/* Actions */}
        <SectionTitle>
          {t('settings.actions.title', 'Quick Actions')}
        </SectionTitle>
        
        <ActionGrid>
          <ActionCard onClick={runDiagnose} $color="#3B82F6">
            <ActionIcon $bg="#DBEAFE" $color="#2563EB">
              <Search />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.diagnose', 'Run Diagnosis')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.diagnose.description', 'Scan all UUID fields for duplicates and issues. This will check every entry in your content types.')}
            </ActionDescription>
          </ActionCard>

          <ActionCard onClick={() => { setDryRun(true); setFixReport(null); setShowFixModal(true); }} $color="#F59E0B">
            <ActionIcon $bg="#FEF3C7" $color="#D97706">
              <Cog />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.autofix', 'Auto-Fix Duplicates')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.autofix.description', 'Automatically replace duplicate UUIDs with new unique values. The first occurrence will be kept.')}
            </ActionDescription>
          </ActionCard>

          <ActionCard onClick={() => { setDryRun(true); setFixReport(null); setShowGenerateModal(true); }} $color="#10B981">
            <ActionIcon $bg="#DCFCE7" $color="#16A34A">
              <Plus />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.generate', 'Generate Missing UUIDs')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.generate.description', 'Create new UUIDs for entries that have empty or missing UUID fields.')}
            </ActionDescription>
          </ActionCard>

          <ActionCard onClick={() => { setDryRun(true); setFixReport(null); setShowMigrationModal(true); }} $color="#8B5CF6">
            <ActionIcon $bg="#EDE9FE" $color="#7C3AED">
              <Play />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.migration', 'Run Migration')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.migration.description', 'Fix all UUID issues at once: empty fields, invalid formats, and duplicates.')}
            </ActionDescription>
          </ActionCard>

          <ActionCard onClick={exportMappings} $color="#06B6D4">
            <ActionIcon $bg="#CFFAFE" $color="#0891B2">
              <Download />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.export', 'Export Mappings')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.export.description', 'Download a backup of all UUID mappings as JSON for migration or backup purposes.')}
            </ActionDescription>
          </ActionCard>

          <ActionCard onClick={() => { setDryRun(true); setImportData(''); setShowImportModal(true); }} $color="#EC4899">
            <ActionIcon $bg="#FCE7F3" $color="#DB2777">
              <Upload />
            </ActionIcon>
            <ActionTitle>
              {t('settings.actions.import', 'Import Mappings')}
            </ActionTitle>
            <ActionDescription>
              {t('settings.actions.import.description', 'Restore UUID mappings from a previously exported JSON backup file.')}
            </ActionDescription>
          </ActionCard>
        </ActionGrid>

        {/* Fix Report */}
        {fixReport && (
          <Box marginBottom={6}>
            <Alert 
              variant={fixReport.dryRun ? 'default' : 'success'}
              title={fixReport.dryRun ? t('settings.report.dryrun', 'Preview (Dry Run)') : t('settings.report.result', 'Result')}
              closeLabel="Close"
              onClose={() => setFixReport(null)}
            >
              {fixReport.totalFixed !== undefined && (
                <Typography>
                  {t('settings.report.fixed', '{count} duplicate(s) {action}', {
                    count: fixReport.totalFixed,
                    action: fixReport.dryRun ? 'would be fixed' : 'fixed',
                  })}
                </Typography>
              )}
              {fixReport.totalGenerated !== undefined && (
                <Typography>
                  {t('settings.report.generated', '{count} UUID(s) {action}', {
                    count: fixReport.totalGenerated,
                    action: fixReport.dryRun ? 'would be generated' : 'generated',
                  })}
                </Typography>
              )}
            </Alert>
          </Box>
        )}

        {/* Models Accordion */}
        {modelCount > 0 && (
          <Box>
            <SectionTitle>
              <Stack style={{ width: 20, height: 20 }} />
              {t('settings.models.title', 'Monitored Content Types')}
            </SectionTitle>
            
            <Accordion.Root defaultValue="models" collapsible>
              <Accordion.Item value="models">
                <Accordion.Header>
                  <Accordion.Trigger>
                    {modelCount} Content Type(s) with UUID fields
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content>
                  <Box padding={4}>
                    {Object.entries(models).map(([uid, fields]) => {
                      const duplicateInfo = diagnoseReport?.details?.[uid];
                      const hasDuplicates = duplicateInfo && Object.values(duplicateInfo.fields).some(
                        f => f.duplicateGroups > 0
                      );
                      
                      return (
                        <ModelRow key={uid} justifyContent="space-between" alignItems="center">
                          <Box style={{ flex: 1 }}>
                            <ModelName>{uid}</ModelName>
                            <Flex gap={2}>
                              {fields.map(field => (
                                <FieldBadge key={field}>
                                  {field}
                                </FieldBadge>
                              ))}
                            </Flex>
                          </Box>
                          {diagnoseReport ? (
                            hasDuplicates ? (
                              <StatusBadge style={{ background: '#FEE2E2', color: '#DC2626' }}>
                                <WarningCircle style={{ width: 16, height: 16 }} />
                                {t('settings.status.duplicates', 'Has Duplicates')}
                              </StatusBadge>
                            ) : (
                              <StatusBadge style={{ background: '#DCFCE7', color: '#16A34A' }}>
                                <Check style={{ width: 16, height: 16 }} />
                                {t('settings.status.ok', 'OK')}
                              </StatusBadge>
                            )
                          ) : (
                            <Typography variant="pi" textColor="neutral500" style={{ fontStyle: 'italic' }}>
                              {t('settings.status.notScanned', 'Not scanned yet')}
                            </Typography>
                          )}
                        </ModelRow>
                      );
                    })}
                  </Box>
                </Accordion.Content>
              </Accordion.Item>
            </Accordion.Root>
          </Box>
        )}

        {modelCount === 0 && (
          <Box padding={8} background="neutral100" hasRadius style={{ textAlign: 'center' }}>
            <Typography variant="omega" textColor="neutral600" style={{ fontSize: '15px' }}>
              {t('settings.noModels', 'No content types with UUID fields found. Add the UUID custom field to your content types to get started.')}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Auto-Fix Modal */}
      {showFixModal && (
        <Modal.Root open={showFixModal} onOpenChange={setShowFixModal}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>
                {t('settings.modal.autofix.title', 'Auto-Fix Duplicate UUIDs')}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Flex direction="column" gap={4}>
                <Typography style={{ lineHeight: '1.6' }}>
                  {t('settings.modal.autofix.description', 'This will scan all UUID fields and replace duplicate values with new unique UUIDs. The first occurrence of each duplicate will be kept.')}
                </Typography>
                
                <Checkbox 
                  checked={dryRun} 
                  onCheckedChange={(checked) => setDryRun(checked)}
                >
                  {t('settings.modal.dryrun', 'Dry Run (preview only, no changes)')}
                </Checkbox>

                {!dryRun && (
                  <Alert variant="warning">
                    {t('settings.modal.warning', 'Warning: This action will modify data in your database. Make sure you have a backup.')}
                  </Alert>
                )}
              </Flex>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close>
                <Button variant="tertiary">
                  {t('settings.modal.cancel', 'Cancel')}
                </Button>
              </Modal.Close>
              <Button 
                onClick={runAutoFix} 
                loading={isLoading}
                variant={dryRun ? 'secondary' : 'danger'}
              >
                {dryRun 
                  ? t('settings.modal.preview', 'Preview Changes')
                  : t('settings.modal.confirm', 'Fix Duplicates')
                }
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}

      {/* Generate Missing Modal */}
      {showGenerateModal && (
        <Modal.Root open={showGenerateModal} onOpenChange={setShowGenerateModal}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>
                {t('settings.modal.generate.title', 'Generate Missing UUIDs')}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Flex direction="column" gap={4}>
                <Typography style={{ lineHeight: '1.6' }}>
                  {t('settings.modal.generate.description', 'This will find all entries with empty UUID fields and generate new UUIDs for them.')}
                </Typography>
                
                <Checkbox 
                  checked={dryRun} 
                  onCheckedChange={(checked) => setDryRun(checked)}
                >
                  {t('settings.modal.dryrun', 'Dry Run (preview only, no changes)')}
                </Checkbox>

                {!dryRun && (
                  <Alert variant="warning">
                    {t('settings.modal.warning', 'Warning: This action will modify data in your database. Make sure you have a backup.')}
                  </Alert>
                )}
              </Flex>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close>
                <Button variant="tertiary">
                  {t('settings.modal.cancel', 'Cancel')}
                </Button>
              </Modal.Close>
              <Button 
                onClick={runGenerateMissing} 
                loading={isLoading}
                variant={dryRun ? 'secondary' : 'success'}
              >
                {dryRun 
                  ? t('settings.modal.preview', 'Preview Changes')
                  : t('settings.modal.generate.confirm', 'Generate UUIDs')
                }
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}

      {/* Migration Modal */}
      {showMigrationModal && (
        <Modal.Root open={showMigrationModal} onOpenChange={setShowMigrationModal}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>
                {t('settings.modal.migration.title', 'Run Full Migration')}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Flex direction="column" gap={4}>
                <Typography style={{ lineHeight: '1.6' }}>
                  {t('settings.modal.migration.description', 'This will fix all UUID issues including empty fields, invalid formats, and duplicates.')}
                </Typography>
                
                <Box>
                  <Typography variant="sigma" style={{ marginBottom: '12px', display: 'block' }}>
                    {t('settings.modal.migration.options', 'Migration Options')}
                  </Typography>
                  <Flex direction="column" gap={2}>
                    <Checkbox 
                      checked={migrationOptions.fixEmpty} 
                      onCheckedChange={(checked) => setMigrationOptions(prev => ({ ...prev, fixEmpty: checked }))}
                    >
                      {t('settings.modal.migration.fixEmpty', 'Fix empty UUIDs')}
                    </Checkbox>
                    <Checkbox 
                      checked={migrationOptions.fixInvalid} 
                      onCheckedChange={(checked) => setMigrationOptions(prev => ({ ...prev, fixInvalid: checked }))}
                    >
                      {t('settings.modal.migration.fixInvalid', 'Fix invalid UUIDs')}
                    </Checkbox>
                    <Checkbox 
                      checked={migrationOptions.fixDuplicates} 
                      onCheckedChange={(checked) => setMigrationOptions(prev => ({ ...prev, fixDuplicates: checked }))}
                    >
                      {t('settings.modal.migration.fixDuplicates', 'Fix duplicate UUIDs')}
                    </Checkbox>
                  </Flex>
                </Box>
                
                <Checkbox 
                  checked={dryRun} 
                  onCheckedChange={(checked) => setDryRun(checked)}
                >
                  {t('settings.modal.dryrun', 'Dry Run (preview only, no changes)')}
                </Checkbox>

                {!dryRun && (
                  <Alert variant="warning">
                    {t('settings.modal.warning', 'Warning: This action will modify data in your database. Make sure you have a backup.')}
                  </Alert>
                )}
              </Flex>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close>
                <Button variant="tertiary">
                  {t('settings.modal.cancel', 'Cancel')}
                </Button>
              </Modal.Close>
              <Button 
                onClick={runMigration} 
                loading={isLoading}
                variant={dryRun ? 'secondary' : 'danger'}
              >
                {dryRun 
                  ? t('settings.modal.preview', 'Preview Changes')
                  : t('settings.modal.run', 'Run Migration')
                }
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <Modal.Root open={showImportModal} onOpenChange={setShowImportModal}>
          <LargeModalContent>
            <Modal.Header>
              <Modal.Title>
                {t('settings.modal.import.title', 'Import UUID Mappings')}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Flex direction="column" gap={4}>
                <Typography style={{ lineHeight: '1.6' }}>
                  {t('settings.modal.import.description', 'Paste the JSON content from a previously exported UUID mappings file.')}
                </Typography>
                
                <Box>
                  <ImportTextarea
                    value={importData}
                    onChange={(e) => setImportData(e.target.value)}
                    placeholder={`{
  "exportedAt": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "mappings": {
    "api::article.article": {
      "fields": {
        "uuid": [
          { "documentId": "abc123", "uuid": "550e8400-e29b-..." }
        ]
      }
    }
  }
}`}
                  />
                </Box>
                
                <Checkbox 
                  checked={dryRun} 
                  onCheckedChange={(checked) => setDryRun(checked)}
                >
                  {t('settings.modal.dryrun', 'Dry Run (preview only, no changes)')}
                </Checkbox>

                {!dryRun && (
                  <Alert variant="warning">
                    {t('settings.modal.warning', 'Warning: This action will modify data in your database. Make sure you have a backup.')}
                  </Alert>
                )}
              </Flex>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close>
                <Button variant="tertiary">
                  {t('settings.modal.cancel', 'Cancel')}
                </Button>
              </Modal.Close>
              <Button 
                onClick={importMappings} 
                loading={isLoading}
                variant={dryRun ? 'secondary' : 'success'}
                disabled={!importData.trim()}
              >
                {dryRun 
                  ? t('settings.modal.preview', 'Preview Changes')
                  : t('settings.modal.import.confirm', 'Import Mappings')
                }
              </Button>
            </Modal.Footer>
          </LargeModalContent>
        </Modal.Root>
      )}
    </Container>
  );
};

export default SettingsPage;
