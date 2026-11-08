import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Log } from './common/logger';
import SSHConfiguration from './ssh/sshConfig';
import { buildIssueUrl, currentEnvironment, FeedbackKind, localPrivateNames, maskForReport, REPOSITORY_URL } from './feedback';

/** How many recent log lines a report can carry. */
const LOG_LINES = 120;

const STRINGS = {
    en: {
        intro: 'Found a problem or have an idea? Write it here. GitHub opens with your report filled in; nothing is sent until you press "Submit new issue" there.',
        kind: 'Type',
        bug: 'Something is broken',
        feature: 'Feature request',
        feedback: 'Opinion / other',
        title: 'Title',
        titlePlaceholder: 'One line: what happened, or what you want',
        description: 'Details',
        descriptionPlaceholder: 'What did you do, what did you expect, what happened instead?',
        attachLog: 'Attach the recent Kasugai log (host names, user names, IP addresses and tokens are masked)',
        preview: 'Preview the log',
        send: 'Open on GitHub',
        needText: 'Please write a title or some details first.',
        showLog: 'Show full log',
        repository: 'GitHub repository',
        sent: 'Opened GitHub in your browser. Check the text and press "Submit new issue".',
        emptyLog: '(the log is empty)',
    },
    ja: {
        intro: '困ったことや「こうしてほしい」を書いてください。内容を入れた GitHub の画面がブラウザで開きます。そこで「Submit new issue」を押すまで、どこにも送られません。',
        kind: '種類',
        bug: '不具合（動かない・エラー）',
        feature: '機能の要望',
        feedback: '意見・その他',
        title: '件名',
        titlePlaceholder: '何が起きたか、何がほしいかを 1 行で',
        description: '詳しく',
        descriptionPlaceholder: '何をしたら、何が起きたか。本当はどうなってほしかったか。',
        attachLog: '最近の Kasugai のログを付ける（ホスト名・ユーザー名・IP アドレス・トークンは伏せます）',
        preview: '付けるログを見る',
        send: 'GitHub で開く',
        needText: '件名か詳しい内容を書いてください。',
        showLog: 'ログ全体を見る',
        repository: 'GitHub のリポジトリ',
        sent: 'ブラウザで GitHub を開きました。内容を確かめて「Submit new issue」を押してください。',
        emptyLog: '（ログはまだありません）',
    },
};

type Strings = typeof STRINGS.en;

interface SendMessage {
    type: 'send';
    kind: FeedbackKind;
    title: string;
    description: string;
    attachLog: boolean;
}

type IncomingMessage = SendMessage | { type: 'preview' } | { type: 'showLog' } | { type: 'openRepository' };

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'kasugaiFeedback';

    private view: vscode.WebviewView | undefined;

    constructor(
        private readonly logger: Log,
        private readonly extensionVersion: string
    ) {
    }

    private strings(): Strings {
        return vscode.env.language.toLowerCase().startsWith('ja') ? STRINGS.ja : STRINGS.en;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
        webviewView.webview.html = this.html(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message: IncomingMessage) => this.onMessage(message));
    }

    /** Show the panel, e.g. from the "Send Feedback..." command. */
    async reveal() {
        await vscode.commands.executeCommand(`${FeedbackViewProvider.viewId}.focus`);
    }

    private async maskedLog(): Promise<string[]> {
        let sshHosts: string[] = [];
        try {
            const config = await SSHConfiguration.loadFromFS();
            sshHosts = config.getAllConfiguredHosts();
            // HostName values behind the aliases are just as private
            for (const host of [...sshHosts]) {
                const hostName = config.getHostConfiguration(host)['HostName'];
                if (typeof hostName === 'string') {
                    sshHosts.push(hostName);
                }
            }
        } catch {
            // No ssh config: the patterns still apply
        }
        const { hosts, user } = localPrivateNames(sshHosts);
        return this.logger.recentLines(LOG_LINES).map(line => maskForReport(line, hosts, user));
    }

    private async onMessage(message: IncomingMessage) {
        const s = this.strings();
        switch (message.type) {
            case 'preview': {
                const lines = await this.maskedLog();
                const doc = await vscode.workspace.openTextDocument({ content: lines.length ? lines.join('\n') : s.emptyLog, language: 'log' });
                await vscode.window.showTextDocument(doc, { preview: true });
                return;
            }
            case 'showLog':
                this.logger.show();
                return;
            case 'openRepository':
                await vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL));
                return;
            case 'send': {
                if (!message.title.trim() && !message.description.trim()) {
                    void vscode.window.showWarningMessage(s.needText);
                    return;
                }
                const logLines = message.attachLog ? await this.maskedLog() : [];
                const url = buildIssueUrl({
                    kind: message.kind,
                    title: message.title,
                    description: message.description,
                    logLines,
                }, currentEnvironment(this.extensionVersion));
                const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
                if (opened) {
                    void this.view?.webview.postMessage({ type: 'sent' });
                    void vscode.window.showInformationMessage(s.sent);
                }
                return;
            }
        }
    }

    private html(webview: vscode.Webview): string {
        const s = this.strings();
        const nonce = randomBytes(16).toString('base64');
        const e = escapeHtml;
        return `<!DOCTYPE html>
<html lang="${vscode.env.language.startsWith('ja') ? 'ja' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 4px 12px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  p.intro { color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 6px 0 12px; }
  label.field { display: block; margin: 10px 0 4px; font-weight: 600; }
  select, input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: inherit; font-size: inherit;
  }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
  textarea { min-height: 120px; resize: vertical; }
  select:focus, input:focus, textarea:focus, button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .check { display: flex; gap: 6px; align-items: flex-start; margin: 12px 0 4px; line-height: 1.4; }
  .check input { margin-top: 2px; }
  button.primary {
    width: 100%; margin-top: 12px; padding: 6px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.link { background: none; border: none; padding: 0; cursor: pointer; color: var(--vscode-textLink-foreground); font: inherit; }
  button.link:hover { text-decoration: underline; }
  .links { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 14px; }
  .preview { margin-left: 22px; }
</style>
</head>
<body>
<p class="intro">${e(s.intro)}</p>
<form id="form">
  <label class="field" for="kind">${e(s.kind)}</label>
  <select id="kind">
    <option value="bug">${e(s.bug)}</option>
    <option value="feature">${e(s.feature)}</option>
    <option value="feedback">${e(s.feedback)}</option>
  </select>
  <label class="field" for="title">${e(s.title)}</label>
  <input id="title" type="text" maxlength="200" placeholder="${e(s.titlePlaceholder)}">
  <label class="field" for="description">${e(s.description)}</label>
  <textarea id="description" placeholder="${e(s.descriptionPlaceholder)}"></textarea>
  <label class="check"><input id="attachLog" type="checkbox" checked><span>${e(s.attachLog)}</span></label>
  <div class="preview"><button type="button" class="link" id="preview">${e(s.preview)}</button></div>
  <button type="submit" class="primary">${e(s.send)}</button>
</form>
<div class="links">
  <button type="button" class="link" id="showLog">${e(s.showLog)}</button>
  <button type="button" class="link" id="repo">${e(s.repository)}</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const fields = ['kind', 'title', 'description', 'attachLog'];
  const saved = vscode.getState() || {};
  for (const id of fields) {
    if (saved[id] === undefined) continue;
    if (id === 'attachLog') $(id).checked = saved[id]; else $(id).value = saved[id];
  }
  const save = () => vscode.setState(Object.fromEntries(fields.map(id => [id, id === 'attachLog' ? $(id).checked : $(id).value])));
  for (const id of fields) $(id).addEventListener('input', save);
  $('attachLog').addEventListener('change', save);
  $('form').addEventListener('submit', event => {
    event.preventDefault();
    vscode.postMessage({ type: 'send', kind: $('kind').value, title: $('title').value, description: $('description').value, attachLog: $('attachLog').checked });
  });
  $('preview').addEventListener('click', () => vscode.postMessage({ type: 'preview' }));
  $('showLog').addEventListener('click', () => vscode.postMessage({ type: 'showLog' }));
  $('repo').addEventListener('click', () => vscode.postMessage({ type: 'openRepository' }));
  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'sent') {
      $('title').value = '';
      $('description').value = '';
      save();
    }
  });
</script>
</body>
</html>`;
    }
}
