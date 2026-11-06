import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { addToArgvJson } from '../src/setup';

const ID = 'moriyama-dev.kasugai-ssh';

describe('addToArgvJson', () => {
    const dirs: string[] = [];
    const tempFile = (content?: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'kasugai-argv-'));
        dirs.push(dir);
        const file = join(dir, 'argv.json');
        if (content !== undefined) {
            writeFileSync(file, content);
        }
        return file;
    };
    afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

    it('keeps comments and other keys', async () => {
        const file = tempFile('// This configuration file allows you to pass permanent command line arguments.\n{\n\t// Use software rendering\n\t"disable-hardware-acceleration": true,\n}\n');
        await addToArgvJson(file, ID);
        const text = readFileSync(file, 'utf8');
        expect(text).toContain('// Use software rendering');
        expect(parse(text)).toEqual({ 'disable-hardware-acceleration': true, 'enable-proposed-api': [ID] });
    });

    it('appends to an existing list once', async () => {
        const file = tempFile('{ "enable-proposed-api": ["jeanp413.open-remote-ssh"] }');
        await addToArgvJson(file, ID);
        await addToArgvJson(file, ID);
        expect(parse(readFileSync(file, 'utf8'))['enable-proposed-api']).toEqual(['jeanp413.open-remote-ssh', ID]);
    });

    it('creates the file when missing', async () => {
        const file = tempFile();
        await addToArgvJson(file, ID);
        expect(parse(readFileSync(file, 'utf8'))).toEqual({ 'enable-proposed-api': [ID] });
    });
});
