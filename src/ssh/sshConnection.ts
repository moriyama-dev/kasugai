// From https://github.com/sanketbajoria/ssh2-promise

import { EventEmitter } from 'events';
import * as net from 'net';
import * as fs from 'fs';
import { Client, ClientChannel, ClientErrorExtensions, ExecOptions, ShellOptions, ConnectConfig } from 'ssh2';
import { Server } from 'net';
import type { Duplex } from 'stream';

export interface SSHConnectConfig extends ConnectConfig {
    /** Optional Unique ID attached to ssh connection. */
    uniqueId?: string;
    /** Automatic retry to connect, after disconnect. Default true */
    reconnect?: boolean;
    /** Number of reconnect retry, after disconnect. Default 10 */
    reconnectTries?: number;
    /** Delay after which reconnect should be done. Default 5000ms */
    reconnectDelay?: number;
    /** Path to private key */
    identity?: string | Buffer;
    /**
     * Builds a fresh transport stream for every connection attempt. Needed to
     * reconnect through a ProxyJump/ProxyCommand: a stream cannot be reused once
     * the SSH session riding on it has closed.
     */
    sockFactory?: () => Promise<Duplex | undefined>;
    /**
     * Builds a fresh authentication handler for every connection attempt, so
     * that a reconnect starts again from the first identity instead of the
     * state the previous attempt left behind.
     */
    authHandlerFactory?: () => ConnectConfig['authHandler'];
    /**
     * Kasugai: after an established session drops, keep re-establishing it in
     * the background so the local tunnels come back without user action.
     */
    autoReconnect?: AutoReconnectOptions;
}

export interface AutoReconnectOptions {
    /** Give up after this long without a working session, in milliseconds. */
    maxDurationMs: number;
    /** First retry delay, in milliseconds. Doubles up to `maxDelayMs`. */
    initialDelayMs: number;
    maxDelayMs: number;
}

export interface SSHTunnelConfig {
    /** Remote Address to connect */
    remoteAddr?: string;
    /** Local port to bind to. By default, it will bind to a random port, if not passed */
    localPort?: number;
    /** Remote Port to connect */
    remotePort?: number;
    /** Remote socket path to connect */
    remoteSocketPath?: string;
    socks?: boolean;
    /**  Unique name */
    name?: string;
}

const defaultOptions: Partial<SSHConnectConfig> = {
    reconnect: false,
    port: 22,
    reconnectTries: 3,
    reconnectDelay: 5000
};

const SSHConstants = {
    'CHANNEL': {
        SSH: 'ssh',
        TUNNEL: 'tunnel',
        X11: 'x11'
    },
    'STATUS': {
        BEFORECONNECT: 'beforeconnect',
        CONNECT: 'connect',
        BEFOREDISCONNECT: 'beforedisconnect',
        DISCONNECT: 'disconnect'
    }
};

export default class SSHConnection extends EventEmitter {
    public config: SSHConnectConfig;

    private activeTunnels: { [index: string]: SSHTunnelConfig & { server: Server } } = {};
    private __$connectPromise: Promise<SSHConnection> | null = null;
    private __retries: number = 0;
    private __err: Error & ClientErrorExtensions & { code?: string } | null = null;

    /** The last error reported by the underlying client, if any. */
    get lastError() {
        return this.__err;
    }
    private sshConnection: Client | null = null;
    /** True while `sshConnection` has completed its handshake and not closed yet. */
    private ready = false;
    /** Set by close(): never reconnect after the owner disposed the connection. */
    private disposed = false;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private reconnectStartedAt = 0;
    private reconnectAttempt = 0;

    constructor(options: SSHConnectConfig) {
        super();
        this.config = Object.assign({}, defaultOptions, options);
        this.config.uniqueId = this.config.uniqueId || `${this.config.username}@${this.config.host}`;
    }

    /**
      * Emit message on this channel
      */
    override emit(channel: string, status: string, payload?: unknown): boolean {
        super.emit(channel, status, this, payload);
        return super.emit(`${channel}:${status}`, this, payload);
    }

    /**
     * Get shell socket
     */
    shell(options: ShellOptions = {}): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise<ClientChannel>((resolve, reject) => {
                this.sshConnection!.shell(options, (err, stream) => err ? reject(err) : resolve(stream));
            });
        });
    }

    /**
     * Start a command and return its channel as soon as it's opened, without
     * waiting for it to finish. Unlike shell(), no pty is allocated, so there's
     * no local echo of anything written to the channel.
     */
    execChannel(cmd: string, options: ExecOptions = {}): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise<ClientChannel>((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => err ? reject(err) : resolve(stream));
            });
        });
    }

    /**
     * Exec a command
     */
    exec(cmd: string, params?: Array<string>, options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('close', function () {
                        return resolve({ stdout, stderr });
                    }).on('data', function (data: Buffer | string) {
                        stdout += data.toString();
                    }).stderr.on('data', function (data: Buffer | string) {
                        stderr += data.toString();
                    });
                });
            });
        });
    }

    /**
     * Exec a command
     */
    execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: Array<string>, options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.exec(cmd, options, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    let stdout = '';
                    let stderr = '';
                    let resolved = false;
                    stream.on('close', function () {
                        if (!resolved) {
                            return resolve({ stdout, stderr });
                        }
                    }).on('data', function (data: Buffer | string) {
                        stdout += data.toString();

                        if (tester(stdout, stderr)) {
                            resolved = true;

                            return resolve({ stdout, stderr });
                        }
                    }).stderr.on('data', function (data: Buffer | string) {
                        stderr += data.toString();

                        if (tester(stdout, stderr)) {
                            resolved = true;

                            return resolve({ stdout, stderr });
                        }
                    });
                });
            });
        });
    }

    /**
     * Forward out
     */
    forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<ClientChannel> {
        return this.connect().then(() => {
            return new Promise((resolve, reject) => {
                this.sshConnection!.forwardOut(srcIP, srcPort, destIP, destPort, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve(stream);
                });
            });
        });
    }

    /**
     * Close SSH Connection
     */
    close(): Promise<void> {
        this.disposed = true;
        this.ready = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.BEFOREDISCONNECT);
        return this.closeTunnel().then(() => {
            if (this.sshConnection) {
                this.sshConnection.end();
                this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.DISCONNECT);
            }
        });
    }

    /** Whether a session is currently established. */
    get isConnected(): boolean {
        return this.ready;
    }

    /**
     * Connect the SSH Connection. Idempotent while a session is up or being
     * set up; once the session has dropped, the next call opens a new one.
     */
    connect(c?: SSHConnectConfig): Promise<SSHConnection> {
        this.config = Object.assign(this.config, c);
        ++this.__retries;

        if (this.disposed) {
            return Promise.reject(new Error('SSH connection has been closed'));
        }

        if (this.__$connectPromise) {
            return this.__$connectPromise;
        }

        const promise = this.__$connectPromise = this.establish();
        promise.catch(() => {
            // A failed attempt must not be handed out to later callers
            if (this.__$connectPromise === promise) {
                this.__$connectPromise = null;
            }
        });
        return promise;
    }

    private async establish(): Promise<SSHConnection> {
        this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.BEFORECONNECT);
        if (!this.config || typeof this.config === 'function' || !(this.config.host || this.config.sock || this.config.sockFactory) || !this.config.username) {
            throw new Error(`Invalid SSH connection configuration host/username can't be empty`);
        }

        if (this.config.identity) {
            if (fs.existsSync(this.config.identity)) {
                this.config.privateKey = fs.readFileSync(this.config.identity);
            }
            delete this.config.identity;
        }

        const connectConfig: ConnectConfig = { ...this.config };
        if (this.config.sockFactory) {
            connectConfig.sock = await this.config.sockFactory();
        }
        if (this.config.authHandlerFactory) {
            connectConfig.authHandler = this.config.authHandlerFactory();
        }
        for (const key of ['sockFactory', 'authHandlerFactory', 'autoReconnect', 'reconnect', 'reconnectTries', 'reconnectDelay', 'uniqueId'] as const) {
            delete (connectConfig as Record<string, unknown>)[key];
        }

        return new Promise<SSHConnection>((resolve, reject) => {
            const client = new Client();
            let settled = false;
            let lastError: Error & ClientErrorExtensions & { code?: string } | null = null;

            this.sshConnection = client;
            client.on('connect', () => {
                // ssh2 leaves Nagle's algorithm on, which delays small writes
                // (keystrokes, LSP messages) by up to one delayed-ACK period
                const sock = (client as unknown as { _sock?: { setNoDelay?: (v: boolean) => void; setKeepAlive?: (v: boolean, d: number) => void } })._sock;
                sock?.setNoDelay?.(true);
                sock?.setKeepAlive?.(true, 15_000);
            }).on('ready', () => {
                settled = true;
                this.ready = true;
                this.__retries = 0;
                this.__err = null;
                this.reconnectAttempt = 0;
                this.reconnectStartedAt = 0;
                this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.CONNECT);
                resolve(this);
            }).on('error', (err) => {
                lastError = err;
                this.__err = err;
                this.emit(SSHConstants.CHANNEL.SSH, 'error', { err });
            }).on('close', () => {
                const wasReady = this.ready && this.sshConnection === client;
                if (this.sshConnection === client) {
                    this.ready = false;
                    this.__$connectPromise = null;
                }
                this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.DISCONNECT, { err: lastError });

                if (!settled) {
                    settled = true;
                    reject(lastError ?? new Error('SSH connection closed before it was ready'));
                    return;
                }

                if (wasReady && !this.disposed) {
                    this.emit(SSHConstants.CHANNEL.SSH, 'dropped', { err: lastError });
                    this.scheduleReconnect();
                }
            });

            try {
                client.connect(connectConfig);
            } catch (err) {
                settled = true;
                reject(err);
            }
        });
    }

    /**
     * Re-establish a dropped session in the background with exponential
     * backoff, so the tunnels are usable again by the time the editor retries.
     */
    private scheduleReconnect() {
        const options = this.config.autoReconnect;
        if (!options || this.disposed || this.reconnectTimer) {
            return;
        }
        if (!this.reconnectStartedAt) {
            this.reconnectStartedAt = Date.now();
        }
        if (Date.now() - this.reconnectStartedAt > options.maxDurationMs) {
            this.emit(SSHConstants.CHANNEL.SSH, 'gaveup', { attempts: this.reconnectAttempt });
            return;
        }

        const delay = Math.min(options.initialDelayMs * 2 ** this.reconnectAttempt, options.maxDelayMs);
        this.reconnectAttempt++;
        this.emit(SSHConstants.CHANNEL.SSH, 'reconnecting', { attempt: this.reconnectAttempt, delay });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.disposed || this.ready) {
                return;
            }
            this.connect().then(() => {
                this.emit(SSHConstants.CHANNEL.SSH, 'reconnected', { attempt: this.reconnectAttempt });
            }, (err: Error & ClientErrorExtensions) => {
                if (err?.level === 'client-authentication') {
                    // Retrying cannot fix rejected credentials
                    this.emit(SSHConstants.CHANNEL.SSH, 'gaveup', { attempts: this.reconnectAttempt, err });
                    return;
                }
                this.scheduleReconnect();
            });
        }, delay);
    }

    /**
     * Get existing tunnel by name
     */
    getTunnel(name: string) {
        return this.activeTunnels[name];
    }

    /**
     * Add new tunnel if not exist
     */
    addTunnel(SSHTunnelConfig: SSHTunnelConfig): Promise<SSHTunnelConfig & { server: Server }> {
        SSHTunnelConfig.name = SSHTunnelConfig.name || `${SSHTunnelConfig.remoteAddr}@${SSHTunnelConfig.remotePort || SSHTunnelConfig.remoteSocketPath}`;
        this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.BEFORECONNECT, { SSHTunnelConfig: SSHTunnelConfig });
        if (this.getTunnel(SSHTunnelConfig.name)) {
            this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, { SSHTunnelConfig: SSHTunnelConfig });
            return Promise.resolve(this.getTunnel(SSHTunnelConfig.name));
        } else {
            return new Promise((resolve, reject) => {
                // In-process SSH: every forwarded connection gets its own
                // channel directly, no SOCKS hop needed
                const server: net.Server = net.createServer()
                    .on('connection', (socket) => {
                        socket.setNoDelay(true);
                        // Without a listener a reset local socket would throw
                        // and take the whole extension host down
                        socket.on('error', () => socket.destroy());
                        this.forwardTunnelSocket(SSHTunnelConfig).then((stream) => {
                            pipeBoth(socket, stream);
                        }, (err: unknown) => {
                            this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, { SSHTunnelConfig: SSHTunnelConfig, err: err });
                            socket.destroy();
                        });
                    });

                SSHTunnelConfig.localPort = SSHTunnelConfig.localPort || 0;
                server.on('listening', () => {
                    SSHTunnelConfig.localPort = (server.address() as net.AddressInfo).port;
                    this.activeTunnels[SSHTunnelConfig.name!] = Object.assign({}, { server }, SSHTunnelConfig);
                    this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, { SSHTunnelConfig: SSHTunnelConfig });
                    resolve(this.activeTunnels[SSHTunnelConfig.name!]);
                }).on('error', (err: unknown) => {
                    this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, { SSHTunnelConfig: SSHTunnelConfig, err: err });
                    server.close();
                    reject(err);
                    delete this.activeTunnels[SSHTunnelConfig.name!];
                }).listen(SSHTunnelConfig.localPort, '127.0.0.1');
            });
        }
    }

    /**
     * Close the tunnel
     */
    closeTunnel(name?: string): Promise<void> {
        if (name && this.activeTunnels[name]) {
            return new Promise((resolve) => {
                const tunnel = this.activeTunnels[name];
                this.emit(
                    SSHConstants.CHANNEL.TUNNEL,
                    SSHConstants.STATUS.BEFOREDISCONNECT,
                    { SSHTunnelConfig: tunnel }
                );
                tunnel.server.close(() => {
                    this.emit(
                        SSHConstants.CHANNEL.TUNNEL,
                        SSHConstants.STATUS.DISCONNECT,
                        { SSHTunnelConfig: this.activeTunnels[name] }
                    );
                    delete this.activeTunnels[name];
                    resolve();
                });
            });
        } else if (!name) {
            const tunnels = Object.keys(this.activeTunnels).map((key) => this.closeTunnel(key));
            return Promise.all(tunnels).then(() => { });
        }

        return Promise.resolve();
    }

    /**
     * Open the SSH side of one tunnelled connection, waiting for a dropped
     * session to come back first.
     */
    private async forwardTunnelSocket(tunnel: SSHTunnelConfig): Promise<ClientChannel> {
        await this.connect();
        const ssh = this.sshConnection!;
        return new Promise<ClientChannel>((resolve, reject) => {
            if (tunnel.remotePort) {
                ssh.forwardOut('127.0.0.1', 0, tunnel.remoteAddr!, tunnel.remotePort, (err, stream) => err ? reject(err) : resolve(stream));
            } else {
                ssh.openssh_forwardOutStreamLocal(tunnel.remoteSocketPath!, (err, stream) => err ? reject(err) : resolve(stream));
            }
        });
    }
}

/**
 * Connect two streams in both directions and tear both down as soon as either
 * side ends or fails, so a broken half never lingers or throws unhandled.
 */
export function pipeBoth(a: NodeJS.ReadWriteStream & { destroy(err?: Error): unknown }, b: NodeJS.ReadWriteStream & { destroy(err?: Error): unknown }) {
    let closed = false;
    const teardown = () => {
        if (closed) {
            return;
        }
        closed = true;
        a.destroy();
        b.destroy();
    };
    a.on('error', teardown).on('close', teardown);
    b.on('error', teardown).on('close', teardown);
    a.pipe(b);
    b.pipe(a);
}
