import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import * as vscode from 'vscode';
import type { Log } from './common/logger';
import { getSetting } from './common/config';
import { REPOSITORY_URL } from './feedback';

/*
 * Kasugai is installed from GitHub Releases (a .vsix), which editors never
 * update on their own. This checks the repository's latest release once a day,
 * offers the update, verifies the download against the release's SHA256SUMS
 * and installs it.
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'kasugai.update.lastCheck';
const SKIPPED_KEY = 'kasugai.update.skipped';

export type UpdateCheck = 'notify' | 'off';

export type ReleaseInfo = {
    tag: string;
    version: string;
    vsixUrl: string;
    checksumsUrl: string;
    notesUrl: string;
};

/** `v1.2.3` (or `1.2.3`) → `1.2.3`; anything else is not a Kasugai release. */
export function versionFromTag(tag: string): string | undefined {
    const version = tag.replace(/^v/, '');
    return semver.valid(version) ?? undefined;
}

export function releaseFor(tag: string): ReleaseInfo | undefined {
    const version = versionFromTag(tag);
    if (!version) {
        return undefined;
    }
    const base = `${REPOSITORY_URL}/releases/download/${tag}`;
    return {
        tag,
        version,
        vsixUrl: `${base}/kasugai-ssh-${version}.vsix`,
        checksumsUrl: `${base}/SHA256SUMS`,
        notesUrl: `${REPOSITORY_URL}/releases/tag/${tag}`,
    };
}

/** Find the SHA-256 of `fileName` in a `sha256sum` style listing. */
export function checksumFor(listing: string, fileName: string): string | undefined {
    for (const line of listing.split(/\r?\n/)) {
        const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (match && match[2].trim() === fileName) {
            return match[1].toLowerCase();
        }
    }
    return undefined;
}

/**
 * The latest release, found through the `releases/latest` redirect: unlike
 * the REST API it has no anonymous rate limit.
 */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo | undefined> {
    const response = await fetchImpl(`${REPOSITORY_URL}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const location = response.headers.get('location') ?? '';
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
    return tag ? releaseFor(decodeURIComponent(tag)) : undefined;
}

export class Updater implements vscode.Disposable {
    private running: Promise<void> | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: Log
    ) {
    }

    private get currentVersion(): string {
        return String(this.context.extension?.packageJSON?.version ?? '0.0.0');
    }

    /** Called on activation: at most one check per day, never in development. */
    checkInBackground() {
        if (this.context.extensionMode !== vscode.ExtensionMode.Production || getSetting<UpdateCheck>('updateCheck', 'notify') === 'off') {
            return;
        }
        const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
        if (Date.now() - last < CHECK_INTERVAL_MS) {
            return;
        }
        // Let the editor finish starting first
        const timer = setTimeout(() => void this.check(false), 30_000);
        this.context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }

    /** `Kasugai: Check for Updates`, or the daily background check. */
    check(interactive: boolean): Promise<void> {
        this.running ??= this.doCheck(interactive).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }

    private async doCheck(interactive: boolean) {
        let latest: ReleaseInfo | undefined;
        try {
            latest = await fetchLatestRelease();
            await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
        } catch (e) {
            this.logger.error('Checking for Kasugai updates failed', e);
            if (interactive) {
                void vscode.window.showErrorMessage('Kasugai: could not reach GitHub to check for updates.');
            }
            return;
        }

        if (!latest || !semver.gt(latest.version, this.currentVersion)) {
            this.logger.info(`Kasugai ${this.currentVersion} is up to date${latest ? ` (latest: ${latest.version})` : ''}`);
            if (interactive) {
                void vscode.window.showInformationMessage(`Kasugai ${this.currentVersion} is up to date.`);
            }
            return;
        }

        if (!interactive && this.context.globalState.get<string>(SKIPPED_KEY) === latest.version) {
            return;
        }

        const update = 'Update';
        const notes = 'Release Notes';
        const skip = 'Skip This Version';
        const answer = await vscode.window.showInformationMessage(
            `Kasugai ${latest.version} is available (you have ${this.currentVersion}).`,
            update, notes, skip
        );
        if (answer === notes) {
            void vscode.env.openExternal(vscode.Uri.parse(latest.notesUrl));
        } else if (answer === skip) {
            await this.context.globalState.update(SKIPPED_KEY, latest.version);
        } else if (answer === update) {
            await this.install(latest);
        }
    }

    private async install(release: ReleaseInfo) {
        try {
            const file = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Downloading Kasugai ${release.version}…`,
            }, () => this.download(release));

            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
            this.logger.info(`Installed Kasugai ${release.version} from ${release.vsixUrl}`);

            const reload = 'Reload Window';
            const answer = await vscode.window.showInformationMessage(`Kasugai ${release.version} is installed. Reload the window to start using it.`, reload);
            if (answer === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (e) {
            this.logger.error(`Updating Kasugai to ${release.version} failed`, e);
            const open = 'Open Release Page';
            const answer = await vscode.window.showErrorMessage(`Kasugai: the update failed (${e instanceof Error ? e.message : String(e)}). You can install it manually from the release page.`, open);
            if (answer === open) {
                void vscode.env.openExternal(vscode.Uri.parse(release.notesUrl));
            }
        }
    }

    /** Download the .vsix and refuse it unless it matches the release's SHA256SUMS. */
    private async download(release: ReleaseInfo): Promise<string> {
        const sums = await fetch(release.checksumsUrl, { signal: AbortSignal.timeout(30_000) });
        if (!sums.ok) {
            throw new Error(`no checksum list for ${release.tag} (HTTP ${sums.status})`);
        }
        const fileName = path.posix.basename(new URL(release.vsixUrl).pathname);
        const expected = checksumFor(await sums.text(), fileName);
        if (!expected) {
            throw new Error(`${fileName} is missing from the checksum list`);
        }

        const response = await fetch(release.vsixUrl, { signal: AbortSignal.timeout(5 * 60_000) });
        if (!response.ok) {
            throw new Error(`download failed (HTTP ${response.status})`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        const actual = crypto.createHash('sha256').update(data).digest('hex');
        if (actual !== expected) {
            throw new Error('the downloaded file does not match its published checksum');
        }

        const dir = path.join(this.context.globalStorageUri.fsPath, 'updates');
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, fileName);
        await fs.promises.writeFile(file, data);
        return file;
    }

    dispose() {
    }
}
