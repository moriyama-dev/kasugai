import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { buildIssueUrl, maskForReport, maskPrivate, type FeedbackEnvironment } from '../src/feedback';
import { isKasugaiAuthorityType } from '../src/authResolver';

const ENV: FeedbackEnvironment = {
    extensionVersion: '0.3.0',
    editor: 'VSCodium 1.106.0',
    localOS: 'Linux 7.0.0 (x64)',
    uiLanguage: 'ja',
    date: '2026-11-06 14:30 (America/Toronto)',
};

const decodeBody = (url: string) => decodeURIComponent(new URL(url).searchParams.get('body') ?? '');

describe('maskPrivate', () => {
    it('masks Tailscale names, IP addresses and e-mail addresses', () => {
        const masked = maskPrivate('Connecting to dev-on-github.tail24ad8b.ts.net (100.101.102.103) as takumi.webservice@gmail.com');
        expect(masked).toBe('Connecting to <host> (<ip>) as <email>');
    });

    it('keeps the loopback address, versions and timings', () => {
        expect(maskPrivate('Tunnel 127.0.0.1:41234 ready in 1.2.3 build 812ms')).toBe('Tunnel 127.0.0.1:41234 ready in 1.2.3 build 812ms');
    });

    it('masks known SSH host names, longest first, without touching other words', () => {
        const masked = maskPrivate('Resolving dev-on-github then dev, the developer host', ['dev', 'dev-on-github']);
        expect(masked).toBe('Resolving <host> then <host>, the developer host');
    });

    it('masks home directories, user@host, fingerprints and connection tokens', () => {
        const text = [
            'Trying publickey authentication: /home/yoshi/.ssh/id_ed25519 ssh-ed25519 SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
            'yoshi@vm-base-server: connectionToken==0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0==',
            'password: hunter22',
        ].join('\n');
        const masked = maskPrivate(text, ['vm-base-server']);
        expect(masked).not.toMatch(/yoshi|vm-base-server|hunter22|0f1e2d3c|abcdefghij/);
        expect(masked).toContain('/home/<user>/.ssh/id_ed25519');
        expect(masked).toContain('SHA256:<fingerprint>');
        expect(masked).toContain('connectionToken==<token>');
    });

    it('masks the local user name with maskForReport', () => {
        expect(maskForReport('started by yoshi on raspberrypi', ['raspberrypi'], 'yoshi')).toBe('started by <user> on <host>');
    });
});

describe('buildIssueUrl', () => {
    it('prefixes the title with the kind and puts the description and environment in the body', () => {
        const url = buildIssueUrl({ kind: 'feature', title: 'Show latency', description: 'Please show the ping.', logLines: [] }, ENV);
        expect(url.startsWith('https://github.com/moriyama-dev/kasugai/issues/new?')).toBe(true);
        expect(decodeURIComponent(new URL(url).searchParams.get('title') ?? '')).toBe('[Feature] Show latency');
        const body = decodeBody(url);
        expect(body).toContain('Please show the ping.');
        expect(body).toContain('- Kasugai: 0.3.0');
        expect(body).not.toContain('<details>');
    });

    it('drops the oldest log lines to stay under the URL limit but keeps the text', () => {
        const logLines = Array.from({ length: 400 }, (_, i) => `[Info  - 12:00:00.0] line ${i} ${'x'.repeat(60)}`);
        const url = buildIssueUrl({ kind: 'bug', title: 'Disconnects', description: 'It drops every hour.', logLines }, ENV);
        const body = decodeBody(url);
        expect(encodeURIComponent(body).length).toBeLessThanOrEqual(6000);
        expect(body).toContain('It drops every hour.');
        expect(body).toContain('line 399');
        expect(body).not.toContain('line 0 ');
    });
});

describe('ssh-remote compatibility', () => {
    afterEach(() => {
        (vscode.workspace as unknown as { resetConfiguration: () => void }).resetConfiguration();
    });

    it('resolves kasugai-ssh always and ssh-remote only when kasugai.handleSshRemote is on', () => {
        expect(isKasugaiAuthorityType('kasugai-ssh')).toBe(true);
        expect(isKasugaiAuthorityType('ssh-remote')).toBe(false);
        (vscode.workspace as unknown as { setConfiguration: (k: string, v: unknown) => void }).setConfiguration('handleSshRemote', true);
        expect(isKasugaiAuthorityType('ssh-remote')).toBe(true);
        expect(isKasugaiAuthorityType('wsl')).toBe(false);
    });
});
