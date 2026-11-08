// Start-up test: launch real editors (VSCodium and VS Code) with Kasugai and
// check that it activates, registers its commands and its SSH resolver.
// No network services, secrets or SSH hosts are involved.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

// When this script itself runs from inside an editor (integrated terminal,
// extension host), these variables would turn the launched editor into a
// plain Node.js process or attach it to the outer instance.
for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) {
        delete process.env[key];
    }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.vscode-test');
const extensionId = 'moriyama-dev.kasugai-ssh';
const targets = (process.env.KASUGAI_STARTUP_TARGETS || 'vscodium,vscode').split(',');

async function downloadVSCodium() {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    // The "latest" page redirects to the tag. Unlike the REST API it has no
    // anonymous rate limit, which shared CI runners hit quickly.
    const latest = await fetch('https://github.com/VSCodium/vscodium/releases/latest', { redirect: 'manual' });
    const tag = (latest.headers.get('location') || '').split('/').pop();
    if (!tag) {
        throw new Error(`Could not find the latest VSCodium release (HTTP ${latest.status})`);
    }
    const name = platform === 'darwin' ? `VSCodium-darwin-${arch}-${tag}.zip` : `VSCodium-linux-${arch}-${tag}.tar.gz`;
    const asset = { name, browser_download_url: `https://github.com/VSCodium/vscodium/releases/download/${tag}/${name}` };
    const dir = join(cache, `vscodium-${tag}-${platform}-${arch}`);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        const archive = join(dir, asset.name);
        console.log(`Downloading ${asset.browser_download_url}`);
        const response = await fetch(asset.browser_download_url);
        if (!response.ok) {
            throw new Error(`Downloading ${asset.name} failed: HTTP ${response.status}`);
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
        if (archive.endsWith('.zip')) {
            execFileSync('ditto', ['-x', '-k', archive, dir]);
        } else {
            execFileSync('tar', ['-xzf', archive, '-C', dir]);
        }
    }
    if (platform === 'darwin') {
        const app = readdirSync(dir).find(name => name.endsWith('.app'));
        const macos = join(dir, app, 'Contents', 'MacOS');
        return join(macos, readdirSync(macos)[0]);
    }
    return join(dir, 'codium');
}

async function executableFor(target) {
    return target === 'vscodium' ? downloadVSCodium() : downloadAndUnzipVSCode({ version: 'stable', cachePath: cache });
}

// Package the extension once so the install-from-file path can be tested
let vsix;
try {
    vsix = join(mkdtempSync(join(tmpdir(), 'kasugai-vsix-')), 'kasugai-test.vsix');
    execFileSync('npx', ['vsce', 'package', '--no-dependencies', '-o', vsix], { cwd: root, stdio: 'ignore' });
} catch (e) {
    console.warn('Could not package the extension; skipping the .vsix install check', e);
    vsix = undefined;
}

let failed = false;
for (const target of targets) {
    for (const proposedApi of [true, false]) {
        const label = `${target} (${proposedApi ? 'with' : 'without'} enable-proposed-api)`;
        console.log(`\n=== ${label} ===`);
        const extensionsDir = mkdtempSync(join(tmpdir(), 'kasugai-ext-'));
        // Turn on the ssh-remote compatibility so its registration is checked too
        const userDataDir = mkdtempSync(join(tmpdir(), 'kasugai-ud-'));
        mkdirSync(join(userDataDir, 'User'), { recursive: true });
        writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({ 'kasugai.handleSshRemote': true }));
        try {
            const vscodeExecutablePath = await executableFor(target);
            await runTests({
                vscodeExecutablePath,
                extensionDevelopmentPath: root,
                extensionTestsPath: join(root, 'test-startup', 'suite.cjs'),
                extensionTestsEnv: {
                    KASUGAI_EXPECT_RESOLVER: proposedApi ? '1' : '0',
                    // Exercise the updater's install path once per editor
                    ...(proposedApi && vsix ? { KASUGAI_TEST_VSIX: vsix, KASUGAI_EXTENSIONS_DIR: extensionsDir } : {}),
                },
                launchArgs: [
                    '--extensions-dir', extensionsDir,
                    ...(proposedApi ? ['--enable-proposed-api', extensionId] : []),
                    '--disable-extensions',
                    '--disable-workspace-trust',
                    '--skip-welcome',
                    '--skip-release-notes',
                    '--user-data-dir', userDataDir,
                ],
            });
            console.log(`PASS ${label}`);
        } catch (e) {
            failed = true;
            console.error(`FAIL ${label}:`, e);
        }
    }
}
process.exit(failed ? 1 : 0);
