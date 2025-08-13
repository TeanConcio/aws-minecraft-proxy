import fs from "fs";
import path from "path";
import dirname from "./dirname.cjs";
const { __dirname } = dirname;

import { config } from "./config.js";
import mc from "minecraft-protocol";
import net from "net";
import stream from "stream";
import Checker from "./checker.js";
import { EventEmitter } from "events";
import { silly, info, error } from "./debug.js";
import { version } from "os";

const STATES = {
    unknown: 0,
    active: 1,
    inactive: 2,
    starting: 3,
    stopping: 4,
    unauthorized: 5
};

function createNoopStream() {
    return new stream.Duplex({
        write(chunk, encoding, next) {
            next();
        },
        read() {},
    });
}


export default class ProxyServer extends EventEmitter {
    constructor(
        /**@type {number}*/ listenPort,
        /**@type {string}*/ targetHost,
        /**@type {number}*/ targetPort,
        /**@type {mc.ServerOptions}*/ mcProtocolArgs = {}
    ) {
        super();
        this.checker = new Checker(targetHost, targetPort);
        this.currentState = {
            state: STATES.unknown,
            time: Date.now(),
        };
        this.players = {
            count: 0,
            time: Date.now(),
        };

        // initialize the whitelist if enabled
        this.whitelistFile = null;
        if( ( config.whitelist.enabled || config.whitelist.enabled === 'true' ) && 
            config.whitelist.path !== null && config.whitelist.path !== undefined && config.whitelist.path !== '' )
        {
            this.whitelistFile = ( config.whitelist.path.charAt(0) == '/' ? config.whitelist.path : path.join( __dirname, '..', config.whitelist.path ) );
        }

        // create the server we use to intercept the pings
        this.server = mc.createServer({
            port: listenPort,
            "online-mode": config.proxy.online_mode || true,
            version: config.proxy.version || false,
            keepAlive: false,
            beforePing: this.beforePing.bind(this),
            ...mcProtocolArgs,
        });
        this.server.on("connection", this.handleClient.bind(this));
        this.server.on("login", this.handleLogin.bind(this));
        this.server.on("listening", () => {
            info(`Listening on :${listenPort}`);
        });

        // start checking if the remote is up
        this._updateTimeout = undefined;
        this.update = this.update.bind(this);
        this.update();
    }

    close() {
        this.checker.close();
        this.server.close();
        clearTimeout(this._updateTimeout);
    }

    setState(state, force = false) {
        if (this.currentState.state === state && !force) {
            return;
        }

        silly(`Setting state to ${STATES[state]}`);
        this.currentState = {
            state: state,
            time: Date.now(),
        };

        switch (state) {
            case STATES.starting:
                // info("Starting");
                this.emit("start");
                break;
            case STATES.stopping:
                // info("Stopping");
                this.emit("stop");
                break;
            case STATES.unauthorized:
                // info("Unauthorized");
                this.emit("unauthorized");
        }
    }

    handleClient(client) {
        const addr = client.socket.remoteAddress;
        info(`Connection from ${addr}`);

        // hijack the socket for proxying and exit early if we have an alive target
        if (this.checker.currentState.active) {

            let targetConnection;
            let socket;
            try {
                targetConnection = net.connect(
                    this.checker.target.port,
                    this.checker.target.host
                );
                socket = client.socket;
                client.socket = createNoopStream();
                socket.unpipe(); // stop everyone else from listening to it
                client.framer.unpipe(); // stop minecraft-protocol client from writing to it
                socket.pipe(targetConnection);
                targetConnection.pipe(socket);
            } catch (err) {
                error("Failed to connect to remote", err);
                client.socket.end();
                return;
            }

            // make sure the connections close when one or the other dies
            socket.on("close", () => {
                targetConnection.end();
            });
            targetConnection.on("close", () => {
                socket.end();
            });
            socket.on("error", (err) => {
                error("Error in client socket", err);
            });
            targetConnection.on("error", (err) => {
                error("Failed to connect to remote", err);
            });
            return;
        }

        // listen to stuff we want to know from client
        client.on("error", (err) => {
            error(`Error from ${addr}`, err);
        });

        client.on("end", () => {
            info(`Client ${addr} disconnected`);
        });
    }

    checkWhitelist(client_uuid) {
        if( !( config.whitelist.enabled || config.whitelist.enabled === 'true' ) ) {
            return true; // whitelist is not enabled, so allow all
        }
        else if( this.whitelistFile === null ) {
            error("Whitelist is enabled, but no whitelist file is configured.");
            return false; // whitelist is enabled, but no file is set
        }
        else {
            try {
                const whitelist = JSON.parse(
                    fs.readFileSync( this.whitelistFile )
                );
                for (var index = 0; index < whitelist.length; ++index) {

                    var player = whitelist[index];

                    if( player.uuid === client_uuid ) {
                        return true; // found the player in the whitelist
                    }
                }
                return false; // player not found in the whitelist
            } catch (err) {
                error(`Failed to read or parse whitelist file: ${err.message}`);
                return false; // failed to read or parse the whitelist file
            }
        }
    }

    handleLogin(client) {

        if( this.checkWhitelist(client.uuid) ) {
            this.setState(STATES.starting);
            info(
                `Player ${client.username} (${client.uuid}) connected, booting up the server...`
            );
            client.end("Booting the server now. Please reconnect once it's up.");
        }
        else {
            this.setState(STATES.unauthorized);
            info(
                `Player ${client.username} (${client.uuid}) is not authorized.`
            );
            client.end("You're not authorized to join this server."); 
        }
    }

    beforePing(data) {
        // if we're active, return the existing data
        if (this.currentState.state === STATES.active) {
            return this.checker.currentState.data;
        }

        if (this.checker.currentState && this.checker.currentState.data) {
            data.favicon = this.checker.currentState.data.favicon;
        }

        // otherwise respond with explanatory text
        data.players.max = 0;
        data.version.protocol = 1; // set a known-bad protocol so the user gets an error showing the version name
        const secSinceChange = ( ( Date.now() - this.currentState.time ) / 1000 ).toFixed(0);
        switch (this.currentState.state) {
            case STATES.starting:
                data.description.text = `Please wait while the server starts (${secSinceChange}s)...`;
                data.version.name = "Booting up";
                break;
            case STATES.stopping:
                data.description.text = `Please wait while the server shuts down (${secSinceChange}s)...`;
                data.version.name = "Shutting down";
                break;
            case STATES.inactive:
                data.description.text = `Server inactive; connect to boot it up.`;
                data.version.name = "Inactive";
                break;
            case STATES.unauthorized:
                data.description.text = `You're not authorized to join this server.`;
                data.version.name = "Unauthorized";
                break;
            default:
                data.description.text = `Unknown status. Please wait...`;
                data.version.name = "Unknown";
        }
        return data;
    }

    update() {
        clearTimeout(this._updateTimeout);

        const active = this.checker.currentState.active;

        // make sure don't end up hanging on starting/stopping by introducing a timeout
        switch (this.currentState.state) {
            case STATES.stopping: // we keep trying to shut down if it fails
                if (Date.now() - this.currentState.time > config.timeout.shutdownWait * 60 * 1000) {
                    error("Shutdown timed out. Retrying...");
                    this.setState(STATES.stopping, true);
                }
                break;
            case STATES.starting: // if starting fails, just abort
                if (Date.now() - this.currentState.time > config.timeout.bootWait * 60 * 1000) {
                    error("Boot-up timed out. Aborting.");
                    this.setState(STATES.inactive);
                }
                break;
        }

        // update our state if we are active/inactive
        if (active && this.currentState.state !== STATES.stopping) {
            this.setState(STATES.active);
        } else if (!active && this.currentState.state !== STATES.starting) {
            this.setState(STATES.inactive);
        }

        // finally check if we should shut down
        if (this.currentState.state === STATES.active) {
            const players = ( this.checker.currentState.data && ( this.checker.currentState.data.players ? ( this.checker.currentState.data.players.online || 0 ) : 0 ) );

            if (players !== this.players.count) {
                info(`Player count changed (${this.players.count} -> ${players})`);
                this.players = {
                    count: players,
                    time: Date.now(),
                };
            }

            const playerTime = Math.max( this.players.time, this.currentState.time );
            
            if( this.players.count === 0 && ( Date.now() - playerTime ) >= config.timeout.idleShutdown  * 60 * 1000 ) {
                info(`No players connected for the last ${config.timeout} minutes; stopping server...`);
                this.setState(STATES.stopping);
            }
        }

        this._updateTimeout = setTimeout(this.update, 1000);
    }
}
