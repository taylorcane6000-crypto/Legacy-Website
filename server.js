

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const cors = require('cors');

const stripeKey = process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.trim() : '';
/** Stripe SDK throws if constructed with an empty key — skip until STRIPE_SECRET_KEY is set (e.g. Railway Variables). */
const stripe = stripeKey ? require('stripe')(stripeKey) : null;
if (!stripeKey) {
    console.warn('[Stripe] STRIPE_SECRET_KEY not set — card checkout, gems purchase, and subscriptions are disabled.');
} 

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActivityType,
    Events,
    PermissionFlagsBits
} = require('discord.js');

const db = require('./data/database');
const rconHelper = require('./utils/rcon-helper');
const rconPlayerStats = require('./utils/rcon-player-stats');
const app = express();
/** Pterodactyl / panels set SERVER_PORT to the allocation; prefer it over .env PORT when present. */
function listenPort() {
    const raw = String(process.env.SERVER_PORT || process.env.PORT || '').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 3000;
}
const PORT = listenPort();
/** Local dev default: http://localhost:<PORT>. Production: set DOMAIN in .env (e.g. https://legacyrce.com). */
const DOMAIN = String(process.env.DOMAIN || `http://localhost:${PORT}`).replace(/\/$/, '');
/** Railway / nginx / CDNs — trust X-Forwarded-* so sessions and OAuth work on HTTPS. */
const isRailwayHost = Boolean(
    process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID
);
const isHttpsPublicDomain = /^https:\/\//i.test(DOMAIN) && !/localhost/i.test(DOMAIN);
if (isHttpsPublicDomain || isRailwayHost) {
    app.set('trust proxy', 1);
}

/** Panels / load balancers often probe this before marking the server up. */
app.get('/healthz', (_req, res) => {
    res.status(200).type('text/plain').send('ok');
});

let bot;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ? String(process.env.DISCORD_CLIENT_ID).trim() : '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET
    ? String(process.env.DISCORD_CLIENT_SECRET).trim()
    : '';
const CALLBACK_URL = process.env.CALLBACK_URL || `${DOMAIN}/auth/discord/callback`;
if (isRailwayHost || isHttpsPublicDomain) {
    console.log('[Auth] CALLBACK_URL must match Discord Developer Portal redirect exactly:', CALLBACK_URL);
}
/** Purchase / payment log channel (set PAYMENT_PURCHASE_LOGS or PURCHASE_LOG_CHANNEL in .env). */
const PURCHASE_LOG_CHANNEL = String(
    process.env.PAYMENT_PURCHASE_LOGS || process.env.PURCHASE_LOG_CHANNEL || '1441951080509476946'
).trim();

/** Comma-separated guild ids in .env. First entry is legacy “primary” for logs; addcred allows any listed id. Role delivery tries each guild (or STORE_GUILD_ID) until the bot can access one. */
function parseGuildIdsFromEnv() {
    return String(process.env.GUILD_ID || '1371268941779046441')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
const GUILD_IDS = parseGuildIdsFromEnv();
const GUILD_ID = GUILD_IDS[0] || '1371268941779046441';

/** If set, role delivery tries this guild first (bot must be a member). Alias: ROLE_DELIVERY_GUILD_ID. */
function parseStoreGuildIdOverride() {
    const raw = String(process.env.STORE_GUILD_ID || process.env.ROLE_DELIVERY_GUILD_ID || '').trim();
    return raw || null;
}
const STORE_GUILD_ID_OVERRIDE = parseStoreGuildIdOverride();

async function fetchGuildForRoleDelivery() {
    if (!bot) return null;
    const tryOrder = [];
    if (STORE_GUILD_ID_OVERRIDE) tryOrder.push(String(STORE_GUILD_ID_OVERRIDE));
    for (const id of GUILD_IDS) {
        const s = String(id);
        if (!tryOrder.includes(s)) tryOrder.push(s);
    }
    for (const gid of tryOrder) {
        try {
            const guild = await bot.guilds.fetch(gid);
            if (guild) {
                if (String(gid) !== String(GUILD_ID)) {
                    console.log('[Discord] Role delivery guild:', guild.id, guild.name || '');
                }
                return guild;
            }
        } catch (e) {
            if (e && e.code !== 10004) {
                console.warn('[Discord] Guild fetch for role delivery', gid, e.message);
            }
        }
    }
    console.error(
        '[Discord] Role delivery: no guild reachable (bot not in server or wrong id). Tried:',
        tryOrder.join(', ')
    );
    return null;
}

function isGuildAllowedForAddcred(guildId) {
    if (guildId == null || guildId === '') return false;
    return GUILD_IDS.some((id) => String(id) === String(guildId));
}

const MAX_ADDCRED_GBP = Math.min(100_000, Math.max(1, parseInt(process.env.MAX_ADDCRED_GBP, 10) || 10_000));

function getAdminRoleIds() {
    const raw = String(process.env.ADMIN_ROLES || '').replace(/^\uFEFF/, '');
    const snowflakes = raw.match(/\d{17,22}/g);
    return snowflakes ? [...new Set(snowflakes)] : [];
}

function memberHasStaffAddCredRole(member) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    try {
        if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    } catch (_) {
        /* ignore */
    }
    const ids = getAdminRoleIds();
    if (!ids.length) return false;
    return ids.some((id) => member.roles.cache.has(String(id)));
}

/** Prefer gateway member (roles often complete); else force-fetch; resolve partials. */
async function resolveMemberForAddCred(message) {
    let m = message.member;
    if (!m && message.guild) {
        m = await message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
    }
    if (m && m.partial) {
        m = await m.fetch().catch(() => m);
    }
    if ((!m || !m.roles?.cache?.size) && message.guild) {
        const again = await message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
        if (again) m = again.partial ? await again.fetch().catch(() => again) : again;
    }
    return m;
}

const ADDCRED_EMBED_COLORS = { ok: 0x22c55e, err: 0xed4245, info: 0x5865f2 };

function addcredEmbedFail(description) {
    return new EmbedBuilder()
        .setColor(ADDCRED_EMBED_COLORS.err)
        .setTitle('addcred — failed')
        .setDescription(description)
        .setTimestamp();
}

function addcredEmbedUsage(extraHint) {
    const hint = extraHint ? `\n\n${extraHint}` : '';
    return new EmbedBuilder()
        .setColor(ADDCRED_EMBED_COLORS.info)
        .setTitle('addcred — usage')
        .setDescription(
            '**Command**\n`!addcred <store email> <amount£>`\n\n**Example**\n`!addcred player@email.com 25`' + hint
        )
        .setTimestamp();
}

function addcredEmbedWrongGuild(guildId) {
    return new EmbedBuilder()
        .setColor(ADDCRED_EMBED_COLORS.err)
        .setTitle('addcred — failed')
        .setDescription('This server is not listed in `GUILD_ID` in `.env` (comma-separated guild ids).')
        .addFields(
            { name: 'This server', value: `\`${guildId}\``, inline: true },
            {
                name: 'Allowed',
                value: GUILD_IDS.map((id) => `\`${id}\``).join('\n').slice(0, 1024),
                inline: false
            }
        )
        .setTimestamp();
}

function addcredEmbedSuccess(amountGbp, target, emailRaw, balPence) {
    const bal = Math.max(0, Number(balPence) || 0) / 100;
    return new EmbedBuilder()
        .setColor(ADDCRED_EMBED_COLORS.ok)
        .setTitle('addcred — success')
        .setDescription(`Added **£${amountGbp.toFixed(2)}** store credit.`)
        .addFields(
            { name: 'Recipient', value: `<@${target.discord_id}>`, inline: true },
            { name: 'New balance', value: `£${bal.toFixed(2)}`, inline: true },
            {
                name: 'Account',
                value: String(target.gamertag || target.username || '—').slice(0, 256),
                inline: true
            },
            { name: 'Email matched', value: String(emailRaw || '—').slice(0, 1024), inline: false }
        )
        .setTimestamp();
}

function logAddcredReplyErr(context, err) {
    if (err && err.message) console.warn(`[addcred] ${context}: could not send Discord reply —`, err.message);
}

function webtoggleEmbed(state, actorTag) {
    const enabled = state === 'on';
    return new EmbedBuilder()
        .setColor(enabled ? 0x22c55e : 0xef4444)
        .setTitle('webtoggle — kits claim status')
        .setDescription(
            enabled
                ? 'Kits are now **claimable** on the website Kits page.'
                : 'Kits claiming is now **disabled** on the website Kits page.'
        )
        .addFields(
            { name: 'State', value: enabled ? '`on`' : '`off`', inline: true },
            { name: 'Changed by', value: String(actorTag || 'unknown').slice(0, 256), inline: true }
        )
        .setTimestamp();
}

async function postStoreCreditGrantToPaymentLog(staffUserId, staffTag, targetRow, emailRaw, amountGbp, newBalancePence) {
    if (!bot) return;
    try {
        const channel = await bot.channels.fetch(PURCHASE_LOG_CHANNEL).catch(() => null);
        if (!channel) {
            console.warn('[addcred] Payment log channel not found:', PURCHASE_LOG_CHANNEL);
            return;
        }
        const embed = new EmbedBuilder()
            .setTitle('💳 Store credit added (staff)')
            .setColor(0x22c55e)
            .addFields(
                { name: 'Added by', value: `<@${staffUserId}> (${staffTag})`, inline: true },
                {
                    name: 'Recipient',
                    value: `${targetRow.gamertag || targetRow.username || '—'} (<@${targetRow.discord_id}>)`,
                    inline: true
                },
                { name: 'Email matched', value: String(emailRaw || '—').slice(0, 1000), inline: true },
                { name: 'Amount added', value: `£${Number(amountGbp).toFixed(2)}`, inline: true },
                { name: 'New balance', value: `£${(Math.max(0, newBalancePence) / 100).toFixed(2)}`, inline: true }
            )
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch (e) {
        console.warn('[addcred] payment log embed failed:', e.message);
    }
}

async function executeAddCredCore(actorTag, actorUserId, member, emailRaw, amountGbp, sendReplyEmbed) {
    if (!memberHasStaffAddCredRole(member)) {
        await sendReplyEmbed(
            addcredEmbedFail(
                'You do not have permission.\n\n• Need **Administrator** in this server, **or** a role id listed in `ADMIN_ROLES`.\n• **Role ids are per-server** — if you use multiple guilds in `GUILD_ID`, add each guild’s staff role id to `ADMIN_ROLES` (comma-separated).'
            )
        );
        return;
    }

    if (!emailRaw || !String(emailRaw).includes('@')) {
        await sendReplyEmbed(
            addcredEmbedFail('Invalid email. Use the address they use on the store (Discord login email).')
        );
        return;
    }

    if (Number.isNaN(amountGbp) || amountGbp <= 0) {
        await sendReplyEmbed(
            addcredEmbedFail('Invalid amount. Use a positive number in £ (e.g. `10` or `10.50`).')
        );
        return;
    }

    if (amountGbp > MAX_ADDCRED_GBP) {
        await sendReplyEmbed(
            addcredEmbedFail(`Amount exceeds maximum (£${MAX_ADDCRED_GBP.toFixed(2)} per command).`)
        );
        return;
    }

    const pence = Math.round(amountGbp * 100);
    if (pence < 1) {
        await sendReplyEmbed(addcredEmbedFail('Amount too small after rounding.'));
        return;
    }

    const target = await db.getUserByEmail(emailRaw);
    if (!target) {
        await sendReplyEmbed(
            addcredEmbedFail(
                `No store account for \`${String(emailRaw).slice(0, 500)}\`. They must log in on the website with Discord so their email is saved.`
            )
        );
        return;
    }

    try {
        await db.adjustStoreCredit(target.discord_id, pence);
    } catch (credErr) {
        await sendReplyEmbed(
            addcredEmbedFail(String(credErr.message || 'Could not update store credit.').slice(0, 3500))
        );
        return;
    }

    const updated = await db.getUser(target.discord_id);
    const bal = updated && updated.store_credit_pence != null ? Number(updated.store_credit_pence) : 0;

    console.log(
        `[addcred] ${actorTag} added £${amountGbp.toFixed(2)} to ${target.discord_id} (${emailRaw}) — balance now £${(bal / 100).toFixed(2)}`
    );

    await sendReplyEmbed(addcredEmbedSuccess(amountGbp, updated || target, emailRaw, bal));

    await postStoreCreditGrantToPaymentLog(actorUserId, actorTag, updated, emailRaw, amountGbp, bal);
}

async function handleAddCredMessage(message) {
    try {
        if (!message.guild || message.author.bot) return;

        const raw = (message.content && message.content.trim()) || '';
        const lower = raw.toLowerCase();

        if (lower.startsWith('/webtoggle')) {
            const member = await resolveMemberForAddCred(message);
            const isAdmin = member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator);
            if (!isAdmin) {
                await message
                    .reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0xef4444)
                                .setTitle('webtoggle — denied')
                                .setDescription('Administrator permission is required to use `/webtoggle`.')
                                .setTimestamp()
                        ]
                    })
                    .catch((e) => logAddcredReplyErr('webtoggle-denied', e));
                return;
            }

            const arg = raw.split(/\s+/)[1] ? raw.split(/\s+/)[1].toLowerCase() : '';
            if (arg !== 'on' && arg !== 'off') {
                await message
                    .reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0xf59e0b)
                                .setTitle('webtoggle — usage')
                                .setDescription('Use `/webtoggle on` or `/webtoggle off`.')
                                .setTimestamp()
                        ]
                    })
                    .catch((e) => logAddcredReplyErr('webtoggle-usage', e));
                return;
            }

            kitsClaimingEnabled = arg === 'on';
            await message
                .reply({ embeds: [webtoggleEmbed(arg, message.author.tag)] })
                .catch((e) => logAddcredReplyErr('webtoggle', e));
            console.log(`[webtoggle] ${message.author.tag} set kits claiming to ${arg}`);
            return;
        }

        if (!lower.startsWith('!addcred')) return;

        if (!isGuildAllowedForAddcred(message.guild.id)) {
            await message
                .reply({ embeds: [addcredEmbedWrongGuild(message.guild.id)] })
                .catch((e) => logAddcredReplyErr('wrong-guild', e));
            return;
        }

        const member = await resolveMemberForAddCred(message);
        const argsStr = raw.slice('!addcred'.length).trim();
        if (!argsStr) {
            await message
                .reply({
                    embeds: [
                        addcredEmbedUsage(
                            'If the bot never replies to `!addcred`, enable **Message Content Intent** for the bot in the Discord Developer Portal.'
                        )
                    ]
                })
                .catch((e) => logAddcredReplyErr('usage', e));
            return;
        }

        const tokens = argsStr.split(/\s+/);
        if (tokens.length < 2) {
            await message
                .reply({ embeds: [addcredEmbedUsage()] })
                .catch((e) => logAddcredReplyErr('usage', e));
            return;
        }

        const amountToken = tokens[tokens.length - 1].replace(/[£,]/g, '');
        const emailRaw = tokens
            .slice(0, -1)
            .join(' ')
            .replace(/^["']|["']$/g, '')
            .trim();
        const amountGbp = parseFloat(amountToken);

        await executeAddCredCore(message.author.tag, message.author.id, member, emailRaw, amountGbp, async (embed) => {
            await message.reply({ embeds: [embed] }).catch((e) => logAddcredReplyErr('reply', e));
        });
    } catch (err) {
        console.error('[addcred]', err);
        await message
            .reply({
                embeds: [
                    addcredEmbedFail(String(err.message || 'Unexpected error.').slice(0, 3500))
                ]
            })
            .catch((e) => logAddcredReplyErr('catch', e));
    }
}

if (process.env.BOT_TOKEN) {
    bot = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });
    bot.once(Events.ClientReady, (client) => {
        const storeUrl = String(DOMAIN).replace(/\/$/, '');
        client.user.setActivity(storeUrl, { type: ActivityType.Watching });
        console.log('[Discord] Bot ready — presence (website):', storeUrl);
        console.log('[Discord] GUILD_ID(s) — primary:', GUILD_ID, '| addcred allowed:', GUILD_IDS.join(', '));
        if (STORE_GUILD_ID_OVERRIDE) {
            console.log('[Discord] STORE_GUILD_ID (role delivery first):', STORE_GUILD_ID_OVERRIDE);
        }
        const adminRoles = getAdminRoleIds();
        if (adminRoles.length) {
            console.log('[Discord] addcred staff roles (ADMIN_ROLES):', adminRoles.join(', '));
        } else {
            console.warn('[Discord] ADMIN_ROLES empty — addcred will deny everyone until set in .env');
        }
        console.log('[Discord] If !addcred is ignored: enable Bot → MESSAGE CONTENT INTENT in Developer Portal.');
    });
    bot.on(Events.MessageCreate, handleAddCredMessage);
    bot.login(process.env.BOT_TOKEN).catch((e) => console.error('[Discord] Bot Login Failed:', e.message));
} else {
    console.warn('[Discord] BOT_TOKEN missing in .env');
}


const PACK_ROLES = {
    
    'rank_storm':     '1443567873967784168', 
    'rank_aether':    '1443567867386921001', 
    'rank_celestial': '1443567845093937153', 
    'rank_void':      '1443567871254073486',
    'rank_striker':   '1446552839794196543',
};


/** Local asset: `assets/Product Logos/legacy vip card.png` (served under `/assets`). */
const VIP_LEGACY_CARD_IMG = '/assets/Product%20Logos/legacy%20vip%20card.png';

const PRODUCTS = {
    
    'queue_skip': { name: 'Queue Skip (One Time)', price: 299, images: ['https://cdn.tip4serv.com/shops-img/98758859c7895f3e68fd1aa7c08a7af53655.webp'] },
    'vip': { name: 'VIP', price: 499, images: [VIP_LEGACY_CARD_IMG] },
    'vip_standard': { name: 'VIP Status', price: 499, images: ['https://cdn.tip4serv.com/shops-img/98758859c7895f3e68fd1aa7c08a7af53655.webp'] },
    'vip_builder': { name: 'VIP Builder', price: 699, images: [] },
    'vip_components': { name: 'VIP - Comps', price: 699, images: [] },
    'vip_starter': { name: 'VIP Starter', price: 599, images: [] },
    'vip_turret': { name: 'VIP Turret', price: 599, images: [] },
    'vip_medical': { name: 'VIP Medical', price: 499, images: ['https://cdn.tip4serv.com/shops-img/9875b13835645312b32ea3c7c4916d9cd0c9.webp'] },
    'vip_deluxe': { name: 'VIP Deluxe', price: 2499, images: [] },
    
    
    'rank_doomsday': { name: 'Doomsday Rank', price: 8499, images: [] },
    'rank_celestial': { name: 'Celestial Rank', price: 6799, images: [] },
    'rank_immortal': { name: 'Immortal Rank', price: 5399, images: [] },
    'rank_void': { name: 'Void Rank', price: 4299, images: [] },
    'rank_storm': { name: 'Storm Rank', price: 3399, images: [] },
    'rank_zenith': { name: 'Zenith Rank', price: 2599, images: [] },
    'rank_recruit': { name: 'Recruit Rank', price: 1499, images: [] },

    
    'pack_build': { name: 'Build Pack', price: 999, images: ['https://cdn.tip4serv.com/shops-img/98757c64ba5fe85ef3624d91d9302fe5e884.webp'] },
    'pack_component': { name: 'Component Pack', price: 999, images: ['https://cdn.tip4serv.com/shops-img/9875c74afadf4aac1dd959150cada761b7e0.webp'] },
    'pack_charcoal': { name: 'Charcoal Pack', price: 399, images: ['https://cdn.tip4serv.com/shops-img/987506c254c0abd021d9c2177299a31c83a3.webp'] },
    'pack_supply': { name: 'Supply Drops', price: 299, images: ['https://cdn.tip4serv.com/shops-img/9875bbb0e4311de13ef5288e0ddd3874ebfe.webp'] },
    'pack_medical': { name: 'Medical Pack', price: 599, images: ['https://cdn.tip4serv.com/shops-img/98751e9125b9ea7f6168067203500c9c9f05.webp'] },
    'pack_mlrs': { name: 'MLRS Pack', price: 599, images: ['https://cdn.tip4serv.com/shops-img/9875c625490860ca059cb1dee2708734bbb7.webp'] },
    'pack_backpack': { name: 'Backpack Pack', price: 599, images: ['https://cdn.tip4serv.com/shops-img/98754903f66d078316e323bf029e74278787.webp'] },
    'pack_card': { name: 'Card Pack', price: 399, images: ['https://cdn.tip4serv.com/shops-img/98751b4e3dc392e0357e13a5a7ca7ad0a3f6.webp'] },
    'pack_farmer': { name: 'Farmer Pack', price: 499, images: ['https://cdn.tip4serv.com/shops-img/98750ea2942b58e83c6d925779b312f2a78c.webp'] },
    'pack_turret': { name: 'Turret Pack', price: 899, images: ['https://cdn.tip4serv.com/shops-img/987520faa112db8dd9c8b61ed00b8526832c.webp'] },
    'pack_teas': { name: 'Teas', price: 399, images: ['https://cdn.tip4serv.com/shops-img/98756866e111156ad7b48e7a18280c7fcf07.webp'] },
};

const RANK_DURATION_MS = 28 * 24 * 60 * 60 * 1000;
const PACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RANK_COOLDOWN_MS = 12 * 60 * 60 * 1000;
let kitsClaimingEnabled = true;

/** Monthly subscription price in pence (Stripe). VIP + rank subscriptions are ~18% under one-shot list price. */
function getSubscriptionPricePence(productId) {
    const p = PRODUCTS[productId];
    if (!p) return null;
    const subscribable = productId === 'vip' || productId.startsWith('vip_') || productId.startsWith('rank_');
    if (!subscribable) return null;
    return Math.max(100, Math.round(p.price * 0.82));
}

/** Resolves a customer-facing promo code to an active Stripe PromotionCode object, or null. */
async function findActivePromotionCode(raw) {
    if (!stripeKey || !stripe) return null;
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    try {
        const res = await stripe.promotionCodes.list({ active: true, code: trimmed, limit: 1 });
        const pc = res.data.find((p) => (p.code || '').toLowerCase() === trimmed.toLowerCase());
        if (pc && pc.active !== false) return pc;
    } catch (e) {
        console.warn('[Promo] list by code:', e.message);
    }
    try {
        const res2 = await stripe.promotionCodes.list({ active: true, limit: 100 });
        const lower = trimmed.toLowerCase();
        return res2.data.find((p) => (p.code || '').toLowerCase() === lower && p.active !== false) || null;
    } catch (e2) {
        console.warn('[Promo] list fallback:', e2.message);
        return null;
    }
}

/** GBP card checkouts need a minimum charge; smaller remainders must be covered by store credit. */
const MIN_STRIPE_CARD_PENCE = 30;

function normalizeStoreCreditForCheckout(subtotalPence, requestedCreditPence, balancePence) {
    const sub = Math.max(0, parseInt(subtotalPence, 10) || 0);
    const bal = Math.max(0, parseInt(balancePence, 10) || 0);
    let credit = Math.max(0, Math.min(parseInt(requestedCreditPence, 10) || 0, bal, sub));
    let cash = sub - credit;
    if (cash > 0 && cash < MIN_STRIPE_CARD_PENCE) {
        const extra = cash;
        if (credit + extra <= sub && bal >= credit + extra) {
            credit += extra;
            cash = 0;
        } else {
            const err = new Error(
                `Use enough store credit to cover the full total, or leave at least £${(MIN_STRIPE_CARD_PENCE / 100).toFixed(2)} to pay by card.`
            );
            err.code = 'STRIPE_MIN';
            throw err;
        }
    }
    return { creditAppliedPence: credit, cashDuePence: cash };
}

async function deliverStorePurchase(order, user, cartItems) {
    const rconCommands = rconHelper.getCommandsForItems(cartItems, user.gamertag);
    if (rconCommands.length > 0) {
        await rconHelper.executeCommands(rconCommands);
    }

    if (bot) {
        const guild = await fetchGuildForRoleDelivery();
        let member = null;

        if (guild) {
            member = await guild.members.fetch(user.discord_id).catch((e) => console.error('[Discord] Member Fetch Error:', e));

            if (member) {
                for (const item of cartItems) {
                    const roleId = PACK_ROLES[item.id];
                    if (roleId) {
                        try {
                            await member.roles.add(roleId);
                            console.log(`[Discord] Assigned role ${roleId} to ${user.username}`);
                        } catch (err) {
                            console.error(`[Discord] Failed to assign role ${roleId}:`, err.message);
                        }
                    }
                }
            }
        }

        const channel = await bot.channels.fetch(PURCHASE_LOG_CHANNEL).catch(() => null);
        if (channel) {
            const itemsList = cartItems
                .map((i) => {
                    const p = PRODUCTS[i.id];
                    return `${p.name} ${i.qty > 1 ? `x${i.qty}` : ''}`;
                })
                .join('\n');

            const scUsed = order.store_credit_used_pence || 0;
            const stripePaid =
                order.stripe_amount_pence != null ? order.stripe_amount_pence : Math.max(0, order.amount - scUsed);
            let amountVal = `£${(order.amount / 100).toFixed(2)} order value`;
            if (scUsed > 0) {
                amountVal += ` · Credit £${(scUsed / 100).toFixed(2)} · Card £${(stripePaid / 100).toFixed(2)}`;
            }

            const embed = new EmbedBuilder()
                .setTitle('🛒 New Purchase')
                .setColor('#8b5cf6')
                .addFields(
                    { name: 'User', value: `${user.gamertag} (<@${user.discord_id}>)`, inline: true },
                    { name: 'Email', value: user.email || 'N/A', inline: true },
                    { name: 'Amount', value: amountVal, inline: false },
                    { name: 'Items Purchased', value: itemsList || 'No items?' }
                )
                .setTimestamp();

            channel.send({ embeds: [embed] });
        }
    }
}

async function findOrCreateStripeCustomer(user) {
    if (!stripe) throw new Error('Stripe not configured');
    if (user.email) {
        const existing = await stripe.customers.list({ email: user.email, limit: 1 });
        if (existing.data.length > 0) return existing.data[0];
    }
    return stripe.customers.create({
        email: user.email || undefined,
        name: user.gamertag || user.username || undefined,
        metadata: {
            discord_id: user.discord_id,
            gamertag: user.gamertag || ''
        }
    });
}

async function deliverSubscriptionItems(user, productId) {
    const cartItems = [{ id: productId, qty: 1 }];
    const rconCommands = rconHelper.getCommandsForItems(cartItems, user.gamertag);
    if (rconCommands.length > 0) {
        await rconHelper.executeCommands(rconCommands);
    }
    if (bot) {
        const guild = await fetchGuildForRoleDelivery();
        if (guild) {
            const member = await guild.members.fetch(user.discord_id).catch((e) => console.error('[Discord] Member Fetch Error:', e));
            if (member) {
                const roleId = PACK_ROLES[productId];
                if (roleId) {
                    try {
                        await member.roles.add(roleId);
                        console.log(`[Discord] Subscription: assigned role ${roleId} to ${user.username}`);
                    } catch (err) {
                        console.error(`[Discord] Subscription role failed:`, err.message);
                    }
                }
            }
        }
    }
}

/** Kits page includes all rank and VIP products. */
function isKitsPageProductById(productId) {
    const id = String(productId || '');
    return id.startsWith('vip_') || id.startsWith('rank_');
}

function getKitCooldownMs(productId) {
    if (productId === 'vip' || productId.startsWith('rank_') || productId.startsWith('vip_')) return RANK_COOLDOWN_MS;
    return PACK_COOLDOWN_MS;
}

function getRankKitsCatalog() {
    return Object.keys(PRODUCTS)
        .filter((id) => isKitsPageProductById(id))
        .map((productId) => ({
            productId,
            name: PRODUCTS[productId].name,
            image: PRODUCTS[productId].images[0]
        }));
}

function buildKitInstancesFromOrders(orders, claimRows) {
    const claimMap = new Map(
        claimRows.map((row) => [row.kit_instance_id, row])
    );
    const kits = [];

    for (const order of orders) {
        let parsedItems = [];
        try {
            parsedItems = JSON.parse(order.items || '[]');
            if (!Array.isArray(parsedItems)) parsedItems = [];
        } catch (e) {
            parsedItems = [];
        }
        for (const item of parsedItems) {
            const product = PRODUCTS[item.id];
            if (!product || !isKitsPageProductById(item.id)) continue;

            const qty = Math.max(1, Number(item.qty || 1));
            for (let idx = 0; idx < qty; idx += 1) {
                const kitInstanceId = `${order.order_id}:${item.id}:${idx + 1}`;
                const claim = claimMap.get(kitInstanceId);
                const createdAtMs = new Date(order.created_at).getTime();
                const expiresAtMs = createdAtMs + RANK_DURATION_MS;
                const now = Date.now();
                const cooldownMs = getKitCooldownMs(item.id);
                const lastClaimAtMs = claim?.last_claimed_at ? new Date(claim.last_claimed_at).getTime() : null;
                const isExpired = now >= expiresAtMs;
                const timeUntilClaim = lastClaimAtMs
                    ? Math.max(0, cooldownMs - (now - lastClaimAtMs))
                    : 0;
                const canClaim = kitsClaimingEnabled && !isExpired && timeUntilClaim === 0;

                kits.push({
                    kitInstanceId,
                    orderId: order.order_id,
                    productId: item.id,
                    name: product.name,
                    image: product.images[0],
                    orderCreatedAt: order.created_at,
                    expiresAt: new Date(expiresAtMs).toISOString(),
                    cooldownMs,
                    canClaim,
                    isExpired,
                    timeUntilClaim,
                    lastClaimAt: claim?.last_claimed_at || null,
                    claimCount: claim?.claim_count || 0,
                    isCatalogOnly: false
                });
            }
        }
    }

    return kits.sort((a, b) => {
        if (a.isExpired !== b.isExpired) return a.isExpired ? 1 : -1;
        return new Date(b.orderCreatedAt).getTime() - new Date(a.orderCreatedAt).getTime();
    });
}

/** Adds one row per rank kit product the user has never purchased (no completed order line). */
function mergeKitsWithCatalog(instances) {
    const catalog = getRankKitsCatalog();
    const byProduct = new Map();
    for (const k of instances) {
        if (!byProduct.has(k.productId)) byProduct.set(k.productId, []);
        byProduct.get(k.productId).push(k);
    }
    const out = [...instances];
    for (const c of catalog) {
        const list = byProduct.get(c.productId);
        if (!list || list.length === 0) {
            out.push({
                kitInstanceId: null,
                orderId: null,
                productId: c.productId,
                name: c.name,
                image: c.image,
                orderCreatedAt: null,
                expiresAt: null,
                cooldownMs: RANK_COOLDOWN_MS,
                canClaim: false,
                isExpired: false,
                timeUntilClaim: 0,
                lastClaimAt: null,
                claimCount: 0,
                isCatalogOnly: true
            });
        }
    }
    return out;
}

passport.serializeUser((user, done) => {
    done(null, user.discord_id); 
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await db.getUser(id);
        done(null, user);
    } catch (e) { done(e, null); }
});

if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) {
    passport.use(new DiscordStrategy({
        clientID: DISCORD_CLIENT_ID,
        clientSecret: DISCORD_CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        scope: ['identify', 'email', 'guilds']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const user = {
                id: profile.id,
                username: profile.username,
                email: profile.email,
                pfp: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`,
                registeredAt: new Date().toISOString()
            };
            await db.saveUser(user);
            const fullUser = await db.getUser(profile.id);
            if (!fullUser) return done(new Error('User not found after save'), null);
            return done(null, fullUser);
        } catch (err) {
            return done(err, null);
        }
    }));
} else {
    console.warn('[Passport] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing — OAuth routes redirect until they are set.');
}

function ensureDiscordOAuthConfigured(req, res, next) {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
        return res.redirect('/?oauth_not_configured=1');
    }
    next();
}

app.use(express.json());
app.use(cors());
const sessionCookieSecure = isHttpsPublicDomain || isRailwayHost;
app.use(session({
    secret: process.env.SESSION_SECRET || 'legacy_rust_servers_fallback_secret_key_123', 
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        maxAge: 86400000,
        secure: sessionCookieSecure,
        sameSite: 'lax'
    }
}));
app.use(passport.initialize());
app.use(passport.session());

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

const createGemRouter = require('./utils/gem-routes');
app.use(
    '/api/gems',
    createGemRouter({
        db,
        stripe,
        stripeKey,
        DOMAIN,
        rconHelper,
        checkAuth
    })
);

const { createGambleRouter } = require('./utils/gamble-routes');
app.use('/api/gamble', createGambleRouter({ db, checkAuth }));

// Rust item icons for gem store (same CDN pattern as common Rust panels)
const rustImageCache = new Map();
app.get('/api/rust-image/:shortname', async (req, res) => {
    const { shortname } = req.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(shortname)) {
        return res.status(400).send('Invalid item name');
    }
    if (rustImageCache.has(shortname)) {
        const buf = rustImageCache.get(shortname);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=604800');
        return res.send(buf);
    }
    const https = require('https');
    const imageUrl = `https://cdn.jsdelivr.net/gh/rostov114/rust-items@main/${shortname}.128.png`;
    https
        .get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
            const done = (buf, code) => {
                if (code === 200 && buf && buf.length) {
                    rustImageCache.set(shortname, buf);
                    if (rustImageCache.size > 500) {
                        const first = rustImageCache.keys().next().value;
                        rustImageCache.delete(first);
                    }
                }
                res.status(code);
                if (code === 200) {
                    res.set('Content-Type', 'image/png');
                    res.set('Cache-Control', 'public, max-age=604800');
                    res.send(buf);
                } else {
                    res.end();
                }
            };
            if (response.statusCode === 301 || response.statusCode === 302) {
                const loc = response.headers.location;
                if (!loc) return done(null, 404);
                https.get(loc, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
                    const chunks = [];
                    r2.on('data', (c) => chunks.push(c));
                    r2.on('end', () => done(Buffer.concat(chunks), r2.statusCode));
                }).on('error', () => done(null, 404));
            } else {
                const chunks = [];
                response.on('data', (c) => chunks.push(c));
                response.on('end', () => done(Buffer.concat(chunks), response.statusCode));
            }
        })
        .on('error', () => res.status(404).end());
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/profile.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/gamertag-ask.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamertag-ask.html')));
app.get('/after_sales.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'after_sales.html')));
app.get('/kits.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kits.html')));
app.get('/purchase-history.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'purchase-history.html')));
app.get('/subscriptions.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscriptions.html')));
app.get('/leaderboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leaderboard.html')));
app.get('/gems', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gems.html')));
app.get('/gems.html', (req, res) => res.redirect(301, '/gems'));

app.get('/auth/discord', ensureDiscordOAuthConfigured, passport.authenticate('discord'));
app.get('/auth/discord/callback', ensureDiscordOAuthConfigured, (req, res, next) => {
    passport.authenticate('discord', (err, user, info) => {
        if (err) {
            console.error('[Discord OAuth]', err.message || err);
            return res.redirect('/?login_error=1');
        }
        if (!user) {
            console.warn('[Discord OAuth] denied or no profile', info && (info.message || info));
            return res.redirect('/?login_failed=1');
        }
        req.logIn(user, (loginErr) => {
            if (loginErr) {
                console.error('[Discord OAuth] session:', loginErr.message || loginErr);
                return res.redirect('/?login_error=1');
            }
            if (!user.gamertag) return res.redirect('/gamertag-ask.html');
            return res.redirect('/');
        });
    })(req, res, next);
});


app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) res.json({ loggedIn: true, user: req.user });
    else res.json({ loggedIn: false });
});

app.get('/api/store-credit', checkAuth, async (req, res) => {
    try {
        const row = await db.getUser(req.user.discord_id);
        const pence = row && row.store_credit_pence != null ? Number(row.store_credit_pence) : 0;
        res.json({ balance_pence: Math.max(0, pence) });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load balance' });
    }
});

function formatPlaytimeSeconds(seconds) {
    const s = Math.max(0, parseInt(seconds, 10) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return '0m';
}

const DEFAULT_LEADERBOARD_REGION = process.env.LEADERBOARD_REGION || 'main';

function requireLeaderboardIngest(req, res, next) {
    const secret = process.env.LEADERBOARD_INGEST_SECRET;
    if (!secret) {
        return res.status(503).json({
            success: false,
            error: 'Ingest not configured (set LEADERBOARD_INGEST_SECRET in .env)'
        });
    }
    if (req.headers['x-legacy-ingest'] !== secret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
}

/**
 * ?type=kills|playtime|deaths|spent — in-game stats aggregate player_stats; spent uses completed orders.
 */
app.get('/api/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const type = String(req.query.type || 'kills').toLowerCase();

        if (type === 'spent' || type === 'supporters') {
            const rows = await db.getLeaderboardBySpend(limit);
            const list = Array.isArray(rows) ? rows : [];
            const leaderboard = list.map((r, index) => ({
                rank: index + 1,
                discord_id: r.discord_id,
                gamertag: r.gamertag || 'Player',
                discord_username: r.username || '',
                avatar_url: r.pfp || null,
                total_spend_pence: r.total_spend,
                total_spend_gbp: (Number(r.total_spend) / 100).toFixed(2),
                order_count: r.order_count
            }));
            return res.json({ success: true, type: 'spent', leaderboard });
        }

        if (type === 'playtime') {
            const rows = await db.getPlaytimeLeaderboardAggregated(limit);
            const list = Array.isArray(rows) ? rows : [];
            const leaderboard = list.map((r, index) => ({
                rank: index + 1,
                gamertag: r.gamertag,
                playtime_seconds: Number(r.playtime_seconds) || 0,
                playtime_formatted: formatPlaytimeSeconds(r.playtime_seconds),
                kills: Number(r.kills) || 0,
                deaths: Number(r.deaths) || 0,
                avatar_url: r.pfp || null,
                discord_username: r.discord_username || ''
            }));
            return res.json({ success: true, type: 'playtime', leaderboard });
        }

        if (type === 'deaths') {
            const rows = await db.getDeathsLeaderboardAggregated(limit);
            const list = Array.isArray(rows) ? rows : [];
            const leaderboard = list.map((r, index) => ({
                rank: index + 1,
                gamertag: r.gamertag,
                deaths: Number(r.deaths) || 0,
                kills: Number(r.kills) || 0,
                kd_ratio: Number(r.kd_ratio) || 0,
                avatar_url: r.pfp || null,
                discord_username: r.discord_username || ''
            }));
            return res.json({ success: true, type: 'deaths', leaderboard });
        }

        const rows = await db.getKillsLeaderboardAggregated(limit);
        const list = Array.isArray(rows) ? rows : [];
        const leaderboard = list.map((r, index) => ({
            rank: index + 1,
            gamertag: r.gamertag,
            kills: Number(r.kills) || 0,
            deaths: Number(r.deaths) || 0,
            kd_ratio: Number(r.kd_ratio) || 0,
            avatar_url: r.pfp || null,
            discord_username: r.discord_username || ''
        }));
        res.json({ success: true, type: 'kills', leaderboard });
    } catch (error) {
        console.error('[Leaderboard] API error:', error);
        res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
    }
});

app.get('/api/leaderboard/player', async (req, res) => {
    try {
        const raw = req.query.gamertag || req.query.q || '';
        const gamertag = String(raw).trim();
        if (!gamertag) {
            return res.status(400).json({ success: false, error: 'Provide ?gamertag= or ?q=' });
        }

        const rows = await db.getPlayerStatsByGamertag(gamertag);
        const nemesis = await db.getPlayerNemesisStats(gamertag);
        const userRow = await db.getUserByGamertagCaseInsensitive(gamertag);
        let storeSpendPence = 0;
        if (userRow) {
            storeSpendPence = await db.getTotalCompletedSpendPence(userRow.discord_id);
        }

        const totals = rows.reduce(
            (acc, r) => ({
                kills: acc.kills + (r.total_kills || 0),
                deaths: acc.deaths + (r.total_deaths || 0),
                playtime: acc.playtime + (r.total_playtime_seconds || 0),
                npc_kills: acc.npc_kills + (r.total_npc_kills || 0)
            }),
            { kills: 0, deaths: 0, playtime: 0, npc_kills: 0 }
        );
        const kd =
            totals.deaths > 0
                ? Math.round((totals.kills / totals.deaths) * 100) / 100
                : totals.kills;

        const found = rows.length > 0 || userRow != null;
        const avatarUrl =
            (userRow && userRow.pfp) || (rows[0] && rows[0].discord_avatar) || null;

        res.json({
            success: true,
            found,
            gamertag,
            regions: rows.map((r) => ({
                region: r.region,
                total_kills: r.total_kills,
                total_deaths: r.total_deaths,
                total_npc_kills: r.total_npc_kills,
                total_playtime_seconds: r.total_playtime_seconds,
                playtime_formatted: formatPlaytimeSeconds(r.total_playtime_seconds),
                last_seen: r.last_seen,
                first_seen: r.first_seen
            })),
            totals: {
                ...totals,
                kd_ratio: kd,
                playtime_formatted: formatPlaytimeSeconds(totals.playtime)
            },
            nemesis,
            store: {
                linked: !!userRow,
                total_spend_gbp: (Number(storeSpendPence) / 100).toFixed(2),
                discord_username: userRow ? userRow.username : rows[0]?.discord_username || ''
            },
            avatar_url: avatarUrl
        });
    } catch (error) {
        console.error('[Leaderboard] Player lookup error:', error);
        res.status(500).json({ success: false, error: 'Lookup failed' });
    }
});

app.post('/api/ingest/kill', requireLeaderboardIngest, async (req, res) => {
    try {
        const { killerGamertag, victimGamertag, region } = req.body || {};
        await db.recordKill(killerGamertag, victimGamertag, region || DEFAULT_LEADERBOARD_REGION);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message || 'Ingest failed' });
    }
});

app.post('/api/ingest/session/join', requireLeaderboardIngest, async (req, res) => {
    try {
        const { gamertag, region } = req.body || {};
        await db.recordPlayerJoin(gamertag, region || DEFAULT_LEADERBOARD_REGION);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message || 'Ingest failed' });
    }
});

app.post('/api/ingest/session/leave', requireLeaderboardIngest, async (req, res) => {
    try {
        const { gamertag, region } = req.body || {};
        const seconds = await db.recordPlayerLeave(gamertag, region || DEFAULT_LEADERBOARD_REGION);
        res.json({ success: true, session_seconds: seconds });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message || 'Ingest failed' });
    }
});

app.post('/api/ingest/playtime', requireLeaderboardIngest, async (req, res) => {
    try {
        const { gamertag, region, seconds } = req.body || {};
        await db.updatePlaytimeDelta(gamertag, region || DEFAULT_LEADERBOARD_REGION, seconds);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message || 'Ingest failed' });
    }
});

app.post('/api/save-gamertag', checkAuth, async (req, res) => {
    const { gamertag, consoleType } = req.body;
    if (!gamertag || !consoleType) return res.status(400).json({ error: 'Missing fields' });
    
    await db.updateGamertag(req.user.discord_id, gamertag, consoleType);
    res.json({ success: true });
});

app.get('/api/purchased-kits', checkAuth, async (req, res) => {
    try {
        const orders = await db.getOrdersByDiscordId(req.user.discord_id);
        const claimRows = await db.getKitClaimsByDiscordId(req.user.discord_id);
        const instances = buildKitInstancesFromOrders(orders, claimRows);
        const kits = mergeKitsWithCatalog(instances);
        res.json({ success: true, kits });
    } catch (error) {
        console.error('Purchased kits fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to load purchases' });
    }
});

app.get('/api/purchase-history', checkAuth, async (req, res) => {
    try {
        const orders = await db.getOrdersByDiscordId(req.user.discord_id);
        const history = orders.map((order) => {
            let parsedItems = [];
            try {
                parsedItems = JSON.parse(order.items || '[]');
                if (!Array.isArray(parsedItems)) parsedItems = [];
            } catch (e) {
                parsedItems = [];
            }
            const items = parsedItems.map((item) => {
                const product = PRODUCTS[item.id];
                const qty = Math.max(1, Number(item.qty || 1));
                const unitPrice = product?.price || 0;
                return {
                    productId: item.id,
                    name: product?.name || item.id,
                    qty,
                    unitPrice,
                    totalPrice: unitPrice * qty,
                    image: product?.images?.[0] || ''
                };
            });

            return {
                orderId: order.order_id,
                amount: order.amount,
                currency: order.currency || 'gbp',
                status: order.status,
                createdAt: order.created_at,
                itemCount: items.reduce((sum, i) => sum + i.qty, 0),
                items
            };
        });

        res.json({ success: true, history });
    } catch (error) {
        console.error('Purchase history fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to load purchase history' });
    }
});

app.post('/api/purchased-kits/claim', checkAuth, async (req, res) => {
    try {
        if (!kitsClaimingEnabled) {
            return res.status(403).json({ success: false, error: 'Kits claiming is currently disabled by staff.' });
        }
        const { kitInstanceId } = req.body;
        if (!kitInstanceId) return res.status(400).json({ success: false, error: 'Missing kitInstanceId' });

        const orders = await db.getOrdersByDiscordId(req.user.discord_id);
        const claimRows = await db.getKitClaimsByDiscordId(req.user.discord_id);
        const instances = buildKitInstancesFromOrders(orders, claimRows);
        const targetKit = instances.find((k) => k.kitInstanceId === kitInstanceId);

        if (!targetKit) return res.status(404).json({ success: false, error: 'Kit not found' });
        if (targetKit.isExpired) return res.status(400).json({ success: false, error: 'Kit has expired' });
        if (!targetKit.canClaim) return res.status(400).json({ success: false, error: 'Kit is on cooldown' });

        const rconCommands = rconHelper.getCommandsForItems(
            [{ id: targetKit.productId, qty: 1 }],
            req.user.gamertag
        );
        if (rconCommands.length > 0) {
            await rconHelper.executeCommands(rconCommands);
        }

        await db.recordKitClaim(req.user.discord_id, kitInstanceId, targetKit.productId);
        res.json({ success: true, message: `${targetKit.name} claimed successfully` });
    } catch (error) {
        console.error('Purchased kit claim error:', error);
        res.status(500).json({ success: false, error: 'Failed to claim kit' });
    }
});


app.post('/api/subscriptions/create-checkout', checkAuth, async (req, res) => {
    try {
        if (!stripeKey || !stripe) {
            return res.status(503).json({ error: 'Payments are not configured.' });
        }
        const { productId } = req.body || {};
        if (!productId || typeof productId !== 'string') {
            return res.status(400).json({ error: 'productId required' });
        }
        const monthlyPence = getSubscriptionPricePence(productId);
        if (monthlyPence == null) {
            return res.status(400).json({ error: 'This product is not available as a subscription.' });
        }
        if (!req.user.gamertag) {
            return res.status(400).json({ error: 'Set your gamertag in your profile before subscribing.' });
        }

        const existing = await db.getSubscriptionsByDiscordId(req.user.discord_id);
        const duplicate = existing.find(
            (s) => s.product_id === productId && ['active', 'trialing'].includes(s.status)
        );
        if (duplicate) {
            return res.status(400).json({
                error: 'You already have an active subscription for this product. Cancel it first if you want to change billing.'
            });
        }

        const storeItem = PRODUCTS[productId];
        const customer = await findOrCreateStripeCustomer(req.user);

        const stripePrice = await stripe.prices.create({
            currency: 'gbp',
            unit_amount: monthlyPence,
            recurring: { interval: 'month' },
            product_data: {
                name: `${storeItem.name} (Monthly)`
            }
        });

        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: stripePrice.id, quantity: 1 }],
            metadata: {
                product_id: productId,
                product_name: storeItem.name,
                discord_id: req.user.discord_id,
                gamertag: req.user.gamertag,
                interval: 'month'
            },
            subscription_data: {
                metadata: {
                    product_id: productId,
                    product_name: storeItem.name,
                    discord_id: req.user.discord_id,
                    gamertag: req.user.gamertag,
                    interval: 'month'
                }
            },
            success_url: `${DOMAIN}/subscription-callback?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/?subscription=cancelled`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('[Subscription] Create checkout error:', error);
        res.status(500).json({ error: error.message || 'Failed to start subscription checkout' });
    }
});

app.get('/subscription-callback', async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.redirect('/subscriptions.html?error=no_session');
    if (!stripeKey || !stripe) return res.redirect('/subscriptions.html?error=payments_disabled');

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
        if (!session || session.mode !== 'subscription') {
            return res.redirect('/subscriptions.html?error=invalid_session');
        }
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
            return res.redirect('/subscriptions.html?error=payment_failed');
        }

        const subscription = session.subscription;
        if (!subscription || typeof subscription === 'string') {
            return res.redirect('/subscriptions.html?error=no_subscription');
        }

        const meta = session.metadata || {};
        const productId = meta.product_id;
        if (!productId || !PRODUCTS[productId]) {
            return res.redirect('/subscriptions.html?error=bad_product');
        }

        const existing = await db.getSubscriptionByStripeId(subscription.id);
        if (existing) {
            return res.redirect('/subscriptions.html?success=1');
        }

        const item = subscription.items?.data?.[0] || {};
        const periodStart = subscription.current_period_start ?? item.current_period_start ?? null;
        const periodEnd = subscription.current_period_end ?? item.current_period_end ?? null;

        await db.createSubscription({
            stripe_subscription_id: subscription.id,
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id,
            discord_id: meta.discord_id,
            gamertag: meta.gamertag,
            product_id: productId,
            product_name: meta.product_name || PRODUCTS[productId].name,
            amount: item.price?.unit_amount ?? subscription.items?.data?.[0]?.price?.unit_amount,
            currency: subscription.currency || 'gbp',
            interval: meta.interval || 'month',
            status: subscription.status,
            current_period_start: periodStart,
            current_period_end: periodEnd,
            cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
            cancelled_at: null
        });

        const user = await db.getUser(meta.discord_id);
        if (user && user.gamertag) {
            await deliverSubscriptionItems(user, productId);
        }

        res.redirect('/subscriptions.html?success=1');
    } catch (err) {
        console.error('[Subscription] Callback error:', err);
        res.redirect('/subscriptions.html?error=callback_failed');
    }
});

app.get('/api/subscriptions/list', checkAuth, async (req, res) => {
    try {
        const rows = await db.getSubscriptionsByDiscordId(req.user.discord_id);
        if (!stripeKey || !stripe) {
            return res.json({
                success: true,
                subscriptions: rows.map((sub) => ({
                    stripe_subscription_id: sub.stripe_subscription_id,
                    product_id: sub.product_id,
                    product_name: sub.product_name,
                    amount: sub.amount,
                    currency: sub.currency || 'gbp',
                    interval: sub.interval || 'month',
                    status: sub.status,
                    current_period_start: sub.current_period_start,
                    current_period_end: sub.current_period_end,
                    cancel_at_period_end: !!sub.cancel_at_period_end,
                    created_at: sub.created_at
                }))
            });
        }
        const subscriptions = await Promise.all(
            rows.map(async (sub) => {
                try {
                    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
                    const item = stripeSub.items?.data?.[0] || {};
                    const periodStart = stripeSub.current_period_start ?? item.current_period_start ?? null;
                    const periodEnd = stripeSub.current_period_end ?? item.current_period_end ?? null;

                    if (stripeSub.status !== sub.status) {
                        await db.updateSubscriptionStatus(sub.stripe_subscription_id, stripeSub.status);
                    }
                    if (periodStart != null && periodEnd != null) {
                        await db.updateSubscriptionPeriod(sub.stripe_subscription_id, periodStart, periodEnd);
                    }

                    return {
                        stripe_subscription_id: sub.stripe_subscription_id,
                        product_id: sub.product_id,
                        product_name: sub.product_name,
                        amount: sub.amount,
                        currency: sub.currency || 'gbp',
                        interval: sub.interval || 'month',
                        status: stripeSub.status,
                        current_period_start: periodStart,
                        current_period_end: periodEnd,
                        cancel_at_period_end: !!stripeSub.cancel_at_period_end,
                        created_at: sub.created_at
                    };
                } catch (e) {
                    console.error('[Subscription] Stripe sync failed:', sub.stripe_subscription_id, e.message);
                    return {
                        stripe_subscription_id: sub.stripe_subscription_id,
                        product_id: sub.product_id,
                        product_name: sub.product_name,
                        amount: sub.amount,
                        currency: sub.currency || 'gbp',
                        interval: sub.interval || 'month',
                        status: sub.status,
                        current_period_start: sub.current_period_start,
                        current_period_end: sub.current_period_end,
                        cancel_at_period_end: !!sub.cancel_at_period_end,
                        created_at: sub.created_at
                    };
                }
            })
        );

        res.json({ success: true, subscriptions });
    } catch (error) {
        console.error('[Subscription] List error:', error);
        res.status(500).json({ success: false, error: 'Failed to load subscriptions' });
    }
});

app.post('/api/subscriptions/cancel', checkAuth, async (req, res) => {
    try {
        if (!stripeKey || !stripe) {
            return res.status(503).json({ success: false, error: 'Payments are not configured.' });
        }
        const { subscriptionId } = req.body || {};
        if (!subscriptionId) {
            return res.status(400).json({ success: false, error: 'subscriptionId required' });
        }

        const subRow = await db.getSubscriptionByStripeId(subscriptionId);
        if (!subRow || subRow.discord_id !== req.user.discord_id) {
            return res.status(403).json({ success: false, error: 'Subscription not found' });
        }

        if (subRow.status === 'canceled' || subRow.status === 'cancelled') {
            return res.json({ success: true, message: 'Already cancelled.' });
        }

        const stripeSubId = String(subscriptionId).replace(/_item_\d+$/, '');
        const cancelledSub = await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });

        let periodStart = cancelledSub.current_period_start || null;
        let periodEnd = cancelledSub.current_period_end || null;
        if (!periodEnd && cancelledSub.latest_invoice) {
            try {
                const inv = await stripe.invoices.retrieve(cancelledSub.latest_invoice);
                if (inv.lines?.data?.[0]?.period) {
                    periodStart = inv.lines.data[0].period.start;
                    periodEnd = inv.lines.data[0].period.end;
                }
            } catch (invErr) {
                console.warn('[Subscription] Invoice period fetch:', invErr.message);
            }
        }

        await db.updateSubscriptionCancelPending(
            stripeSubId,
            new Date().toISOString(),
            periodStart,
            periodEnd
        );

        res.json({
            success: true,
            message: 'Subscription will end after the current billing period.',
            cancel_at: cancelledSub.current_period_end
        });
    } catch (error) {
        console.error('[Subscription] Cancel error:', error);
        res.status(500).json({ success: false, error: error.message || 'Cancel failed' });
    }
});

app.post('/create-checkout-session', checkAuth, async (req, res) => {
    try {
        const { cartItems, promotionCode: promotionCodeRaw, storeCreditPence: storeCreditRaw } = req.body;
        if (!cartItems || cartItems.length === 0) return res.status(400).json({ error: 'Empty Cart' });

        const promotionCodeTrimmed = typeof promotionCodeRaw === 'string' ? promotionCodeRaw.trim() : '';
        const requestedCredit = parseInt(storeCreditRaw, 10) || 0;

        let totalAmount = 0;
        for (const item of cartItems) {
            const storeItem = PRODUCTS[item.id];
            if (!storeItem) {
                return res.status(400).json({ error: 'Invalid product in cart.' });
            }
            totalAmount += storeItem.price * item.qty;
        }

        const userRow = await db.getUser(req.user.discord_id);
        const balancePence = userRow && userRow.store_credit_pence != null ? Number(userRow.store_credit_pence) : 0;

        let creditAppliedPence;
        let cashDuePence;
        try {
            const norm = normalizeStoreCreditForCheckout(totalAmount, requestedCredit, balancePence);
            creditAppliedPence = norm.creditAppliedPence;
            cashDuePence = norm.cashDuePence;
        } catch (normErr) {
            const msg = normErr && normErr.message ? normErr.message : 'Invalid store credit.';
            const code = normErr && normErr.code === 'STRIPE_MIN' ? 400 : 500;
            return res.status(code).json({ error: msg });
        }

        if (cashDuePence <= 0) {
            const orderId = `cr_${crypto.randomBytes(16).toString('hex')}`;
            await db.createOrder(orderId, req.user.discord_id, totalAmount, cartItems, {
                storeCreditUsedPence: creditAppliedPence,
                stripeAmountPence: 0
            });
            try {
                await db.adjustStoreCredit(req.user.discord_id, -creditAppliedPence);
            } catch (deductErr) {
                await db.deletePendingOrder(orderId);
                console.error('[Checkout] Credit deduct failed:', deductErr.message);
                return res.status(400).json({ error: deductErr.message || 'Could not apply store credit.' });
            }
            try {
                const order = await db.getOrder(orderId);
                const user = await db.getUser(req.user.discord_id);
                const cartItemsParsed = JSON.parse(order.items);
                await deliverStorePurchase(order, user, cartItemsParsed);
                await db.completeOrder(orderId);
            } catch (fulfillErr) {
                console.error('[Checkout] Fulfillment error (credit-only):', fulfillErr);
                try {
                    await db.adjustStoreCredit(req.user.discord_id, creditAppliedPence);
                } catch (revertErr) {
                    console.error('[Checkout] Credit revert failed:', revertErr.message);
                }
                await db.deletePendingOrder(orderId);
                return res.status(500).json({ error: 'Order could not be completed. Your balance was restored if possible — contact staff.' });
            }
            return res.json({ url: `${DOMAIN}/after_sales.html?paid=credit` });
        }

        if (!stripeKey || !stripe) {
            return res.status(503).json({ error: 'Card payment is not configured; use store credit for the full amount or set STRIPE_SECRET_KEY.' });
        }

        const itemSummary = cartItems
            .map((i) => {
                const p = PRODUCTS[i.id];
                return `${p.name} ×${i.qty}`;
            })
            .join(', ')
            .slice(0, 450);

        const line_items =
            creditAppliedPence > 0
                ? [
                      {
                          price_data: {
                              currency: 'gbp',
                              product_data: {
                                  name: 'Legacy Rust Servers — store order',
                                  description:
                                      `${cartItems.length} line(s). £${(creditAppliedPence / 100).toFixed(2)} store credit applied. ${itemSummary}`,
                                  images: []
                              },
                              unit_amount: cashDuePence
                          },
                          quantity: 1
                      }
                  ]
                : (() => {
                      const items = [];
                      for (const item of cartItems) {
                          const storeItem = PRODUCTS[item.id];
                          const imageUrl = Array.isArray(storeItem.images) ? storeItem.images[0] : null;
                          const productData = imageUrl
                              ? { name: storeItem.name, images: [imageUrl] }
                              : { name: storeItem.name };
                          items.push({
                              price_data: {
                                  currency: 'gbp',
                                  product_data: productData,
                                  unit_amount: storeItem.price
                              },
                              quantity: item.qty
                          });
                      }
                      return items;
                  })();

        const sessionPayload = {
            payment_method_types: ['card'],
            line_items,
            mode: 'payment',
            success_url: `${DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/?status=canceled`,
            metadata: {
                discord_id: req.user.discord_id,
                cart_json: JSON.stringify(cartItems),
                store_credit_applied_pence: String(creditAppliedPence)
            }
        };

        if (promotionCodeTrimmed) {
            const promo = await findActivePromotionCode(promotionCodeTrimmed);
            if (!promo) {
                return res.status(400).json({ error: 'Invalid or inactive promo code.' });
            }
            sessionPayload.discounts = [{ promotion_code: promo.id }];
        } else {
            sessionPayload.allow_promotion_codes = true;
        }

        const session = await stripe.checkout.sessions.create(sessionPayload);

        await db.createOrder(session.id, req.user.discord_id, totalAmount, cartItems, {
            storeCreditUsedPence: creditAppliedPence,
            stripeAmountPence: cashDuePence
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe Error:', error);
        res.status(500).json({ error: error.message });
    }
});


app.get('/payment-success', async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.redirect('/');

    try {
        if (!stripeKey || !stripe) return res.status(503).send('Payments not configured.');
        const order = await db.getOrder(sessionId);
        if (!order) return res.send('Order not found.');
        if (order.status === 'completed') return res.redirect('/after_sales.html');

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
            return res.send('Payment not verified.');
        }

        const user = await db.getUser(order.discord_id);
        const cartItems = JSON.parse(order.items);

        const creditUsed = parseInt(session.metadata?.store_credit_applied_pence || '0', 10) || 0;
        if (creditUsed > 0) {
            try {
                await db.adjustStoreCredit(order.discord_id, -creditUsed);
            } catch (credErr) {
                console.error('[Payment success] Store credit deduct failed:', credErr.message);
            }
        }

        await deliverStorePurchase(order, user, cartItems);
        await db.completeOrder(sessionId);
        res.redirect('/after_sales.html');
    } catch (err) {
        console.error('Payment Success Error:', err);
        res.status(500).send('Error processing order.');
    }
});

app.get('/logout', (req, res, next) => {
    req.logout((err) => { if (err) return next(err); res.redirect('/'); });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

/** Casino page — registered after static so `GET /gamble` is never swallowed by missing-file behaviour in some setups. */
const GAMBLE_HTML = path.resolve(__dirname, 'public', 'gamble.html');
app.get('/gamble', (req, res) => {
    res.sendFile(GAMBLE_HTML, (err) => {
        if (err) {
            console.error('[Gamble] sendFile failed:', err.message);
            res.status(500).send('Casino page unavailable');
        }
    });
});
app.get('/gamble/', (req, res) => res.redirect(301, '/gamble'));
app.get('/gamble.html', (req, res) => res.redirect(301, '/gamble'));

rconPlayerStats.start(db);

const home = String(process.env.HOME || '');
const cwd = process.cwd();
const looksLikePtero =
    home === '/home/container' ||
    cwd === '/home/container' ||
    cwd.startsWith('/home/container/');

/** Bind IPv4 explicitly; some container health checks do not hit IPv6-only listeners. */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Legacy Rust Servers] Server running on port ${PORT}`);
    /** Avoid Docker/Wings log buffering missing the startup line before the panel times out. */
    const logSyncStartup = (line, fd = 1) => {
        const s = String(line).endsWith('\n') ? String(line) : `${line}\n`;
        try {
            require('fs').writeSync(fd, s);
        } catch (_) {
            console.log(line);
        }
    };
    logSyncStartup('PTERODACTYL_STARTUP_COMPLETE');
    // Default ptero-eggs "generic node.js" `done` text; panel stays "Starting" until this substring appears.
    if (looksLikePtero) {
        logSyncStartup('change this text 1');
        logSyncStartup('change this text 1', 2);
        logSyncStartup('change this text 2');
    }
});