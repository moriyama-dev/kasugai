import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { checksumFor, fetchLatestRelease, readInstallSource, releaseFor, versionFromTag } from '../src/updater';

function extensionsDir(entries: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasugai-updater-'));
    fs.writeFileSync(path.join(dir, 'extensions.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
    return dir;
}

describe('updater', () => {
    it('reads versions from release tags', () => {
        expect(versionFromTag('v0.2.0')).toBe('0.2.0');
        expect(versionFromTag('1.0.0')).toBe('1.0.0');
        expect(versionFromTag('v0.5.1-beta.1')).toBe('0.5.1-beta.1');
        expect(versionFromTag('latest')).toBeUndefined();
    });

    it('builds the release asset URLs', () => {
        expect(releaseFor('v0.2.0')).toEqual({
            tag: 'v0.2.0',
            version: '0.2.0',
            vsixUrl: 'https://github.com/moriyama-dev/kasugai/releases/download/v0.2.0/kasugai-ssh-0.2.0.vsix',
            checksumsUrl: 'https://github.com/moriyama-dev/kasugai/releases/download/v0.2.0/SHA256SUMS',
            notesUrl: 'https://github.com/moriyama-dev/kasugai/releases/tag/v0.2.0',
        });
    });

    it('finds a file in a sha256sum listing', () => {
        const hash = 'a'.repeat(64);
        const listing = `${'b'.repeat(64)}  other.vsix\n${hash.toUpperCase()} *kasugai-ssh-0.2.0.vsix\n`;
        expect(checksumFor(listing, 'kasugai-ssh-0.2.0.vsix')).toBe(hash);
        expect(checksumFor(listing, 'missing.vsix')).toBeUndefined();
    });

    it('follows the releases/latest redirect', async () => {
        const fakeFetch = (async () => new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/moriyama-dev/kasugai/releases/tag/v0.3.1' },
        })) as unknown as typeof fetch;
        expect((await fetchLatestRelease(fakeFetch))?.version).toBe('0.3.1');
    });

    it('treats a repository without releases as no update', async () => {
        const fakeFetch = (async () => new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/moriyama-dev/kasugai/releases' },
        })) as unknown as typeof fetch;
        expect(await fetchLatestRelease(fakeFetch)).toBeUndefined();
    });

    it.skipIf(!!process.env.KASUGAI_OFFLINE)('finds the real latest release on GitHub', async () => {
        const latest = await fetchLatestRelease();
        expect(latest?.version).toMatch(/^\d+\.\d+\.\d+/);
    }, 30_000);

    it('reads the install source the editor recorded', async () => {
        const dir = extensionsDir([
            { identifier: { id: 'other.ext' }, relativeLocation: 'other.ext-1.0.0', metadata: { source: 'vsix' } },
            { identifier: { id: 'moriyama-dev.kasugai-ssh' }, relativeLocation: 'moriyama-dev.kasugai-ssh-0.3.0', metadata: { source: 'gallery' } },
        ]);
        expect(await readInstallSource(path.join(dir, 'moriyama-dev.kasugai-ssh-0.3.0'))).toBe('gallery');
    });

    it('reads the install source of a .vsix install from its location', async () => {
        const dir = extensionsDir([
            { identifier: { id: 'moriyama-dev.kasugai-ssh' }, location: { fsPath: '/x/moriyama-dev.kasugai-ssh-0.2.0' }, metadata: { source: 'vsix', pinned: true } },
        ]);
        expect(await readInstallSource(path.join(dir, 'moriyama-dev.kasugai-ssh-0.2.0'))).toBe('vsix');
    });

    it('gives no install source for development copies and unreadable lists', async () => {
        expect(await readInstallSource(path.join(os.tmpdir(), 'kasugai-no-such-dir', 'kasugai'))).toBeUndefined();
        expect(await readInstallSource(path.join(extensionsDir('not json'), 'moriyama-dev.kasugai-ssh-0.3.0'))).toBeUndefined();
        expect(await readInstallSource(path.join(extensionsDir({}), 'moriyama-dev.kasugai-ssh-0.3.0'))).toBeUndefined();
        const dir = extensionsDir([{ relativeLocation: 'moriyama-dev.kasugai-ssh-0.3.0', metadata: { source: 'resource' } }]);
        expect(await readInstallSource(path.join(dir, 'moriyama-dev.kasugai-ssh-0.3.0'))).toBeUndefined();
    });
});
