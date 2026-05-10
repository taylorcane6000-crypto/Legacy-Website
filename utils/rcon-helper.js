const { Client } = require('rustrcon');


const RCON_CONFIG = {
    ip: process.env['6X_RCON_IP'],
    port: parseInt(process.env['6X_RCON_PORT']),
    password: process.env['6X_RCON_PASS']
};


async function executeCommands(commands, opts = {}) {
    if (!commands || commands.length === 0) return;

    const rcon = new Client(RCON_CONFIG);

    try {
        await new Promise((resolve, reject) => {
            rcon.login();
            
            rcon.on('connected', async () => {
                console.log('[RCON] Connected to Server. Executing commands...');
                
                for (const cmd of commands) {
                    console.log(`[RCON] Sending: ${cmd}`);
                    rcon.send(cmd);
                    
                    await new Promise(r => setTimeout(r, 500));
                }
                
                
                setTimeout(() => {
                    
                    try {
                        console.log('[RCON] Closing connection...');
                        if (typeof rcon.disconnect === 'function') {
                            rcon.disconnect();
                        } else if (typeof rcon.close === 'function') {
                            rcon.close();
                        } else if (rcon.ws && typeof rcon.ws.close === 'function') {
                            rcon.ws.close();
                        } else if (rcon.socket && typeof rcon.socket.destroy === 'function') {
                            rcon.socket.destroy();
                        } else {
                            console.warn('[RCON] Warning: Could not find a standard disconnect method.');
                        }
                    } catch (err) {
                        console.error('[RCON] Non-fatal error closing connection:', err.message);
                    }
                    
                    resolve();
                }, 1000);
            });

            rcon.on('error', (err) => {
                console.error('[RCON] Error:', err);
                try {
                    if (rcon.ws && typeof rcon.ws.close === 'function') rcon.ws.close();
                } catch (e) {  }
                reject(err);
            });
        });
    } catch (e) {
        console.error('[RCON] Execution Failed:', e);
        if (opts.throwOnError) throw e;
    }
}


function getCommandsForItems(items, gamertag) {
    const commands = [];

    
    if (!gamertag || gamertag === 'unknown') {
        console.error('[RCON] No Gamertag found for order!');
        return [];
    }

    
    const safeTag = `"${gamertag}"`;

    items.forEach(item => {
        const qty = item.qty || 1;
        
        for (let i = 0; i < qty; i++) {
            switch (item.id) {
                case 'queue_skip':
                    commands.push(`global.skipqueue ${safeTag}`);
                    break;
                case 'vip':
                case 'vip_standard':
                    commands.push(`vipid ${safeTag}`);
                    break;
                case 'vip_builder':
                    commands.push(`kit givetoplayer "vip build" ${safeTag}`);
                    break;
                case 'vip_components':
                    commands.push(`kit givetoplayer "vip components" ${safeTag}`);
                    break;
                case 'vip_starter':
                    commands.push(`kit givetoplayer "vip starter" ${safeTag}`);
                    break;
                case 'vip_turret':
                    commands.push(`kit givetoplayer "vip turret" ${safeTag}`);
                    break;
                case 'vip_farmbot':
                    commands.push(`kit givetoplayer "vip farmbot" ${safeTag}`);
                    break;
                case 'vip_medical':
                    commands.push(`kit givetoplayer "vip medical" ${safeTag}`);
                    break;
                case 'vip_deluxe':
                    commands.push(`vipid ${safeTag}`);
                    commands.push(`kit givetoplayer "vip build" ${safeTag}`);
                    commands.push(`kit givetoplayer "vip components" ${safeTag}`);
                    commands.push(`kit givetoplayer "vip starter" ${safeTag}`);
                    commands.push(`kit givetoplayer "vip turret" ${safeTag}`);
                    commands.push(`kit givetoplayer "vip medical" ${safeTag}`);
                    break;

                
                case 'pack_build':
                    commands.push(`kit givetoplayer "build pack" ${safeTag}`);
                    break;
                case 'pack_component':
                    commands.push(`kit givetoplayer "comp pack" ${safeTag}`);
                    break;
                case 'pack_supply':
                    commands.push(`kit givetoplayer "supply drops" ${safeTag}`);
                    break;
                case 'pack_medical':
                    commands.push(`kit givetoplayer "medical packs" ${safeTag}`);
                    break;
                case 'pack_mlrs':
                    commands.push(`kit givetoplayer "mlrs pack" ${safeTag}`);
                    break;
                case 'pack_backpack':
                    commands.push(`kit givetoplayer "backpack pack" ${safeTag}`);
                    break;
                case 'pack_card':
                    commands.push(`kit givetoplayer "card pack" ${safeTag}`);
                    break;
                case 'pack_farmer':
                    commands.push(`kit givetoplayer "farmer pack" ${safeTag}`);
                    break;
                case 'pack_turret':
                    commands.push(`kit givetoplayer "turret pack" ${safeTag}`);
                    break;
                case 'pack_teas':
                    commands.push(`kit givetoplayer "vip teas" ${safeTag}`);
                    break;
                case 'pack_charcoal':
                    
                    commands.push(`kit givetoplayer "charcoal pack" ${safeTag}`);
                    break;
            }
        }
    });

    return commands;
}

/** Single-item delivery for gem store (Rust `giveto`). */
async function giveToPlayer(gamertag, shortname, quantity) {
    const tag = String(gamertag || '').trim();
    const sn = String(shortname || '').trim();
    const qty = Math.max(1, Math.min(1000000, parseInt(quantity, 10) || 1));
    if (!tag || tag === 'unknown' || !sn) {
        return { success: false, error: 'Missing gamertag or item' };
    }
    const safeTag = `"${tag.replace(/"/g, '')}"`;
    const cmd = `giveto ${safeTag} ${sn} ${qty}`;
    try {
        await executeCommands([cmd], { throwOnError: true });
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : 'RCON failed' };
    }
}

module.exports = { executeCommands, getCommandsForItems, giveToPlayer };