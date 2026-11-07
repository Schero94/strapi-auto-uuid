import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../admin/src/', import.meta.url));
const walk = (path) =>
  readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(jsx?|mjs)$/.test(entry) ? [full] : [];
  });
const files = walk(dir).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const read = (relative) => readFileSync(join(dir, relative), 'utf8');

describe('admin source guards', () => {
  it('uses Design System theme tokens instead of hex or rgba colours', () => {
    const offenders = files
      .filter(({ source }) => /#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\(/.test(source))
      .map(({ file }) => file.replace(dir, ''));
    expect(offenders).toEqual([]);
  });

  it('uses no px font sizes and no var(--colors-*) references', () => {
    const offenders = files
      .filter(({ source }) =>
        /font-?size:\s*['"]?\d+px|fontSize:\s*['"]\d+px|var\(--colors-/.test(source)
      )
      .map(({ file }) => file.replace(dir, ''));
    expect(offenders).toEqual([]);
  });

  it('gives dialog triggers a ref-forwarding element (Radix asChild)', () => {
    expect(read('pages/SettingsPage.jsx')).toMatch(/const ActionCard = forwardRef\(/);
  });

  it('labels every Alert close button and animates only without reduced motion', () => {
    const page = read('pages/SettingsPage.jsx');
    const alerts = page.match(/<Alert\b[^>]*>/gs) || [];
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) expect(alert).toMatch(/closeLabel=/);
    expect(read('pages/settings/styles.js')).toMatch(/prefers-reduced-motion: no-preference/);
    expect(read('pages/settings/styles.js')).not.toMatch(/infinite/);
  });

  it('RA-6/RA-1: reads the saved value from the form and detects the clone page', () => {
    const input = read('components/Input/index.jsx');
    expect(input).toMatch(/useForm\('UuidInput', \(form\) => form\.initialValues, false\)/);
    expect(input).not.toMatch(/const \[savedValue\] = useState/);
    expect(input).toMatch(/'\/content-manager\/:collectionType\/:slug\/clone\/:origin'/);
    expect(input).toMatch(/useMatch\(CLONE_PATH\)/);
  });

  it('RA-7: Run check uses one scan (no extra /diagnose round trip)', () => {
    expect(read('pages/SettingsPage.jsx')).not.toMatch(/\/diagnose/);
  });

  it('RA-3: exports compact JSON split into importable parts', () => {
    const page = read('pages/SettingsPage.jsx');
    expect(page).toMatch(/splitExport\(data\)/);
    expect(page).not.toMatch(/JSON\.stringify\(data, null, 2\)/);
  });

  it('never uses window.confirm or writes to the field on mount', () => {
    expect(files.some(({ source }) => /window\.confirm|\bconfirm\(/.test(source))).toBe(false);
    const input = read('components/Input/index.jsx');
    expect(input).not.toMatch(/useEffect\(\(\) => \{\s*if \(!value/);
  });
});
