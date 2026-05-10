const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');


const dbPath = path.join(__dirname, 'legacyrustservers.db');
const legacyDbPath = path.join(__dirname, 'zenithrust.db');

if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    try {
        fs.copyFileSync(legacyDbPath, dbPath);
        console.log('[Database] Migrated zenithrust.db to legacyrustservers.db');
    } catch (err) {
        console.error('[Database] Failed to migrate old database file:', err.message);
    }
}
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('[Database] Connection error:', err.message);
    else console.log('[Database] Connected to legacyrustservers.db');
});

db.serialize(() => {
    
    db.run(`CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        username TEXT,
        email TEXT,
        gamertag TEXT,
        console TEXT,
        pfp TEXT,
        registered_at TEXT
    )`);

    
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        discord_id TEXT,
        amount INTEGER,
        currency TEXT,
        status TEXT, -- pending, completed
        items TEXT, -- JSON string of items
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS kit_claims (
        discord_id TEXT NOT NULL,
        kit_instance_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        last_claimed_at TEXT,
        claim_count INTEGER DEFAULT 0,
        PRIMARY KEY (discord_id, kit_instance_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        stripe_subscription_id TEXT PRIMARY KEY,
        stripe_customer_id TEXT,
        discord_id TEXT NOT NULL,
        gamertag TEXT,
        product_id TEXT NOT NULL,
        product_name TEXT,
        amount INTEGER,
        currency TEXT DEFAULT 'gbp',
        interval TEXT DEFAULT 'month',
        status TEXT,
        current_period_start INTEGER,
        current_period_end INTEGER,
        cancel_at_period_end INTEGER DEFAULT 0,
        cancelled_at TEXT,
        created_at TEXT,
        updated_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS player_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gamertag TEXT NOT NULL,
        region TEXT NOT NULL,
        total_kills INTEGER DEFAULT 0,
        total_deaths INTEGER DEFAULT 0,
        total_npc_kills INTEGER DEFAULT 0,
        total_playtime_seconds INTEGER DEFAULT 0,
        last_seen TEXT,
        first_seen TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(gamertag, region)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS player_kills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        killer_gamertag TEXT NOT NULL,
        victim_gamertag TEXT NOT NULL,
        region TEXT NOT NULL,
        kill_type TEXT DEFAULT 'pvp',
        timestamp TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS player_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gamertag TEXT NOT NULL,
        region TEXT NOT NULL,
        join_time TEXT NOT NULL,
        leave_time TEXT,
        duration_seconds INTEGER DEFAULT 0
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_player_stats_kills ON player_stats(total_kills DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_player_stats_playtime ON player_stats(total_playtime_seconds DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_player_kills_ts ON player_kills(timestamp)`);

    db.run(`ALTER TABLE users ADD COLUMN store_credit_pence INTEGER NOT NULL DEFAULT 0`, (e) => {
        if (e && !String(e.message).includes('duplicate column')) console.warn('[DB] users.store_credit_pence:', e.message);
    });
    db.run(`ALTER TABLE orders ADD COLUMN store_credit_used_pence INTEGER NOT NULL DEFAULT 0`, (e) => {
        if (e && !String(e.message).includes('duplicate column')) console.warn('[DB] orders.store_credit_used_pence:', e.message);
    });
    db.run(`ALTER TABLE orders ADD COLUMN stripe_amount_pence INTEGER`, (e) => {
        if (e && !String(e.message).includes('duplicate column')) console.warn('[DB] orders.stripe_amount_pence:', e.message);
    });
    db.run(`ALTER TABLE users ADD COLUMN gems INTEGER NOT NULL DEFAULT 0`, (e) => {
        if (e && !String(e.message).includes('duplicate column')) console.warn('[DB] users.gems:', e.message);
    });
    db.run(`CREATE TABLE IF NOT EXISTS gem_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        reference_id TEXT UNIQUE,
        created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS gem_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL,
        gamertag TEXT,
        item_id TEXT NOT NULL,
        item_name TEXT,
        quantity INTEGER NOT NULL,
        total_cost INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS gem_playtime_bank (
        gamertag TEXT PRIMARY KEY,
        bank_seconds INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    )`);
});

module.exports = {
    
    getUser: (id) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE discord_id = ?", [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    getUserByEmail: (email) => {
        return new Promise((resolve, reject) => {
            const e = String(email || '')
                .trim()
                .toLowerCase();
            if (!e || !e.includes('@')) {
                resolve(null);
                return;
            }
            db.get(
                `SELECT * FROM users WHERE LOWER(TRIM(COALESCE(email,''))) = ? LIMIT 1`,
                [e],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    },

    saveUser: (user) => {
        return new Promise((resolve, reject) => {
            const stmt = db.prepare(`
                INSERT INTO users (discord_id, username, email, gamertag, console, pfp, registered_at, store_credit_pence)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(discord_id) DO UPDATE SET
                username = excluded.username,
                email = excluded.email,
                pfp = excluded.pfp,
                gamertag = COALESCE(users.gamertag, excluded.gamertag),
                console = COALESCE(users.console, excluded.console),
                store_credit_pence = users.store_credit_pence,
                gems = users.gems
            `);
            stmt.run(user.id, user.username, user.email, user.gamertag, user.console, user.pfp, user.registeredAt, function(err) {
                const self = this;
                stmt.finalize((finErr) => {
                    if (err) reject(err);
                    else if (finErr) reject(finErr);
                    else resolve(self);
                });
            });
        });
    },

    updateGamertag: (id, gamertag, consoleType) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE users SET gamertag = ?, console = ? WHERE discord_id = ?", [gamertag, consoleType, id], function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    },

    
    createOrder: (orderId, discordId, amount, items, opts = {}) => {
        return new Promise((resolve, reject) => {
            const sc = Math.max(0, Math.min(parseInt(opts.storeCreditUsedPence, 10) || 0, amount));
            const sa =
                opts.stripeAmountPence != null
                    ? Math.max(0, parseInt(opts.stripeAmountPence, 10) || 0)
                    : Math.max(0, amount - sc);
            const stmt = db.prepare(
                `INSERT INTO orders (order_id, discord_id, amount, currency, status, items, created_at, store_credit_used_pence, stripe_amount_pence)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            stmt.run(
                orderId,
                discordId,
                amount,
                'gbp',
                'pending',
                JSON.stringify(items),
                new Date().toISOString(),
                sc,
                sa,
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    /**
     * deltaPence: negative = spend, positive = grant (admin/refunds).
     * Spending requires sufficient balance (never below zero).
     */
    adjustStoreCredit: (discordId, deltaPence) => {
        return new Promise((resolve, reject) => {
            const d = parseInt(deltaPence, 10);
            if (!discordId || Number.isNaN(d) || d === 0) {
                reject(new Error('Invalid credit adjustment'));
                return;
            }
            db.run(
                `UPDATE users SET store_credit_pence = store_credit_pence + ? WHERE discord_id = ? AND store_credit_pence + ? >= 0`,
                [d, discordId, d],
                function(err) {
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (this.changes === 0) {
                        reject(new Error('Insufficient store credit'));
                        return;
                    }
                    resolve(this);
                }
            );
        });
    },

    completeOrder: (orderId) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE orders SET status = 'completed' WHERE order_id = ?", [orderId], function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    },

    getOrder: (orderId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM orders WHERE order_id = ?", [orderId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    deletePendingOrder: (orderId) => {
        return new Promise((resolve, reject) => {
            db.run(
                `DELETE FROM orders WHERE order_id = ? AND status = 'pending'`,
                [orderId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    },

    getOrdersByDiscordId: (discordId) => {
        return new Promise((resolve, reject) => {
            db.all(
                "SELECT * FROM orders WHERE discord_id = ? AND status = 'completed' ORDER BY created_at DESC",
                [discordId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    /** Distinct store rank product IDs (rank_*) from completed orders — for playtime gem bonus. */
    countDistinctOwnedRanks: (discordId) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT items FROM orders WHERE discord_id = ? AND status = 'completed'`,
                [discordId],
                (err, rows) => {
                    if (err) return reject(err);
                    const ids = new Set();
                    for (const row of rows || []) {
                        try {
                            const items = JSON.parse(row.items || '[]');
                            if (!Array.isArray(items)) continue;
                            for (const item of items) {
                                const id = item && item.id;
                                if (typeof id === 'string' && id.startsWith('rank_')) ids.add(id);
                            }
                        } catch (e) {
                            /* skip bad row */
                        }
                    }
                    resolve(ids.size);
                }
            );
        });
    },

    /** Top spenders: sum of completed order amounts (pence) per Discord account. */
    getLeaderboardBySpend: (limit) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT agg.discord_id AS discord_id,
                        COALESCE(
                            (SELECT gamertag FROM users WHERE discord_id = agg.discord_id LIMIT 1),
                            'Player'
                        ) AS gamertag,
                        COALESCE(
                            (SELECT username FROM users WHERE discord_id = agg.discord_id LIMIT 1),
                            ''
                        ) AS username,
                        (SELECT pfp FROM users WHERE discord_id = agg.discord_id LIMIT 1) AS pfp,
                        agg.total_spend AS total_spend,
                        agg.order_count AS order_count
                 FROM (
                     SELECT discord_id AS discord_id,
                            SUM(amount) AS total_spend,
                            COUNT(*) AS order_count
                     FROM orders
                     WHERE status = 'completed'
                     GROUP BY discord_id
                 ) AS agg
                 ORDER BY agg.total_spend DESC
                 LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    getLeaderboardGlobalStats: () => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT COUNT(DISTINCT discord_id) AS supporters,
                        COUNT(*) AS orders_completed,
                        COALESCE(SUM(amount), 0) AS total_spend_pence
                 FROM orders
                 WHERE status = 'completed'`,
                [],
                (err, row) => {
                    if (err) reject(err);
                    else {
                        resolve(
                            row || {
                                supporters: 0,
                                orders_completed: 0,
                                total_spend_pence: 0
                            }
                        );
                    }
                }
            );
        });
    },

    recordKill: (killerGamertag, victimGamertag, region) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const k = String(killerGamertag || '').trim().slice(0, 64);
            const v = String(victimGamertag || '').trim().slice(0, 64);
            const r = String(region || 'main').trim().slice(0, 32);
            if (!k || !v) {
                reject(new Error('killerGamertag and victimGamertag required'));
                return;
            }
            db.serialize(() => {
                db.run(
                    `INSERT INTO player_kills (killer_gamertag, victim_gamertag, region, kill_type, timestamp)
                     VALUES (?, ?, ?, 'pvp', ?)`,
                    [k, v, r, now],
                    (e1) => {
                        if (e1) {
                            reject(e1);
                            return;
                        }
                        db.run(
                            `INSERT INTO player_stats (gamertag, region, total_kills, total_deaths, total_npc_kills, total_playtime_seconds, last_seen, first_seen, created_at, updated_at)
                             VALUES (?, ?, 1, 0, 0, 0, ?, ?, ?, ?)
                             ON CONFLICT(gamertag, region) DO UPDATE SET
                               total_kills = total_kills + 1,
                               last_seen = excluded.last_seen,
                               updated_at = excluded.updated_at`,
                            [k, r, now, now, now, now],
                            (e2) => {
                                if (e2) {
                                    reject(e2);
                                    return;
                                }
                                db.run(
                                    `INSERT INTO player_stats (gamertag, region, total_kills, total_deaths, total_npc_kills, total_playtime_seconds, last_seen, first_seen, created_at, updated_at)
                                     VALUES (?, ?, 0, 1, 0, 0, ?, ?, ?, ?)
                                     ON CONFLICT(gamertag, region) DO UPDATE SET
                                       total_deaths = total_deaths + 1,
                                       last_seen = excluded.last_seen,
                                       updated_at = excluded.updated_at`,
                                    [v, r, now, now, now, now],
                                    (e3) => {
                                        if (e3) reject(e3);
                                        else resolve(true);
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    },

    recordNpcKill: (killerGamertag, region) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const k = String(killerGamertag || '').trim().slice(0, 64);
            const r = String(region || 'main').trim().slice(0, 32);
            if (!k) {
                reject(new Error('gamertag required'));
                return;
            }
            db.run(
                `INSERT INTO player_stats (gamertag, region, total_kills, total_deaths, total_npc_kills, total_playtime_seconds, last_seen, first_seen, created_at, updated_at)
                 VALUES (?, ?, 0, 0, 1, 0, ?, ?, ?, ?)
                 ON CONFLICT(gamertag, region) DO UPDATE SET
                   total_npc_kills = total_npc_kills + 1,
                   last_seen = excluded.last_seen,
                   updated_at = excluded.updated_at`,
                [k, r, now, now, now, now],
                function(err) {
                    if (err) reject(err);
                    else resolve(true);
                }
            );
        });
    },

    recordPlayerJoin: (gamertag, region) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const g = String(gamertag || '').trim().slice(0, 64);
            const r = String(region || 'main').trim().slice(0, 32);
            if (!g) {
                reject(new Error('gamertag required'));
                return;
            }
            db.serialize(() => {
                db.run(`INSERT INTO player_sessions (gamertag, region, join_time) VALUES (?, ?, ?)`, [g, r, now], (e1) => {
                    if (e1) {
                        reject(e1);
                        return;
                    }
                    db.run(
                        `INSERT INTO player_stats (gamertag, region, total_kills, total_deaths, total_npc_kills, total_playtime_seconds, last_seen, first_seen, created_at, updated_at)
                         VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?, ?)
                         ON CONFLICT(gamertag, region) DO UPDATE SET
                           last_seen = excluded.last_seen,
                           updated_at = excluded.updated_at`,
                        [g, r, now, now, now, now],
                        (e2) => {
                            if (e2) reject(e2);
                            else resolve(true);
                        }
                    );
                });
            });
        });
    },

    recordPlayerLeave: (gamertag, region) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const g = String(gamertag || '').trim().slice(0, 64);
            const r = String(region || 'main').trim().slice(0, 32);
            if (!g) {
                reject(new Error('gamertag required'));
                return;
            }
            db.get(
                `SELECT id, join_time FROM player_sessions
                 WHERE gamertag = ? AND region = ? AND leave_time IS NULL
                 ORDER BY join_time DESC LIMIT 1`,
                [g, r],
                (err, session) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (!session) {
                        resolve(0);
                        return;
                    }
                    const durationSeconds = Math.max(
                        0,
                        Math.floor((new Date(now) - new Date(session.join_time)) / 1000)
                    );
                    db.serialize(() => {
                        db.run(
                            `UPDATE player_sessions SET leave_time = ?, duration_seconds = ? WHERE id = ?`,
                            [now, durationSeconds, session.id],
                            (e1) => {
                                if (e1) {
                                    reject(e1);
                                    return;
                                }
                                db.run(
                                    `UPDATE player_stats SET total_playtime_seconds = total_playtime_seconds + ?,
                                     last_seen = ?, updated_at = ? WHERE gamertag = ? AND region = ?`,
                                    [durationSeconds, now, now, g, r],
                                    (e2) => {
                                        if (e2) reject(e2);
                                        else resolve(durationSeconds);
                                    }
                                );
                            }
                        );
                    });
                }
            );
        });
    },

    updatePlaytimeDelta: (gamertag, region, secondsToAdd) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const g = String(gamertag || '').trim().slice(0, 64);
            const r = String(region || 'main').trim().slice(0, 32);
            const sec = Math.max(0, Math.min(parseInt(secondsToAdd, 10) || 0, 86400));
            if (!g) {
                reject(new Error('gamertag required'));
                return;
            }
            db.run(
                `INSERT INTO player_stats (gamertag, region, total_kills, total_deaths, total_npc_kills, total_playtime_seconds, last_seen, first_seen, created_at, updated_at)
                 VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
                 ON CONFLICT(gamertag, region) DO UPDATE SET
                   total_playtime_seconds = total_playtime_seconds + ?,
                   last_seen = excluded.last_seen,
                   updated_at = excluded.updated_at`,
                [g, r, sec, now, now, now, now, sec],
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    getKillsLeaderboardAggregated: (limit) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT ps.gamertag AS gamertag,
                        SUM(ps.total_kills) AS kills,
                        SUM(ps.total_deaths) AS deaths,
                        CASE WHEN SUM(ps.total_deaths) > 0
                          THEN ROUND(CAST(SUM(ps.total_kills) AS REAL) / SUM(ps.total_deaths), 2)
                          ELSE SUM(ps.total_kills) END AS kd_ratio,
                        MAX(u.discord_id) AS discord_id,
                        MAX(u.username) AS discord_username,
                        MAX(u.pfp) AS pfp
                 FROM player_stats ps
                 LEFT JOIN users u ON LOWER(TRIM(COALESCE(u.gamertag,''))) = LOWER(TRIM(ps.gamertag))
                 GROUP BY LOWER(ps.gamertag)
                 HAVING SUM(ps.total_kills) > 0
                 ORDER BY kills DESC
                 LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    getPlaytimeLeaderboardAggregated: (limit) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT ps.gamertag AS gamertag,
                        SUM(ps.total_playtime_seconds) AS playtime_seconds,
                        SUM(ps.total_kills) AS kills,
                        SUM(ps.total_deaths) AS deaths,
                        MAX(u.discord_id) AS discord_id,
                        MAX(u.username) AS discord_username,
                        MAX(u.pfp) AS pfp
                 FROM player_stats ps
                 LEFT JOIN users u ON LOWER(TRIM(COALESCE(u.gamertag,''))) = LOWER(TRIM(ps.gamertag))
                 GROUP BY LOWER(ps.gamertag)
                 HAVING SUM(ps.total_playtime_seconds) > 0
                 ORDER BY playtime_seconds DESC
                 LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    getDeathsLeaderboardAggregated: (limit) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT ps.gamertag AS gamertag,
                        SUM(ps.total_deaths) AS deaths,
                        SUM(ps.total_kills) AS kills,
                        CASE WHEN SUM(ps.total_deaths) > 0
                          THEN ROUND(CAST(SUM(ps.total_kills) AS REAL) / SUM(ps.total_deaths), 2)
                          ELSE SUM(ps.total_kills) END AS kd_ratio,
                        MAX(u.discord_id) AS discord_id,
                        MAX(u.username) AS discord_username,
                        MAX(u.pfp) AS pfp
                 FROM player_stats ps
                 LEFT JOIN users u ON LOWER(TRIM(COALESCE(u.gamertag,''))) = LOWER(TRIM(ps.gamertag))
                 GROUP BY LOWER(ps.gamertag)
                 HAVING SUM(ps.total_deaths) > 0
                 ORDER BY deaths DESC
                 LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    getPlayerStatsByGamertag: (gamertag) => {
        return new Promise((resolve, reject) => {
            const g = String(gamertag || '').trim();
            if (!g) {
                resolve([]);
                return;
            }
            db.all(
                `SELECT ps.*,
                        u.discord_id AS linked_discord_id,
                        u.username AS discord_username,
                        u.pfp AS discord_avatar
                 FROM player_stats ps
                 LEFT JOIN users u ON LOWER(TRIM(COALESCE(u.gamertag,''))) = LOWER(TRIM(ps.gamertag))
                 WHERE LOWER(ps.gamertag) = LOWER(?)
                 ORDER BY ps.region`,
                [g],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    getUserByGamertagCaseInsensitive: (gamertag) => {
        return new Promise((resolve, reject) => {
            const g = String(gamertag || '').trim();
            if (!g) {
                resolve(null);
                return;
            }
            db.get(
                `SELECT * FROM users WHERE LOWER(TRIM(COALESCE(gamertag,''))) = LOWER(?) LIMIT 1`,
                [g],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    },

    getTotalCompletedSpendPence: (discordId) => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE discord_id = ? AND status = 'completed'`,
                [discordId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row && row.total != null ? row.total : 0);
                }
            );
        });
    },

    getPlayerNemesisStats: (gamertag) => {
        return new Promise((resolve, reject) => {
            const g = String(gamertag || '').trim();
            if (!g) {
                resolve({ most_killed: null, most_killed_by: null });
                return;
            }
            db.get(
                `SELECT victim_gamertag AS gamertag, COUNT(*) AS cnt
                 FROM player_kills WHERE LOWER(killer_gamertag) = LOWER(?)
                 GROUP BY victim_gamertag ORDER BY cnt DESC LIMIT 1`,
                [g],
                (err, row1) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    db.get(
                        `SELECT killer_gamertag AS gamertag, COUNT(*) AS cnt
                         FROM player_kills WHERE LOWER(victim_gamertag) = LOWER(?)
                         GROUP BY killer_gamertag ORDER BY cnt DESC LIMIT 1`,
                        [g],
                        (err2, row2) => {
                            if (err2) reject(err2);
                            else {
                                resolve({
                                    most_killed: row1 ? { gamertag: row1.gamertag, count: row1.cnt } : null,
                                    most_killed_by: row2 ? { gamertag: row2.gamertag, count: row2.cnt } : null
                                });
                            }
                        }
                    );
                }
            );
        });
    },

    getKitClaimsByDiscordId: (discordId) => {
        return new Promise((resolve, reject) => {
            db.all(
                "SELECT * FROM kit_claims WHERE discord_id = ?",
                [discordId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    recordKitClaim: (discordId, kitInstanceId, productId) => {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO kit_claims (discord_id, kit_instance_id, product_id, last_claimed_at, claim_count)
                 VALUES (?, ?, ?, ?, 1)
                 ON CONFLICT(discord_id, kit_instance_id) DO UPDATE SET
                 product_id = excluded.product_id,
                 last_claimed_at = excluded.last_claimed_at,
                 claim_count = kit_claims.claim_count + 1`,
                [discordId, kitInstanceId, productId, new Date().toISOString()],
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    createSubscription: (row) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const stmt = db.prepare(`
                INSERT INTO subscriptions (
                    stripe_subscription_id, stripe_customer_id, discord_id, gamertag, product_id, product_name,
                    amount, currency, interval, status, current_period_start, current_period_end,
                    cancel_at_period_end, cancelled_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                row.stripe_subscription_id,
                row.stripe_customer_id,
                row.discord_id,
                row.gamertag,
                row.product_id,
                row.product_name,
                row.amount,
                row.currency || 'gbp',
                row.interval || 'month',
                row.status,
                row.current_period_start,
                row.current_period_end,
                row.cancel_at_period_end ? 1 : 0,
                row.cancelled_at || null,
                row.created_at || now,
                now,
                function(err) {
                    const self = this;
                    stmt.finalize((finErr) => {
                        if (err) reject(err);
                        else if (finErr) reject(finErr);
                        else resolve(self);
                    });
                }
            );
        });
    },

    getSubscriptionByStripeId: (stripeSubscriptionId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", [stripeSubscriptionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    getSubscriptionsByDiscordId: (discordId) => {
        return new Promise((resolve, reject) => {
            db.all(
                "SELECT * FROM subscriptions WHERE discord_id = ? ORDER BY created_at DESC",
                [discordId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    updateSubscriptionStatus: (stripeSubscriptionId, status) => {
        return new Promise((resolve, reject) => {
            db.run(
                "UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?",
                [status, new Date().toISOString(), stripeSubscriptionId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    updateSubscriptionPeriod: (stripeSubscriptionId, periodStart, periodEnd) => {
        return new Promise((resolve, reject) => {
            db.run(
                "UPDATE subscriptions SET current_period_start = ?, current_period_end = ?, updated_at = ? WHERE stripe_subscription_id = ?",
                [periodStart, periodEnd, new Date().toISOString(), stripeSubscriptionId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    updateSubscriptionCancelPending: (stripeSubscriptionId, cancelledAt, periodStart, periodEnd) => {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE subscriptions SET cancel_at_period_end = 1, cancelled_at = ?,
                 current_period_start = COALESCE(?, current_period_start),
                 current_period_end = COALESCE(?, current_period_end),
                 updated_at = ?
                 WHERE stripe_subscription_id = ? OR stripe_subscription_id LIKE ?`,
                [
                    cancelledAt,
                    periodStart,
                    periodEnd,
                    new Date().toISOString(),
                    stripeSubscriptionId,
                    `${stripeSubscriptionId}_item_%`
                ],
                function(err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    getGemTransactionByRef: (referenceId) => {
        return new Promise((resolve, reject) => {
            if (!referenceId) {
                resolve(null);
                return;
            }
            db.get('SELECT * FROM gem_transactions WHERE reference_id = ?', [referenceId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    addGems: (discordId, amount, type, description, referenceId) => {
        return new Promise((resolve, reject) => {
            const n = parseInt(amount, 10) || 0;
            if (n <= 0) {
                resolve({ success: false, error: 'Invalid amount' });
                return;
            }
            const proceed = () => {
                const now = new Date().toISOString();
                db.run(
                    'UPDATE users SET gems = COALESCE(gems,0) + ? WHERE discord_id = ?',
                    [n, discordId],
                    function (err) {
                        if (err) return reject(err);
                        if (this.changes === 0) return reject(new Error('User not found'));
                        db.run(
                            `INSERT INTO gem_transactions (discord_id, delta, type, description, reference_id, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [discordId, n, type, description || '', referenceId || null, now],
                            (e2) => {
                                if (e2) return reject(e2);
                                resolve({ success: true });
                            }
                        );
                    }
                );
            };
            if (referenceId) {
                db.get(
                    'SELECT id FROM gem_transactions WHERE reference_id = ?',
                    [referenceId],
                    (err, row) => {
                        if (err) return reject(err);
                        if (row) return resolve({ success: true, duplicate: true });
                        proceed();
                    }
                );
            } else {
                proceed();
            }
        });
    },

    spendGems: (discordId, amount, type, description, referenceId) => {
        return new Promise((resolve, reject) => {
            const n = parseInt(amount, 10) || 0;
            if (n < 1) {
                resolve({ success: false, error: 'Invalid amount' });
                return;
            }
            const now = new Date().toISOString();
            db.run(
                'UPDATE users SET gems = COALESCE(gems,0) - ? WHERE discord_id = ? AND COALESCE(gems,0) >= ?',
                [n, discordId, n],
                function (err) {
                    if (err) return reject(err);
                    if (this.changes === 0) {
                        resolve({ success: false, error: 'Not enough gems' });
                        return;
                    }
                    db.run(
                        `INSERT INTO gem_transactions (discord_id, delta, type, description, reference_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [discordId, -n, type, description || '', referenceId || null, now],
                        (e2) => {
                            if (e2) return reject(e2);
                            db.get('SELECT gems FROM users WHERE discord_id = ?', [discordId], (e3, row) => {
                                if (e3) return reject(e3);
                                resolve({
                                    success: true,
                                    newBalance: row && row.gems != null ? Math.max(0, Number(row.gems)) : 0
                                });
                            });
                        }
                    );
                }
            );
        });
    },

    logGemPurchase: (row) => {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            db.run(
                `INSERT INTO gem_purchases (discord_id, gamertag, item_id, item_name, quantity, total_cost, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    row.discord_id,
                    row.gamertag || '',
                    row.item_id,
                    row.item_name || '',
                    row.quantity,
                    row.total_cost,
                    now
                ],
                function (err) {
                    if (err) reject(err);
                    else resolve(this);
                }
            );
        });
    },

    getGemTransactionHistory: (discordId, limit) => {
        return new Promise((resolve, reject) => {
            const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
            db.all(
                `SELECT * FROM gem_transactions WHERE discord_id = ? ORDER BY id DESC LIMIT ?`,
                [discordId, lim],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    },

    /**
     * Accumulate RCON playerlist playtime; award gems every GEM_EARN_INTERVAL_SEC (default 3600)
     * at GEM_EARN_PER_HOUR (default 10) for users whose linked gamertag matches (case-insensitive).
     */
    applyGemEarnFromPlaytime: (gamertag, deltaSeconds) => {
        return new Promise((resolve, reject) => {
            const v = process.env.GEM_EARN_ENABLED;
            if (v === 'false' || v === '0') {
                resolve({ awarded: 0 });
                return;
            }
            const g = String(gamertag || '').trim().slice(0, 64);
            const d = Math.floor(Number(deltaSeconds) || 0);
            if (!g || d <= 0) {
                resolve({ awarded: 0 });
                return;
            }
            const perHour = Math.max(1, parseInt(process.env.GEM_EARN_PER_HOUR || '10', 10) || 10);
            const interval = Math.max(60, parseInt(process.env.GEM_EARN_INTERVAL_SEC || '3600', 10) || 3600);
            const _rankBonus = process.env.GEM_EARN_BONUS_PER_RANK;
            const bonusPerRank =
                _rankBonus === undefined || _rankBonus === ''
                    ? 10
                    : Math.max(0, parseInt(_rankBonus, 10) || 0);

            db.get(
                `SELECT discord_id FROM users WHERE LOWER(TRIM(COALESCE(gamertag,''))) = LOWER(?) LIMIT 1`,
                [g],
                (err, userRow) => {
                    if (err) return reject(err);
                    if (!userRow || !userRow.discord_id) {
                        resolve({ awarded: 0 });
                        return;
                    }
                    const discordId = userRow.discord_id;
                    db.get(
                        'SELECT bank_seconds FROM gem_playtime_bank WHERE gamertag = ?',
                        [g],
                        (e2, bankRow) => {
                            if (e2) return reject(e2);
                            let bank = (bankRow && bankRow.bank_seconds != null ? Number(bankRow.bank_seconds) : 0) + d;
                            const wholePeriods = Math.floor(bank / interval);
                            bank = bank % interval;
                            const now = new Date().toISOString();
                            db.run(
                                `INSERT INTO gem_playtime_bank (gamertag, bank_seconds, updated_at) VALUES (?, ?, ?)
                                 ON CONFLICT(gamertag) DO UPDATE SET bank_seconds = excluded.bank_seconds, updated_at = excluded.updated_at`,
                                [g, bank, now],
                                async (e3) => {
                                    if (e3) return reject(e3);
                                    if (wholePeriods < 1) {
                                        resolve({ awarded: 0 });
                                        return;
                                    }
                                    let rankCount = 0;
                                    try {
                                        rankCount = await module.exports.countDistinctOwnedRanks(discordId);
                                    } catch (e) {
                                        rankCount = 0;
                                    }
                                    const effectivePerHour = perHour + rankCount * bonusPerRank;
                                    const totalGems = wholePeriods * effectivePerHour;
                                    const ref = `earn_pt_${discordId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
                                    const earnNote =
                                        rankCount > 0 && bonusPerRank > 0
                                            ? ` (base ${perHour} + ${rankCount} rank(s)×${bonusPerRank})`
                                            : '';
                                    try {
                                        await module.exports.addGems(
                                            discordId,
                                            totalGems,
                                            'earn',
                                            interval === 3600
                                                ? `In-game playtime: ${wholePeriods}h at ${effectivePerHour} gems/hr${earnNote}`
                                                : `In-game playtime: ${wholePeriods} periods (${effectivePerHour} gems per ${interval}s)${earnNote}`,
                                            ref
                                        );
                                        console.log(
                                            `[Gems] Playtime: +${totalGems} gems → ${discordId} (${g}, ${wholePeriods} interval(s), ${effectivePerHour}/hr)`
                                        );
                                        resolve({ awarded: totalGems, periods: wholePeriods });
                                    } catch (e4) {
                                        reject(e4);
                                    }
                                }
                            );
                        }
                    );
                }
            );
        });
    }
};