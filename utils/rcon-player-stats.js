/**
 * Saturn-style player stats: parse RCON console lines for kills / joins / leaves,
 * and poll `playerlist` every 60s for playtime (ConnectedSeconds deltas).
 *
 * Env:
 *   RCON_STATS_ENABLED — set to "false" or "0" to disable (default: on if config exists)
 *   RCON_STATS_IP, RCON_STATS_PORT, RCON_STATS_PASS — dedicated RCON endpoint (recommended)
 *   Falls back to 6X_RCON_IP, 6X_RCON_PORT, 6X_RCON_PASS if stats vars unset
 *   LEADERBOARD_REGION — region label stored in DB (default: main)
 *
 * Uses a persistent WebSocket (rustrcon). If your host allows only one RCON client,
 * prefer dedicated RCON_STATS_* or rely on HTTP ingest instead.
 */

const { Client } = require('rustrcon');

const PLAYTIME_POLL_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 5000;
const RECONNECT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 20_000;

let started = false;
let tracker = null;

function leaderboardRegion() {
    return String(process.env.LEADERBOARD_REGION || 'main').trim().slice(0, 32) || 'main';
}

function getRconConfig() {
    const ip = process.env.RCON_STATS_IP || process.env['6X_RCON_IP'];
    const portRaw = process.env.RCON_STATS_PORT || process.env['6X_RCON_PORT'];
    const password = process.env.RCON_STATS_PASS || process.env['6X_RCON_PASS'];
    const port = parseInt(portRaw, 10);
    if (!ip || !password || Number.isNaN(port)) return null;
    return { ip, port, password };
}

function statsEnabled() {
    const v = process.env.RCON_STATS_ENABLED;
    if (v === 'false' || v === '0') return false;
    return !!getRconConfig();
}

function isNpcOrEnvironmental(name) {
    const lowerName = String(name).toLowerCase();

    if (/^\d+$/.test(name)) return true;

    const environmentalCauses = [
        'fall',
        'drowned',
        'drowning',
        'radiation',
        'poison',
        'cold',
        'heat',
        'hunger',
        'thirst',
        'bleeding'
    ];
    for (const cause of environmentalCauses) {
        if (lowerName === cause || lowerName.includes(cause)) return true;
    }

    if (lowerName.includes('entity)') || lowerName === '(' || lowerName === ')') return true;

    if (lowerName.includes('scientist')) return true;
    if (lowerName.includes('bear')) return true;
    if (lowerName.includes('wolf')) return true;
    if (lowerName.includes('boar')) return true;
    if (lowerName.includes('chicken')) return true;
    if (lowerName.includes('horse')) return true;
    if (lowerName.includes('stag')) return true;
    if (lowerName.includes('scarecrow')) return true;
    if (lowerName.includes('murderer')) return true;
    if (lowerName.includes('tunnel')) return true;
    if (lowerName.includes('oilrig')) return true;
    if (lowerName.startsWith('npc')) return true;
    if (lowerName.includes('gingerbread')) return true;
    if (lowerName.includes('sentry')) return true;
    if (lowerName.includes('autoturret')) return true;
    if (lowerName.includes('landmine')) return true;
    if (lowerName.includes('beartrap')) return true;
    if (lowerName.includes('bradley')) return true;
    if (lowerName.includes('patrolhelicopter')) return true;
    if (lowerName.includes('helicopter')) return true;
    if (lowerName.includes('fire')) return true;
    if (lowerName.includes('barricade')) return true;
    if (lowerName.includes('cactus')) return true;

    return false;
}

function parsePlayerEvent(db, region, message) {
    if (!db || !message) return;

    const msg = message.trim();

    const killMatch = msg.match(/^(.+?) was killed by (.+)$/i);
    if (killMatch) {
        const victim = killMatch[1].replace(/\x00/g, '').trim();
        const killer = killMatch[2].replace(/\x00/g, '').trim();

        if (isNpcOrEnvironmental(killer)) return;

        if (isNpcOrEnvironmental(victim)) {
            db.recordNpcKill(killer, region).catch((err) => {
                console.error('[RCON Stats] NPC kill error:', err.message);
            });
            return;
        }

        db.recordKill(killer, victim, region).catch((err) => {
            console.error('[RCON Stats] PvP kill error:', err.message);
        });
        return;
    }

    const joinMatch = msg.match(/^(.+?) has entered the game$/i);
    if (joinMatch) {
        const player = joinMatch[1].replace(/\x00/g, '').trim();
        db.recordPlayerJoin(player, region).catch((err) => {
            console.error('[RCON Stats] Join error:', err.message);
        });
        return;
    }

    const leaveMatch = msg.match(/^(.+?) disconnecting:/i);
    if (leaveMatch) {
        const player = leaveMatch[1].replace(/\x00/g, '').trim();
        db.recordPlayerLeave(player, region).catch((err) => {
            console.error('[RCON Stats] Leave error:', err.message);
        });
    }
}

function logTypeAllowed(t) {
    if (t === undefined || t === null) return true;
    return t === 'Generic' || t === 'Log' || t === 'Error' || t === 'Warning';
}

class RconPlayerStatsTracker {
    constructor(database) {
        this.db = database;
        this.region = leaderboardRegion();
        this.config = getRconConfig();
        this.client = null;
        this.pending = new Map();
        this.nextId = 100;
        this.lastSnapshot = new Map();
        this.pollHandle = null;
        this.reconnectHandle = null;
        this.shuttingDown = false;
    }

    sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('RCON not connected'));
                return;
            }
            const id = this.nextId++;
            if (this.nextId > 1_000_000) this.nextId = 100;

            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('RCON command timeout'));
                }
            }, COMMAND_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });
            this.client.send(command, 'LegacyStats', id);
        });
    }

    resolvePending(id, payload) {
        const entry = this.pending.get(id);
        if (!entry) return false;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve(payload);
        return true;
    }

    handleMessage(payload) {
        const id = payload.Identifier;
        if (id && this.pending.has(id)) {
            this.resolvePending(id, payload);
            return;
        }

        const t = payload.Type;
        if (!logTypeAllowed(t)) return;

        if (id && id > 0) return;

        let logMessage = payload.content;
        if (typeof logMessage !== 'string') return;

        if (logMessage.startsWith('[rcon] ')) return;

        logMessage = logMessage.replace(/<[^>]+>/g, '');
        if (!logMessage.trim()) return;

        parsePlayerEvent(this.db, this.region, logMessage);
    }

    async pollPlayerlist() {
        if (!this.client || this.shuttingDown) return;
        try {
            const payload = await this.sendCommand('playerlist');
            let players = null;
            const c = payload.content;
            if (Array.isArray(c)) players = c;
            else if (typeof c === 'string') {
                try {
                    const parsed = JSON.parse(c);
                    if (Array.isArray(parsed)) players = parsed;
                } catch (_) {
                    /* ignore */
                }
            }
            if (!players) return;
            await this.updatePlaytimeFromPlayerlist(players);
        } catch (e) {
            console.error('[RCON Stats] playerlist failed:', e.message);
        }
    }

    async updatePlaytimeFromPlayerlist(players) {
        const region = this.region;
        const now = Date.now();
        const regionSnapshot = this.lastSnapshot;
        const currentPlayers = new Set();
        const playtimeUpdates = [];

        for (const player of players) {
            const gamertag = player.DisplayName;
            if (!gamertag) continue;

            currentPlayers.add(gamertag);
            const connectedSeconds = player.ConnectedSeconds || 0;

            const lastData = regionSnapshot.get(gamertag);

            if (lastData) {
                const timeDelta = Math.floor((now - lastData.lastUpdate) / 1000);
                const secondsDelta = connectedSeconds - lastData.connectedSeconds;

                let playtimeToAdd = 0;
                if (secondsDelta > 0 && secondsDelta <= timeDelta + 10) {
                    playtimeToAdd = secondsDelta;
                } else if (secondsDelta < 0) {
                    playtimeToAdd = connectedSeconds;
                }

                if (playtimeToAdd > 0) {
                    playtimeUpdates.push({ gamertag, playtimeToAdd });
                }
            }

            regionSnapshot.set(gamertag, {
                connectedSeconds,
                lastUpdate: now
            });
        }

        for (const { gamertag, playtimeToAdd } of playtimeUpdates) {
            try {
                await this.db.updatePlaytimeDelta(gamertag, region, playtimeToAdd);
                if (typeof this.db.applyGemEarnFromPlaytime === 'function') {
                    await this.db.applyGemEarnFromPlaytime(gamertag, playtimeToAdd).catch((ge) => {
                        console.error('[Gems] playtime earn:', gamertag, ge.message);
                    });
                }
            } catch (err) {
                console.error('[RCON Stats] playtime delta error:', gamertag, err.message);
            }
        }

        for (const gamertag of regionSnapshot.keys()) {
            if (!currentPlayers.has(gamertag)) {
                regionSnapshot.delete(gamertag);
            }
        }

        if (currentPlayers.size > 0 && playtimeUpdates.length > 0) {
            console.log(
                `[RCON Stats] ${region}: ${currentPlayers.size} online, ${playtimeUpdates.length} playtime updates`
            );
        }
    }

    schedulePolling() {
        if (this.pollHandle) clearInterval(this.pollHandle);
        this.pollHandle = setInterval(() => this.pollPlayerlist(), PLAYTIME_POLL_MS);
        setTimeout(() => this.pollPlayerlist(), INITIAL_POLL_DELAY_MS);
    }

    clearPolling() {
        if (this.pollHandle) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    connect() {
        if (this.shuttingDown || !this.config) return;

        this.clearPolling();
        if (this.client) {
            try {
                this.client.removeAllListeners();
                this.client.destroy();
            } catch (_) {
                /* ignore */
            }
            this.client = null;
        }

        this.client = new Client({
            ip: this.config.ip,
            port: this.config.port,
            password: this.config.password
        });

        this.client.on('message', (payload) => this.handleMessage(payload));

        this.client.on('connected', () => {
            console.log(`[RCON Stats] Connected (${this.config.ip}:${this.config.port}), region=${this.region}`);
            this.schedulePolling();
        });

        this.client.on('error', (err) => {
            console.error('[RCON Stats] Error:', err && err.message ? err.message : err);
        });

        this.client.on('disconnect', () => {
            if (this.shuttingDown) return;
            console.warn('[RCON Stats] Disconnected; reconnecting in', RECONNECT_MS / 1000, 's');
            this.clearPolling();
            this.lastSnapshot.clear();
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
            }
            this.pending.clear();
            if (this.reconnectHandle) clearTimeout(this.reconnectHandle);
            this.reconnectHandle = setTimeout(() => this.connect(), RECONNECT_MS);
        });

        this.client.login();
    }

    shutdown() {
        this.shuttingDown = true;
        this.clearPolling();
        if (this.reconnectHandle) clearTimeout(this.reconnectHandle);
        if (this.client) {
            try {
                this.client.removeAllListeners();
                this.client.destroy();
            } catch (_) {
                /* ignore */
            }
            this.client = null;
        }
    }
}

function start(database) {
    if (started) return;
    if (!statsEnabled()) {
        console.log('[RCON Stats] Disabled or missing RCON config (set RCON_STATS_* or 6X_RCON_*).');
        return;
    }
    started = true;
    tracker = new RconPlayerStatsTracker(database);

    if (!process.env.RCON_STATS_IP && process.env['6X_RCON_IP']) {
        console.warn(
            '[RCON Stats] Using 6X_RCON_* credentials. A second RCON client may conflict with kit delivery; set RCON_STATS_* for a dedicated connection if needed.'
        );
    }

    tracker.connect();

    const onStop = () => {
        if (tracker) tracker.shutdown();
    };
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
}

module.exports = { start, statsEnabled, leaderboardRegion };
