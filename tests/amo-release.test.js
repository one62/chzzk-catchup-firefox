const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('release staging requires matching versions and confirmed text; listing is opt-in', async () => {
  const { prepare } = await import('../tools/amo-prepare.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amo-release-'));
  try {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name: '치지직지직', version: '1.2.3', browser_specific_settings: { gecko: { id: 'chzzk-catchup-firefox@local' } } }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
    for (const dir of ['src', 'popup', 'icons', 'amo/releases/1.2.3']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/example.js'), '// bundled');
    const release = path.join(root, 'amo/releases/1.2.3');
    for (const name of ['notes.ko.md', 'reviewer.md']) fs.writeFileSync(path.join(release, name), 'Release-specific text');
    fs.writeFileSync(path.join(root, 'amo/reviewer-common.md'), 'Common reviewer text');
    const config = value => fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify(value));
    config({ reviewed: false, updateListing: false });
    assert.throws(() => prepare(root, 'v1.2.4'), /Tag must match/);
    assert.throws(() => prepare(root, 'v1.2.3'), /Confirm the release text/);
    config({ reviewed: true, updateListing: false });
    const out = prepare(root, 'v1.2.3');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'listing.json'))), null);
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'metadata.json')));
    assert.deepEqual(meta.version.release_notes, { ko: 'Release-specific text' });
    assert.equal(meta.version.approval_notes, 'Common reviewer text\n\nRelease-specific text');
    assert.deepEqual(fs.readdirSync(path.join(out, 'extension')).sort(), ['icons', 'manifest.json', 'popup', 'src']);
    assert.equal(fs.existsSync(path.join(out, 'extension/package.json')), false);
    config({ reviewed: true, updateListing: false, updateName: true });
    prepare(root, 'v1.2.3');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'listing.json'))), { name: { ko: '치지직지직' } });
    const storeIcon = path.join(release, 'store-icon.png');
    const stagedIcon = path.join(out, 'store-icon.png');
    fs.copyFileSync(path.join(__dirname, '../amo/releases/0.4.0/store-icon.png'), storeIcon);
    prepare(root, 'v1.2.3');
    assert.deepEqual(fs.readFileSync(stagedIcon), fs.readFileSync(storeIcon));
    fs.unlinkSync(storeIcon);
    for (const locale of ['ko', 'en']) {
      fs.writeFileSync(path.join(root, `amo/listing.${locale}.md`), `Description ${locale}`);
      fs.writeFileSync(path.join(root, `amo/summary.${locale}.txt`), `Summary ${locale}`);
    }
    config({ reviewed: true, updateListing: true });
    prepare(root, 'v1.2.3');
    assert.equal(fs.existsSync(stagedIcon), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'listing.json'))), {
      summary: { ko: 'Summary ko' },
      description: { ko: 'Description ko' },
    });
    fs.writeFileSync(path.join(release, 'reviewer.md'), 'TODO');
    assert.throws(() => prepare(root, 'v1.2.3'), /Unfinished text/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AMO preflight prevents duplicate, older, pending and uncomparable releases', async () => {
  const { checkVersions } = await import('../tools/amo-api.mjs');
  assert.throws(() => checkVersions([{ version: '1.2.3' }], '1.2.3'), /already exists/);
  assert.throws(() => checkVersions([{ version: '1.3.0' }], '1.2.4'), /must be newer/);
  assert.throws(() => checkVersions([{ version: '1.2.3', file: { status: 'unreviewed' } }], '1.2.4', true), /awaiting review/);
  assert.throws(() => checkVersions([{ version: '1.2beta' }], '1.2.4'), /Cannot compare/);
  assert.throws(() => checkVersions([{ version: '1.2.3', file: { status: 'unknown' } }], '1.2.4', true), /Unknown AMO/);
  assert.doesNotThrow(() => checkVersions([{ version: '1.2.9' }], '1.2.10'));
  assert.doesNotThrow(() => checkVersions([{ version: '1.2.3', file: { status: 'public' } }], '1.2.4', true));
});
