import * as vscode from 'vscode';
import { Log } from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY, COMPAT_SSH_AUTHORITY, isSshRemoteHandled } from './authResolver';
import { openSSHConfigFile, promptOpenRemoteSSHWindow } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { openRepository, reportIssue } from './feedback';
import { FeedbackViewProvider } from './feedbackView';
import { offerProposedApiSetup } from './setup';
import { Updater } from './updater';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Kasugai');
    context.subscriptions.push(logger);

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(remoteSSHResolver);
    let resolverRegistered = false;
    try {
        context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
        resolverRegistered = true;
    } catch (e) {
        // Proposed API not granted: keep the rest of the extension working and
        // help the user enable it instead of failing activation
        logger.error('Kasugai cannot register its SSH resolver (proposed API not enabled)', e);
        void offerProposedApiSetup(context.extension?.id ?? 'moriyama-dev.kasugai-ssh', logger);
    }

    // Opt-in: also serve `ssh-remote+...` windows, which other tools (e.g. the
    // Tailscale extension) open on the assumption that an SSH remote
    // extension of that name is installed.
    let sshRemoteRegistered = false;
    if (resolverRegistered && isSshRemoteHandled()) {
        try {
            context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(COMPAT_SSH_AUTHORITY, remoteSSHResolver));
            sshRemoteRegistered = true;
            logger.info(`Kasugai also resolves '${COMPAT_SSH_AUTHORITY}' windows (kasugai.handleSshRemote)`);
        } catch (e) {
            // Another SSH remote extension (open-remote-ssh, Remote - SSH)
            // registered it first. Only one extension can own an authority.
            logger.error(`Kasugai cannot resolve '${COMPAT_SSH_AUTHORITY}': another extension already does`, e);
            void vscode.window.showWarningMessage(
                `Kasugai: "kasugai.handleSshRemote" is on, but another SSH remote extension already handles "${COMPAT_SSH_AUTHORITY}" windows. Disable that extension, or turn the setting off.`
            );
        }
    }

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(vscode.window.createTreeView('kasugaiHosts', { treeDataProvider: hostTreeDataProvider }));
    context.subscriptions.push(hostTreeDataProvider);

    context.subscriptions.push(vscode.commands.registerCommand('kasugai.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.killServer', () => remoteSSHResolver.killServerOnHost()));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.reportIssue', () => reportIssue(String(context.extension?.packageJSON?.version ?? 'unknown'))));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.openRepository', () => openRepository()));

    const feedbackView = new FeedbackViewProvider(logger, String(context.extension?.packageJSON?.version ?? 'unknown'));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(FeedbackViewProvider.viewId, feedbackView, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.sendFeedback', () => feedbackView.reveal()));

    const updater = new Updater(context, logger);
    context.subscriptions.push(updater);
    context.subscriptions.push(vscode.commands.registerCommand('kasugai.checkForUpdates', () => updater.check(true)));
    updater.checkInBackground();

    // Read by the start-up tests
    return { resolverRegistered, sshRemoteRegistered };
}

export function deactivate() {
}
