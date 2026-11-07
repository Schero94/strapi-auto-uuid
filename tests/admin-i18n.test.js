import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const LOCALES = ['en', 'de', 'fr', 'es', 'pt'];
const dir = fileURLToPath(new URL('../admin/src/', import.meta.url));
const catalogues = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(dir, 'translations', `${locale}.json`), 'utf8')),
  ])
);
const walk = (path) =>
  readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(jsx?|mjs)$/.test(entry) ? [full] : [];
  });
const code = walk(dir)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const unescape = (value) => value.replace(/\\(['"])/g, '$1');
const used = new Map(
  [
    ...code.matchAll(
      /getTranslation\(\s*'([^']+)'\s*\)\s*,\s*defaultMessage:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
    ),
  ].map((match) => [match[1], unescape(match[2] ?? match[3])])
);
const referenced = new Set([...code.matchAll(/getTranslation\(\s*'([^']+)'/g)].map((m) => m[1]));

const ARG_TYPES = new Set([
  TYPE.argument,
  TYPE.number,
  TYPE.date,
  TYPE.time,
  TYPE.select,
  TYPE.plural,
  TYPE.tag,
]);
const placeholders = (message, out = new Set()) => {
  for (const element of Array.isArray(message) ? message : parse(message)) {
    if (ARG_TYPES.has(element.type)) out.add(element.value);
    for (const option of Object.values(element.options ?? {})) placeholders(option.value, out);
    if (element.children) placeholders(element.children, out);
  }
  return [...out].sort().join(',');
};

describe('admin translations', () => {
  it('never builds translation ids from template literals', () => {
    expect([...code.matchAll(/getTranslation\(\s*`/g)]).toHaveLength(0);
  });

  it('defines every referenced id in every locale', () => {
    for (const locale of LOCALES) {
      expect(
        [...referenced].filter((id) => !(id in catalogues[locale])),
        locale
      ).toEqual([]);
    }
  });

  it('keeps the same key set in all locales and has no orphan keys', () => {
    const keys = Object.keys(catalogues.en).sort();
    for (const locale of LOCALES)
      expect(Object.keys(catalogues[locale]).sort(), locale).toEqual(keys);
    expect(keys.filter((key) => !referenced.has(key))).toEqual([]);
  });

  it('uses defaultMessage values equal to en.json', () => {
    expect([...used].filter(([id, text]) => catalogues.en[id] !== text).map(([id]) => id)).toEqual(
      []
    );
  });

  it('has valid ICU messages with the same placeholders as English', () => {
    for (const locale of LOCALES) {
      for (const [id, message] of Object.entries(catalogues[locale])) {
        expect(placeholders(message), `${locale} ${id}`).toBe(placeholders(catalogues.en[id]));
      }
    }
  });

  it('writes German without informal forms of address', () => {
    const informal = /\b(du|dich|dir|dein\w*|euch|euer\w*)\b/i;
    expect(
      Object.entries(catalogues.de)
        .filter(([, message]) => informal.test(message))
        .map(([key]) => key)
    ).toEqual([]);
  });
});
