// Builds livekeep.zip for the Chrome Web Store. The store assigns its own key, so
// the local `key` (which only pins the ID for unpacked installs) is stripped.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = mkdtempSync(join(tmpdir(), 'livekeep-'));
cpSync(join(root, 'extension'), stage, { recursive: true });

const manifestPath = join(stage, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
delete manifest.key;
if (manifest.oauth2?.client_id?.startsWith('YOUR_')) {
  console.warn('warning: oauth2.client_id is still the placeholder');
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const out = join(root, 'livekeep.zip');
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.', '-x', '.*'], { cwd: stage });
rmSync(stage, { recursive: true });
console.log(`wrote ${out} (version ${manifest.version})`);
