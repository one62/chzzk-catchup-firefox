import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';

const base = 'https://addons.mozilla.org/api/v5/';
const addonPath = 'addons/addon/chzzk-catchup-firefox%40local/';

async function request(endpoint, options = {}) {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  assert.ok(issuer && secret, 'Configure AMO_JWT_ISSUER and AMO_JWT_SECRET environment secrets');
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  const token = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  const url = new URL(endpoint, base);
  assert.ok(url.href.startsWith(base), 'Unexpected AMO pagination URL');
  const headers = { Authorization: `JWT ${token}` };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `AMO returned HTTP ${response.status}; check credentials and the existing add-on in Developer Hub`);
  return response.json();
}

export function checkVersions(versions, target, listed = false) {
  const number = value => {
    assert.match(value, /^\d+\.\d+\.\d+$/, `Cannot compare AMO version ${value}; inspect it manually`);
    return value.split('.').map(Number);
  };
  const next = number(target);
  for (const item of versions) {
    if (listed) {
      assert.ok(['public', 'disabled', 'unreviewed'].includes(item.file?.status), `Unknown AMO version status for ${item.version}; inspect Developer Hub`);
      assert.notEqual(item.file?.status, 'unreviewed', `AMO version ${item.version} is awaiting review; finish that review before submitting`);
      continue;
    }
    assert.notEqual(item.version, target, `Version ${target} already exists; do not resubmit`);
    const previous = number(item.version);
    const index = next.findIndex((part, i) => part !== previous[i]);
    assert.ok(index >= 0 && next[index] > previous[index], `Version ${target} must be newer than ${item.version}`);
  }
}

async function preflight(version) {
  const addon = await request(addonPath);
  assert.equal(addon.guid, 'chzzk-catchup-firefox@local', 'Existing AMO add-on ID mismatch');
  for (const filter of ['all_with_unlisted', 'all_without_unlisted']) {
    let endpoint = `${addonPath}versions/?filter=${filter}&page_size=50`;
    while (endpoint) {
      const page = await request(endpoint);
      assert.ok(Array.isArray(page.results), 'Invalid AMO version response');
      checkVersions(page.results, version, filter === 'all_without_unlisted');
      endpoint = page.next;
    }
  }
  console.log(`Existing AMO add-on verified: ${addon.slug}; version ${version} is eligible for submission.`);
}

if (process.argv[1]?.endsWith('amo-api.mjs')) {
  const [command, file] = process.argv.slice(2);
  if (command === 'preflight') {
    await preflight(file);
  } else if (command === 'listing') {
    const listing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (listing) {
      const descriptionFields = ['description', 'summary'];
      const allowedFields = listing.name ? ['name', ...(listing.summary ? descriptionFields : [])] : descriptionFields;
      assert.deepEqual(Object.keys(listing).sort(), allowedFields.sort());
      if (listing.name) {
        assert.deepEqual(Object.keys(listing.name), ['ko']);
        assert.ok(typeof listing.name.ko === 'string' && listing.name.ko.trim());
      }
      await request(addonPath, { method: 'PATCH', body: JSON.stringify(listing) });
      console.log('스토어 정보 갱신 완료');
    } else console.log('스토어 정보 변경 없음');
  } else if (command === 'icon') {
    const form = new FormData();
    form.append('icon', new Blob([fs.readFileSync(file)], { type: 'image/png' }), 'store-icon.png');
    await request(addonPath, { method: 'PATCH', body: form });
    console.log('스토어 아이콘 갱신 요청 완료');
  } else throw new Error('Use preflight <version>, listing <listing.json> or icon <store-icon.png>');
}
