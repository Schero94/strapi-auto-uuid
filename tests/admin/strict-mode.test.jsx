/**
 * StrictMode checks of every Auto UUID admin entry point: the settings page "UUID management"
 * with its repair and import dialogs, the UUID custom field input of the Content Manager
 * (top-level field, field inside a component, clone view) and the plugin initializer. See
 * harness/index.jsx for what each assertion counts. Runs in the Vitest project `admin`
 * (jsdom, harness/setup.mjs).
 */
import assert from 'node:assert/strict';
import { act } from 'react';
import { test } from 'vitest';
import { Form } from '@strapi/strapi/admin';
import { checkStrictEntry, network, permission, settle } from './harness/index.jsx';
import SettingsPage from '../../admin/src/pages/SettingsPage';
import UuidInput from '../../admin/src/components/Input';
import { Initializer } from '../../admin/src/components/Initializer';

const PLUGIN = 'field-uuid';
const ALL = ['read', 'migrate', 'export', 'import'].map((action) =>
  permission(`plugin::${PLUGIN}.${action}`)
);
const ARTICLE = 'api::article.article';
const SAVED = '0b9d8d7e-6d0f-4f43-9a51-1d6a2c1b7e10';

/**
 * A toast (Strapi NotificationsProvider, sonner 2.0.7) adds a `visibilitychange` listener to
 * `document` and removes it from `window` (sonner `useIsDocumentHidden`). Library code.
 */
const TOAST_LISTENER = {
  match: /^listener document:visibilitychange lib:sonner\//,
  reason:
    'sonner 2.0.7 (bundled by @strapi/admin) removes its toast listener from the wrong target',
};

const stats = (overrides = {}) => ({
  contentTypes: 1,
  totalFields: 1,
  totalEntries: 3,
  issues: { empty: 1, invalid: 0, legacy: 0, duplicates: 0 },
  needsMigration: true,
  hasErrors: false,
  scanIssues: [],
  fields: [
    {
      uid: ARTICLE,
      field: 'uuid',
      total: 3,
      emptyCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      legacyCount: 0,
      scanFailed: false,
    },
  ],
  models: { [ARTICLE]: ['uuid'] },
  version: '2.1.2',
  lastChecked: new Date().toISOString(),
  ...overrides,
});

/**
 * Clicks an element inside `act` (Design System buttons and Radix triggers handle `click`).
 * @param {Element | null | undefined} element - Element.
 */
const click = async (element) => {
  assert.ok(element, 'element to click exists');
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    element.click();
  });
  await settle(4, 10);
};

/**
 * Finds a button by its accessible label or text anywhere in the document (dialogs render in
 * portals).
 * @param {string | RegExp} label - Label, or a pattern for the text.
 * @returns {HTMLElement | null} Button.
 */
const button = (label) =>
  (typeof label === 'string' && document.querySelector(`button[aria-label="${label}"]`)) ||
  [...document.querySelectorAll('button')].find((node) =>
    typeof label === 'string' ? node.textContent.trim() === label : label.test(node.textContent)
  ) ||
  null;

/**
 * Live (not aborted) requests to one path.
 * @param {Array<object>} calls - Recorded calls.
 * @param {string} pathname - Path without query.
 * @returns {Array<object>} Calls.
 */
const live = (calls, pathname) =>
  calls.filter((call) => call.pathname === pathname && !call.aborted);

/** @param {Array<object>} calls - Recorded calls. @returns {Array<object>} Plugin mutations. */
const mutations = (calls) => calls.filter((call) => call.fromPlugin && call.method !== 'GET');

test('settings page: one live stats request, repair preview sends one POST, import dialog', async () => {
  network.on('GET', `/${PLUGIN}/stats`, stats());
  network.on('POST', `/${PLUGIN}/migration/run`, (call) => ({
    dryRun: call.json().dryRun,
    contentTypes: [{ uid: ARTICLE, field: 'uuid', filled: 1, replaced: 0, duplicatesFixed: 0 }],
    failed: false,
    aborted: false,
  }));
  const result = await checkStrictEntry(<SettingsPage />, {
    path: `/settings/${PLUGIN}/management`,
    permissions: ALL,
    async whileMounted() {
      assert.match(document.body.textContent, /UUID management/);
      await click(button(/^Repair all/));
      assert.ok(document.querySelector('[role="dialog"]'), 'repair dialog is open');
      await click(button('Preview changes'));
      await click(button('Cancel'));
      await click(button(/^Import UUIDs/));
      assert.ok(document.querySelector('[role="dialog"]'), 'import dialog is open');
      await click(button('Cancel'));
    },
  });
  assert.equal(live(result.mountCalls, `/${PLUGIN}/stats`).length, 1, 'one stats request');
  const runs = mutations(result.calls);
  assert.equal(runs.length, 1, 'one preview request per click');
  assert.equal(JSON.parse(runs[0].body).dryRun, true, 'the preview is a dry run');
});

test('settings page: load error and no permission', async () => {
  network.on('GET', `/${PLUGIN}/stats`, {
    status: 500,
    body: { error: { status: 500, name: 'ApplicationError', message: 'failed' } },
  });
  const failed = await checkStrictEntry(<SettingsPage />, {
    path: `/settings/${PLUGIN}/management`,
    permissions: ALL,
  });
  assert.match(failed.html, /could not be loaded/);

  const none = await checkStrictEntry(<SettingsPage />, {
    path: `/settings/${PLUGIN}/management`,
    permissions: [],
  });
  assert.equal(none.mountCalls.filter((call) => call.fromPlugin).length, 0);
});

const attribute = (options = {}) => ({
  type: 'string',
  customField: `plugin::${PLUGIN}.uuid`,
  options: { 'uuid-version': 'v4', ...options },
});

test('custom field in a component: generates the UUID once despite the StrictMode remount', async () => {
  const changes = [];
  const result = await checkStrictEntry(
    <Form method="POST" initialValues={{ meta: { blockId: '' } }}>
      <UuidInput
        attribute={attribute()}
        label="Block id"
        name="meta.blockId"
        value=""
        onChange={(event) => changes.push(event.target)}
      />
    </Form>,
    { path: `/content-manager/collection-types/${ARTICLE}/create`, permissions: ALL }
  );
  assert.equal(changes.length, 1, 'onChange runs once');
  assert.match(changes[0].value, /^[0-9a-f-]{36}$/);
  assert.equal(result.calls.filter((call) => call.fromPlugin).length, 0, 'no request');
});

test('custom field (saved, editable): copy and a confirmed replace change the value once', async () => {
  const changes = [];
  await checkStrictEntry(
    <Form method="PUT" initialValues={{ uuid: SAVED }}>
      <UuidInput
        attribute={attribute({ 'allow-edit': true })}
        label="UUID"
        name="uuid"
        value={SAVED}
        onChange={(event) => changes.push(event.target)}
      />
    </Form>,
    {
      path: `/content-manager/collection-types/${ARTICLE}/doc-1`,
      permissions: ALL,
      async whileMounted() {
        assert.equal(changes.length, 0, 'a saved value is never changed on mount');
        await click(button('Copy UUID'));
        await click(button('Generate a new UUID'));
        assert.match(document.body.textContent, /Replace this UUID\?/);
        await click(button('Replace UUID'));
      },
      allowLeaks: [TOAST_LISTENER],
    }
  );
  assert.equal(changes.length, 1, 'one change for one confirmed replace');
  assert.notEqual(changes[0].value, SAVED);
});

test('custom field on the clone view: clears the copied UUID once', async () => {
  const changes = [];
  await checkStrictEntry(
    <Form method="POST" initialValues={{ uuid: SAVED }}>
      <UuidInput
        attribute={attribute()}
        label="UUID"
        name="uuid"
        value={SAVED}
        onChange={(event) => changes.push(event.target)}
      />
    </Form>,
    { path: `/content-manager/collection-types/${ARTICLE}/clone/doc-1`, permissions: ALL }
  );
  assert.deepEqual(
    changes.map((target) => target.value),
    [null],
    'onChange runs once with null'
  );
});

test('initializer: registers the plugin id', async () => {
  const ids = [];
  await checkStrictEntry(<Initializer setPlugin={(id) => ids.push(id)} />, { permissions: ALL });
  assert.ok(ids.length >= 1 && ids.every((id) => id === PLUGIN));
});
