/**
 * README contract for the npm page and the Strapi marketplace.
 *
 * Both render the README.md that ships in the npm package, outside the GitHub
 * repository: relative paths do not resolve there, images on a branch URL break
 * when files move on `main`, and the marketplace does not wrap tables in a
 * scroll container, so a wide table scrolls the whole page on a phone.
 */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const PAGES_IMG = 'https://schero94.github.io/strapi-auto-uuid/img/';

/** README without fenced code blocks, so examples are not parsed as markup. */
const prose = readme.replace(/^```[\s\S]*?^```/gm, '');

const markdownImages = [...prose.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({
  alt: m[1],
  url: m[2],
}));
const htmlImages = [...prose.matchAll(/<img\b[^>]*>/gi)].map((m) => ({
  alt: (m[0].match(/\balt="([^"]*)"/i) || [])[1] ?? '',
  url: (m[0].match(/\bsrc="([^"]*)"/i) || [])[1] ?? '',
}));
const images = [...markdownImages, ...htmlImages];

const links = [
  ...[...prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]),
  ...[...prose.matchAll(/\bhref="([^"]*)"/gi)].map((m) => m[1]),
];

/**
 * GitHub's heading anchor: lower case, punctuation removed, spaces to dashes.
 * @param {string} heading
 * @returns {string}
 */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

describe('README renders outside GitHub (npm, Strapi marketplace)', () => {
  test('finds the images and links it checks', () => {
    assert.ok(images.length >= 5, `only ${images.length} images found`);
    assert.ok(links.length >= 10, `only ${links.length} links found`);
  });

  test('every image and link uses an absolute https URL or an in-page anchor', () => {
    const relative = [...images.map((i) => i.url), ...links].filter(
      (url) => !url.startsWith('#') && !url.startsWith('https://')
    );
    assert.deepEqual(relative, []);
  });

  test('no image depends on a branch of the repository', () => {
    const branchBound = images
      .map((i) => i.url)
      .filter((url) =>
        /raw\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/(raw|blob)\//.test(url)
      );
    assert.deepEqual(branchBound, []);
  });

  test('every image has alt text', () => {
    assert.deepEqual(
      images.filter((i) => !i.alt.trim()).map((i) => i.url),
      []
    );
  });

  test('project images come from GitHub Pages and exist in docs/site/img', () => {
    const own = images.map((i) => i.url).filter((url) => url.startsWith(PAGES_IMG));
    assert.ok(own.length >= 2, 'expected the icon and screenshots on the Pages host');
    const missing = own.filter(
      (url) => !existsSync(join(root, 'docs/site/img', url.slice(PAGES_IMG.length)))
    );
    assert.deepEqual(missing, []);
  });

  test('screenshots are a short curated set without duplicates', () => {
    const shots = images
      .map((i) => i.url)
      .filter((url) => /\.(webp|png|jpe?g|gif)$/i.test(url) && !/\/icon[-.]/.test(url));
    assert.ok(shots.length <= 6, `${shots.length} screenshots; link the full gallery instead`);
    assert.equal(new Set(shots).size, shots.length, 'a screenshot is embedded twice');
  });

  test('tables stay narrow enough for a phone (at most two columns)', () => {
    const wide = prose
      .split('\n')
      .filter((line) => /^\|.*\|\s*$/.test(line) && !/^\|[\s|:-]+\|\s*$/.test(line))
      .filter((line) => line.replace(/\\\|/g, '').split('|').length - 2 > 2);
    assert.deepEqual(wide, []);
  });

  test('no inline code is too long to wrap on a 327 px content column', () => {
    // Browsers may break inline code at spaces and after "/" and "-" (UAX #14).
    // 38 monospace characters fit the marketplace's 327 px column on a phone.
    const tooLong = [...prose.matchAll(/`([^`\n]+)`/g)]
      .flatMap((m) => m[1].split(/\s+|(?<=[/-])/))
      .filter((word) => word.length > 38);
    assert.deepEqual(tooLong, []);
  });

  test('in-page anchors point to existing headings', () => {
    const anchors = new Set(
      [...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1].replace(/`/g, '')))
    );
    const broken = links
      .filter((url) => url.startsWith('#'))
      .filter((url) => !anchors.has(url.slice(1)));
    assert.deepEqual(broken, []);
  });
});

describe('documented Strapi versions match package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  /** @param {string} range @returns {string} major.minor of a semver range */
  const minorOf = (range) => (range.match(/(\d+\.\d+)/) || [])[1];
  const allowed = new Set([
    minorOf(pkg.peerDependencies['@strapi/strapi']),
    minorOf(pkg.devDependencies['@strapi/strapi']),
  ]);

  test.each(['README.md', 'docs/site/index.html', '.github/workflows/ci.yml'])(
    '%s names only the peer floor or the tested Strapi version',
    (file) => {
      const text = readFileSync(join(root, file), 'utf8');
      const stale = [...text.matchAll(/Strapi (5\.\d+)/g)]
        .map((m) => m[1])
        .filter((version) => !allowed.has(version));
      assert.deepEqual(stale, [], `allowed: ${[...allowed].join(', ')}`);
    }
  );
});
