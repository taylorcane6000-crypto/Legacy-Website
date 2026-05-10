/**
 * Wipes all user, order, and kit-claim rows from legacyrustservers.db.
 * Run: npm run clear-data
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'legacyrustservers.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[clear-data] Cannot open database:', err.message);
        process.exit(1);
    }
});

db.serialize(() => {
    db.run('DELETE FROM kit_claims');
    db.run('DELETE FROM orders');
    db.run('DELETE FROM users', (e) => {
        if (e) console.error('[clear-data]', e.message);
    });
    db.run('VACUUM', (vacErr) => {
        if (vacErr) console.warn('[clear-data] VACUUM:', vacErr.message);
        db.close((closeErr) => {
            if (closeErr) console.error('[clear-data] close:', closeErr.message);
            else console.log('[clear-data] Removed all users, orders, and kit_claims.');
        });
    });
});
