import * as os from 'os';
import * as vscode from 'vscode';

export const REPOSITORY_URL = 'https://github.com/moriyama-dev/kasugai';

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

/**
 * Open a new GitHub issue pre-filled with the environment. Only versions and
 * platform names go in: no host names, user names, paths or log contents.
 */
export function reportIssue(extensionVersion: string) {
    const body = [
        '## What happened',
        '',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '',
        '## Environment',
        '',
        `- Kasugai: ${extensionVersion}`,
        `- Editor: ${vscode.env.appName} ${vscode.version}`,
        `- Local OS: ${os.type()} ${os.release()} (${process.arch})`,
        `- Remote OS: `,
        `- UI language: ${vscode.env.language}`,
        `- Date: ${torontoTimestamp()}`,
        '',
        '<!-- Please remove host names, user names and other private details from any log you paste ("Kasugai: Show Log"). -->',
    ].join('\n');

    const url = `${REPOSITORY_URL}/issues/new?body=${encodeURIComponent(body)}`;
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
}

export function openRepository() {
    return vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL));
}
