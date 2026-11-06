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

    console.log(`[kasugai startup] ${vscode.env.appName} ${vscode.version}: activated, resolverRegistered=${api.resolverRegistered}`);
};
