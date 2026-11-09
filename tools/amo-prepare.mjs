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
  assert.equal(typeof (config.updateName ?? false), 'boolean');
  const read = file => {
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text && !/\b(TODO|TBD|PLACEHOLDER)\b/i.test(text), `Unfinished text: ${file}`);
    return text;
  };
  const releaseNotes = { ko: read(path.join(release, 'notes.ko.md')) };
  const englishNotes = path.join(release, 'notes.en.md');
  if (fs.existsSync(englishNotes)) releaseNotes['en-US'] = read(englishNotes);
  const metadata = { version: {
    release_notes: releaseNotes,
    approval_notes: [read(path.join(root, 'amo/reviewer-common.md')), read(path.join(release, 'reviewer.md'))].join('\n\n'),
  } };
  const listing = config.updateListing ? {
    summary: { ko: read(path.join(root, 'amo/summary.ko.txt')) },
    description: { ko: read(path.join(root, 'amo/listing.ko.md')) },
  } : null;
  const listingChanges = config.updateName ? { ...listing, name: { ko: manifest.name } } : listing;
  const storeIcon = path.join(release, 'store-icon.png');
  const out = path.join(root, 'dist/amo');
  fs.mkdirSync(out, { recursive: true });
  const source = path.join(out, 'extension');
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(source);
  for (const file of ['manifest.json', 'src', 'popup', 'icons']) {
    fs.cpSync(path.join(root, file), path.join(source, file), { recursive: true });
  }
  fs.writeFileSync(path.join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'listing.json'), JSON.stringify(listingChanges, null, 2) + '\n');
  const stagedIcon = path.join(out, 'store-icon.png');
  fs.rmSync(stagedIcon, { force: true });
  if (fs.existsSync(storeIcon)) fs.copyFileSync(storeIcon, stagedIcon);
  const notes = Object.entries(releaseNotes).map(([locale, content]) => `## 업데이트 노트 (${locale})\n\n${content}`).join('\n\n');
  fs.writeFileSync(path.join(out, 'review.md'), `# ${tag}\n\n${notes}\n\n## 심사 메모\n\n${metadata.version.approval_notes}\n\n## 스토어 정보 변경\n\n${listingChanges ? JSON.stringify(listingChanges, null, 2) : '문구 변경 없음'}\n\n스토어 아이콘 ${fs.existsSync(stagedIcon) ? 'store-icon.png로 갱신' : '변경 없음'}\n`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(prepare(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2]));
}
