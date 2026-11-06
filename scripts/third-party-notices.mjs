// Writes THIRD_PARTY_NOTICES.md with the license text of every runtime
// dependency bundled into lib/extension.js.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const paths = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' })
    .trim().split('\n').slice(1);

const seen = new Map();
for (const dir of paths) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) {
        continue;
    }
    const license = typeof pkg.license === 'string' ? pkg.license
        : Array.isArray(pkg.licenses) ? pkg.licenses.map(l => l.type).join(' OR ')
        : pkg.license?.type ?? 'see repository';
    const file = readdirSync(dir).find(name => /^(licen[cs]e|copying)(\.|$)/i.test(name));
    const text = file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim() : '';
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    seen.set(key, { name: pkg.name, version: pkg.version, license, text, repo });
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
let out = '# Third-party notices\n\nKasugai bundles the following packages. Their licenses are reproduced below.\n';
for (const e of entries) {
    out += `\n## ${e.name} ${e.version}\n\nLicense: ${e.license}${e.repo ? `  \nSource: ${e.repo.replace(/^git\+/, '')}` : ''}\n`;
    if (e.text) {
        out += `\n\`\`\`text\n${e.text}\n\`\`\`\n`;
    }
}
writeFileSync('THIRD_PARTY_NOTICES.md', out);
console.log(`THIRD_PARTY_NOTICES.md: ${entries.length} packages`);
