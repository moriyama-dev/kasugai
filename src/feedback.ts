import * as os from 'os';
import * as vscode from 'vscode';

export const REPOSITORY_URL = 'https://github.com/moriyama-dev/kasugai';

/**
 * GitHub rejects very long "new issue" URLs. Keep the encoded body well under
 * the limit; the log is trimmed first so the user's own text is never cut.
 */
const MAX_ENCODED_BODY = 6000;

export type FeedbackKind = 'bug' | 'feature' | 'feedback';

export interface FeedbackReport {
    kind: FeedbackKind;
    title: string;
    description: string;
    /** Masked log lines to attach, oldest first. Empty for none. */
    logLines: string[];
}

export interface FeedbackEnvironment {
    extensionVersion: string;
    editor: string;
    localOS: string;
    remoteOS?: string;
    uiLanguage: string;
    date: string;
}

const KIND_PREFIX: Record<FeedbackKind, string> = {
    bug: '[Bug]',
    feature: '[Feature]',
    feedback: '[Feedback]',
};

function torontoTimestamp(): string {
    try {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'America/Toronto',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
            hour12: false,
        }).format(new Date()) + ' (America/Toronto)';
    } catch {
        return new Date().toISOString();
    }
}

export function currentEnvironment(extensionVersion: string): FeedbackEnvironment {
    return {
        extensionVersion,
        editor: `${vscode.env.appName} ${vscode.version}`,
        localOS: `${os.type()} ${os.release()} (${process.arch})`,
        remoteOS: vscode.env.remoteName ? `connected (${vscode.env.remoteName})` : undefined,
        uiLanguage: vscode.env.language,
        date: torontoTimestamp(),
    };
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove what could identify the user or their machines from log text: the
 * given host and user names, the local user and machine name, home
 * directories, e-mail addresses, IP addresses, private DNS names, host key
 * fingerprints and connection tokens. Versions, error messages and timings
 * stay, which is what a bug report needs.
 */
export function maskPrivate(text: string, known: string[] = []): string {
    let result = text;

    // Secrets first, before any other rule can split them
    result = result.replace(/(connectionToken\W{1,3})[A-Za-z0-9._~-]+/gi, '$1<token>');
    result = result.replace(/\b(token|password|passphrase)(\s*[=:]\s*)\S+/gi, '$1$2<redacted>');
    result = result.replace(/SHA256:[A-Za-z0-9+/]{20,}=*/g, 'SHA256:<fingerprint>');

    // Home directories (before user names, so the path keeps its shape)
    result = result.replace(/\/(home|Users)\/[^/\s'"]+/g, '/$1/<user>');
    result = result.replace(/([A-Za-z]:\\Users\\)[^\\\s'"]+/g, '$1<user>');

    result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    result = result.replace(/\b[A-Za-z0-9._-]+@(?=[A-Za-z0-9<])/g, '<user>@');

    result = result.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, match => match === '127.0.0.1' || match === '0.0.0.0' ? match : '<ip>');
    result = result.replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>');
    result = result.replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local|lan|internal|home\.arpa|home|localdomain)\b/gi, '<host>');

    // Names we know: SSH hosts, the local user and machine. Longest first so a
    // short name inside a longer one does not leave half of it behind.
    const names = [...new Set(known.filter(n => n && n.length >= 3 && n !== '*'))].sort((a, b) => b.length - a.length);
    for (const name of names) {
        result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, 'gi'), '<host>');
    }
    return result;
}

/** Names to mask in addition to the patterns: SSH hosts and this machine. */
export function localPrivateNames(sshHosts: string[]): { hosts: string[]; user: string | undefined } {
    let user: string | undefined;
    try {
        user = os.userInfo().username;
    } catch {
        user = undefined;
    }
    const hosts = [...sshHosts, os.hostname()];
    return { hosts, user };
}

/** Mask `text`, replacing the local user name with `<user>` and hosts with `<host>`. */
export function maskForReport(text: string, hosts: string[], user: string | undefined): string {
    let result = maskPrivate(text, hosts);
    if (user && user.length >= 2) {
        result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(user)}(?![A-Za-z0-9_-])`, 'g'), '<user>');
    }
    return result;
}

function bodyFor(report: FeedbackReport, env: FeedbackEnvironment, logLines: string[]): string {
    const lines = [
        report.kind === 'bug' ? '## What happened' : report.kind === 'feature' ? '## What I would like' : '## Feedback',
        '',
        report.description.trim() || '_(no description)_',
        '',
        '## Environment',
        '',
        `- Kasugai: ${env.extensionVersion}`,
        `- Editor: ${env.editor}`,
        `- Local OS: ${env.localOS}`,
        `- Remote: ${env.remoteOS ?? 'not connected'}`,
        `- UI language: ${env.uiLanguage}`,
        `- Date: ${env.date}`,
    ];
    if (logLines.length) {
        lines.push(
            '',
            `<details><summary>Kasugai log (last ${logLines.length} lines, host and user names masked)</summary>`,
            '',
            '```',
            ...logLines,
            '```',
            '',
            '</details>',
        );
    }
    lines.push('', '<!-- Sent from the Kasugai feedback panel. Please check nothing private is left before submitting. -->');
    return lines.join('\n');
}

/**
 * The URL of a pre-filled GitHub "new issue" page. Nothing is sent until the
 * user presses "Submit" on GitHub. Drops the oldest log lines if the URL would
 * be too long.
 */
export function buildIssueUrl(report: FeedbackReport, env: FeedbackEnvironment): string {
    const title = `${KIND_PREFIX[report.kind]} ${report.title.trim() || 'Untitled'}`;
    let logLines = report.logLines;
    let body = bodyFor(report, env, logLines);
    while (encodeURIComponent(body).length > MAX_ENCODED_BODY && logLines.length) {
        logLines = logLines.slice(Math.max(1, Math.ceil(logLines.length / 4)));
        body = bodyFor(report, env, logLines);
    }
    return `${REPOSITORY_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * Open a new GitHub issue pre-filled with the environment. Only versions and
 * platform names go in: no host names, user names, paths or log contents.
 */
export function reportIssue(extensionVersion: string) {
    const url = buildIssueUrl({ kind: 'bug', title: '', description: '', logLines: [] }, currentEnvironment(extensionVersion));
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
}

export function openRepository() {
    return vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL));
}
