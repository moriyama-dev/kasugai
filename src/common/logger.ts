import * as vscode from 'vscode';
import { padLeft } from '../utils/pad-left';
import { toString } from '../utils/to-string';

type LogLevel = 'Trace' | 'Info' | 'Error';

/** How many recent log lines are kept in memory for feedback reports. */
const RECENT_LINES = 300;

export class Log {
    private output: vscode.OutputChannel;
    private readonly recent: string[] = [];

    constructor(name: string) {
        this.output = vscode.window.createOutputChannel(name);
    }

    public trace(message: string, data?: unknown): void {
        this.logLevel('Trace', message, data);
    }

    public info(message: string, data?: unknown): void {
        this.logLevel('Info', message, data);
    }

    public error(message: string, data?: unknown): void {
        this.logLevel('Error', message, data);
    }

    public logLevel(level: LogLevel, message: string, data?: unknown): void {
        this.append(`[${level}  - ${this.now()}] ${message}`);
        if (data) {
            this.append(toString(data));
        }
    }

    private append(text: string) {
        this.output.appendLine(text);
        this.recent.push(...text.split('\n'));
        if (this.recent.length > RECENT_LINES) {
            this.recent.splice(0, this.recent.length - RECENT_LINES);
        }
    }

    /** The last `count` lines written to this log, unmasked. */
    public recentLines(count = RECENT_LINES): string[] {
        return this.recent.slice(-count);
    }

    private now(): string {
        const now = new Date();
        return padLeft(now.getUTCHours() + '', 2, '0')
            + ':' + padLeft(now.getMinutes() + '', 2, '0')
            + ':' + padLeft(now.getUTCSeconds() + '', 2, '0') + '.' + now.getMilliseconds();
    }

    public show() {
        this.output.show();
    }

    public dispose() {
        this.output.dispose();
    }
}
