import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://chzzk.naver.com/*"]);
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
const assets = new Set([manifest.action.default_popup, manifest.action.default_icon,
  ...Object.values(manifest.icons)]);
for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, ["https://chzzk.naver.com/*"]);
  assert.notEqual(script.all_frames, true);
  for (const file of [...(script.js || []), ...(script.css || [])]) assets.add(file);
}
for (const file of assets) {
  const resolved = path.resolve(root, file);
  assert.ok(resolved.startsWith(root + path.sep), `Invalid asset path: ${file}`);
  assert.ok(fs.existsSync(resolved), `Missing manifest asset: ${file}`);
}
const popup = fs.readFileSync(path.join(root, manifest.action.default_popup), "utf8");
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(popup), "Inline scripts violate extension CSP");
for (const match of popup.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const asset = path.resolve(root, path.dirname(manifest.action.default_popup), match[1]);
  assert.ok(fs.existsSync(asset), `Missing popup asset: ${match[1]}`);
}
const js = [...assets].filter((file) => file.endsWith(".js"));
js.push("popup/popup.js");
for (const file of js) execFileSync(process.execPath, ["--check", path.join(root, file)]);
console.log(`Manifest, ${assets.size} manifest assets, popup assets and ${js.length} scripts checked.`);
