import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import * as vscode from 'vscode';
import { t } from './common/l10n';
import type { Log } from './common/logger';
import { getSetting } from './common/config';
import { REPOSITORY_URL } from './feedback';

/*
 * A copy installed from GitHub Releases (a .vsix) is never updated by the
 * editor. For those, this checks the repository's latest release once a day,
 * offers the update, verifies the download against the release's SHA256SUMS
 * and installs it.
 *
 * A copy installed from the editor's extension store (Open VSX) is updated by
 * the editor, so it is left alone: installing a .vsix over it would turn it
 * into a pinned .vsix install and stop those store updates.
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

/** How the editor recorded this installation: `gallery` (its store), `vsix`, or unknown. */
export type InstallSource = 'gallery' | 'vsix' | undefined;

/**
 * Read the install source from the `extensions.json` that the editor keeps
 * next to the installed extensions. Development copies and unknown layouts
 * give `undefined`.
 */
export async function readInstallSource(extensionPath: string): Promise<InstallSource> {
    let entries: unknown;
    try {
        entries = JSON.parse(await fs.promises.readFile(path.join(path.dirname(extensionPath), 'extensions.json'), 'utf8'));
    } catch {
        return undefined;
    }
    if (!Array.isArray(entries)) {
        return undefined;
    }
    const folder = path.basename(extensionPath);
    for (const entry of entries) {
        const location = entry?.relativeLocation ?? (typeof entry?.location?.fsPath === 'string' ? path.basename(entry.location.fsPath) : undefined);
        if (location === folder) {
            const source = entry?.metadata?.source;
            return source === 'gallery' || source === 'vsix' ? source : undefined;
        }
    }
    return undefined;
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

    /** Called on activation: at most one check per day, never in development or for store installs. */
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
        if (await readInstallSource(this.context.extensionPath) === 'gallery') {
            this.logger.info(`Kasugai ${this.currentVersion} was installed from the extension store; the editor keeps it up to date`);
            if (interactive) {
                void vscode.window.showInformationMessage(t('Kasugai {0} was installed from the extension store, which keeps it up to date. Check the Extensions view for new versions.', this.currentVersion));
            }
            return;
        }

        let latest: ReleaseInfo | undefined;
        try {
            latest = await fetchLatestRelease();
            await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
        } catch (e) {
            this.logger.error('Checking for Kasugai updates failed', e);
            if (interactive) {
                void vscode.window.showErrorMessage(t('Kasugai: could not reach GitHub to check for updates.'));
            }
            return;
        }

        if (!latest || !semver.gt(latest.version, this.currentVersion)) {
            this.logger.info(`Kasugai ${this.currentVersion} is up to date${latest ? ` (latest: ${latest.version})` : ''}`);
            if (interactive) {
                void vscode.window.showInformationMessage(t('Kasugai {0} is up to date.', this.currentVersion));
            }
            return;
        }

        if (!interactive && this.context.globalState.get<string>(SKIPPED_KEY) === latest.version) {
            return;
        }

        const update = t('Update');
        const notes = t('Release Notes');
        const skip = t('Skip This Version');
        const answer = await vscode.window.showInformationMessage(
            t('Kasugai {0} is available (you have {1}).', latest.version, this.currentVersion),
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
                title: t('Downloading Kasugai {0}…', release.version),
            }, () => this.download(release));

            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
            this.logger.info(`Installed Kasugai ${release.version} from ${release.vsixUrl}`);

            const reload = t('Reload Window');
            const answer = await vscode.window.showInformationMessage(t('Kasugai {0} is installed. Reload the window to start using it.', release.version), reload);
            if (answer === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (e) {
            this.logger.error(`Updating Kasugai to ${release.version} failed`, e);
            const open = t('Open Release Page');
            const answer = await vscode.window.showErrorMessage(t('Kasugai: the update failed ({0}). You can install it manually from the release page.', e instanceof Error ? e.message : String(e)), open);
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
