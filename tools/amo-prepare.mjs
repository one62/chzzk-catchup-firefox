import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepare(root, tag) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Use a vX.Y.Z release tag');
  assert.equal(tag, `v${manifest.version}`, 'Tag must match manifest version');
  assert.equal(pkg.version, manifest.version, 'Package version must match manifest');
  assert.equal(manifest.browser_specific_settings.gecko.id, 'chzzk-catchup-firefox@local', 'Unexpected extension ID');
  const release = path.join(root, 'amo/releases', manifest.version);
  const config = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
  assert.equal(config.reviewed, true, 'Confirm the release text before tagging: reviewed must be true');
  assert.equal(typeof config.updateListing, 'boolean');
  const read = file => {
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text && !/\b(TODO|TBD|PLACEHOLDER)\b/i.test(text), `Unfinished text: ${file}`);
    return text;
  };
  const metadata = { version: {
    release_notes: { ko: read(path.join(release, 'notes.ko.md')), 'en-US': read(path.join(release, 'notes.en.md')) },
    approval_notes: [read(path.join(root, 'amo/reviewer-common.md')), read(path.join(release, 'reviewer.md'))].join('\n\n'),
  } };
  const listing = config.updateListing ? {
    description: { ko: read(path.join(root, 'amo/listing.ko.md')), 'en-US': read(path.join(root, 'amo/listing.en.md')) },
  } : null;
  const out = path.join(root, 'dist/amo');
  fs.mkdirSync(out, { recursive: true });
  const source = path.join(out, 'extension');
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(source);
  for (const file of ['manifest.json', 'src', 'popup', 'icons']) {
    fs.cpSync(path.join(root, file), path.join(source, file), { recursive: true });
  }
  fs.writeFileSync(path.join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'listing.json'), JSON.stringify(listing, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'review.md'), `# ${tag}\n\nUpdate store description: ${config.updateListing}\n\n## Korean release notes\n\n${metadata.version.release_notes.ko}\n\n## English release notes\n\n${metadata.version.release_notes['en-US']}\n\n## Reviewer notes\n\n${metadata.version.approval_notes}\n\n## Store description changes\n\n${listing ? JSON.stringify(listing, null, 2) : 'No changes.'}\n`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(prepare(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2]));
}
