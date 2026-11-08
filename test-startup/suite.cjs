// Runs inside the editor's extension host.
const vscode = require('vscode');
const assert = require('assert');

exports.run = async function run() {
    const extension = vscode.extensions.getExtension('moriyama-dev.kasugai-ssh');
    assert.ok(extension, 'Kasugai is installed');

    const api = await extension.activate();
    assert.ok(extension.isActive, 'Kasugai activated');

    const commands = await vscode.commands.getCommands(true);
    for (const id of ['kasugai.openEmptyWindow', 'kasugai.openConfigFile', 'kasugai.showLog', 'kasugai.killServer', 'kasugai.reportIssue', 'kasugai.openRepository']) {
        assert.ok(commands.includes(id), `command ${id} is registered`);
    }

    const expectResolver = process.env.KASUGAI_EXPECT_RESOLVER === '1';
    assert.strictEqual(api && api.resolverRegistered, expectResolver,
        expectResolver ? 'the SSH resolver is registered' : 'activation survives without the proposed API');

    assert.ok(commands.includes('kasugai.checkForUpdates'), 'command kasugai.checkForUpdates is registered');

    // kasugai.handleSshRemote is on in the test profile
    assert.strictEqual(api && api.sshRemoteRegistered, expectResolver,
        expectResolver ? 'the ssh-remote resolver is registered' : 'no ssh-remote resolver without the proposed API');

    // The Activity Bar panel: the feedback form opens without errors
    assert.ok(commands.includes('kasugai.sendFeedback'), 'command kasugai.sendFeedback is registered');
    await vscode.commands.executeCommand('kasugai.sendFeedback');
    await vscode.commands.executeCommand('kasugaiHosts.focus');

    // The updater installs a downloaded .vsix through this editor command
    if (process.env.KASUGAI_TEST_VSIX) {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(process.env.KASUGAI_TEST_VSIX));
        const fs = require('fs');
        const installed = fs.readdirSync(process.env.KASUGAI_EXTENSIONS_DIR).filter(name => name.startsWith('moriyama-dev.kasugai-ssh-'));
        assert.ok(installed.length > 0, 'the .vsix was installed by workbench.extensions.installExtension');
        console.log(`[kasugai startup] installed from .vsix: ${installed.join(', ')}`);
    }

    console.log(`[kasugai startup] ${vscode.env.appName} ${vscode.version}: activated, resolverRegistered=${api.resolverRegistered}, sshRemoteRegistered=${api.sshRemoteRegistered}`);
};
