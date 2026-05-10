// Gem store API (buy gems via Stripe, spend gems on RCON giveto items) — session auth (same as rest of site).

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rconPlayerStats = require('./rcon-player-stats');

/** Legacy runs one RCON server (5x). Catalog defaults to `gem-items-5x.json`; override with `GEM_ITEMS_FILE` if needed. */
const _gemFileRaw = String(process.env.GEM_ITEMS_FILE || 'gem-items-5x.json').trim();
const GEM_ITEMS_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(_gemFileRaw) ? _gemFileRaw : 'gem-items-5x.json';
const GEM_ITEMS_PATH = path.join(__dirname, '..', 'data', GEM_ITEMS_FILE);

/** £ pricing: 69p per 100 gems (Stripe amounts are whole pence). */
const GEM_PENCE_PER_100 = Math.max(1, parseInt(process.env.GEM_PENCE_PER_100 || '69', 10) || 69);

const GEM_PACKS = {
    gems_100: { id: 'gems_100', gems: 100, label: 'Starter', badge: null, pricePence: Math.round((100 * GEM_PENCE_PER_100) / 100) },
    gems_500: { id: 'gems_500', gems: 500, label: 'Popular', badge: 'popular', pricePence: Math.round((500 * GEM_PENCE_PER_100) / 100) },
    gems_1000: { id: 'gems_1000', gems: 1000, label: 'Value', badge: null, pricePence: Math.round((1000 * GEM_PENCE_PER_100) / 100) },
    gems_2500: { id: 'gems_2500', gems: 2500, label: 'Premium', badge: 'best-value', pricePence: Math.round((2500 * GEM_PENCE_PER_100) / 100) },
    gems_5000: { id: 'gems_5000', gems: 5000, label: 'Ultimate', badge: null, pricePence: Math.round((5000 * GEM_PENCE_PER_100) / 100) }
};

const CUSTOM_GEM_MIN = 100;
const CUSTOM_GEM_MAX = 100000;

function loadGemItems() {
    try {
        return JSON.parse(fs.readFileSync(GEM_ITEMS_PATH, 'utf8'));
    } catch (e) {
        console.warn('[Gems] Could not load catalog:', GEM_ITEMS_PATH, e.message);
        return { items: [] };
    }
}

let _loggedCatalogPath = false;
function logCatalogOnce() {
    if (_loggedCatalogPath) return;
    _loggedCatalogPath = true;
    const data = loadGemItems();
    console.log(`[Gems] Catalog ${GEM_ITEMS_FILE} — ${data.items?.length ?? 0} items`);
}

function rconConfigured() {
    return !!(process.env['6X_RCON_IP'] && process.env['6X_RCON_PASS']);
}

function createGemRouter({ db, stripe, stripeKey, DOMAIN, rconHelper, checkAuth }) {
    logCatalogOnce();
    const router = express.Router();
    const baseUrl = String(DOMAIN || '').replace(/\/$/, '');

    // Stripe return URL — browser hit; credit gems using session metadata (no session auth required)
    router.get('/buy-return', async (req, res) => {
        const sessionId = req.query.session_id;
        if (!sessionId || !stripeKey || !stripe) {
            return res.redirect('/gems?error=no_session');
        }
        try {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            const meta = session.metadata || {};
            if (meta.type !== 'gem_purchase' || !meta.discord_id || !meta.gems) {
                return res.redirect('/gems?error=invalid');
            }
            const existing = await db.getGemTransactionByRef(sessionId);
            if (existing) {
                return res.redirect(`/gems?success=1&amount=${encodeURIComponent(meta.gems)}`);
            }
            if (session.payment_status !== 'paid') {
                return res.redirect('/gems?error=unpaid');
            }
            const gems = parseInt(meta.gems, 10);
            const r = await db.addGems(
                meta.discord_id,
                gems,
                'purchase',
                `Purchased ${gems.toLocaleString()} gems (${meta.packId || 'pack'})`,
                sessionId
            );
            if (r.duplicate) {
                return res.redirect(`/gems?success=1&amount=${gems}`);
            }
            console.log(`[Gems] Stripe delivered ${gems} gems to ${meta.discord_id}`);
            return res.redirect(`/gems?success=1&amount=${gems}`);
        } catch (e) {
            console.error('[Gems] buy-return:', e.message);
            return res.redirect('/gems?error=callback');
        }
    });

    router.get('/balance', checkAuth, async (req, res) => {
        try {
            const row = await db.getUser(req.user.discord_id);
            const bal = row && row.gems != null ? Math.max(0, Number(row.gems)) : 0;
            res.json({ success: true, balance: bal });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // Public catalog: no auth required (purchase/buy/balance still protected).
    router.get('/store', async (req, res) => {
        try {
            const data = loadGemItems();
            const categories = {};
            for (const item of data.items || []) {
                const c = item.category || 'Misc';
                if (!categories[c]) categories[c] = [];
                categories[c].push(item);
            }
            res.json({
                success: true,
                enabled: true,
                rconConfigured: rconConfigured(),
                categories,
                items: data.items || []
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** Public: how playtime gem earning works (RCON playerlist must be enabled). Optional rank bonus when logged in. */
    router.get('/earning-rate', async (req, res) => {
        const gemsPerHour = Math.max(1, parseInt(process.env.GEM_EARN_PER_HOUR || '10', 10) || 10);
        const secondsPerFullReward = Math.max(60, parseInt(process.env.GEM_EARN_INTERVAL_SEC || '3600', 10) || 3600);
        const earnEnabled = process.env.GEM_EARN_ENABLED !== 'false' && process.env.GEM_EARN_ENABLED !== '0';
        const hoursLabel = secondsPerFullReward === 3600 ? 'hour' : `${secondsPerFullReward} seconds`;
        const _rb = process.env.GEM_EARN_BONUS_PER_RANK;
        const bonusPerRank =
            _rb === undefined || _rb === '' ? 10 : Math.max(0, parseInt(_rb, 10) || 0);
        let ranksOwned = null;
        try {
            if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) {
                ranksOwned = await db.countDistinctOwnedRanks(req.user.discord_id);
            }
        } catch (e) {
            ranksOwned = null;
        }
        const extra = ranksOwned != null ? ranksOwned * bonusPerRank : 0;
        const gemsPerHourTotal = gemsPerHour + extra;
        const summary =
            bonusPerRank > 0
                ? `Link your gamertag on the site. While you are online on the server, RCON playtime tracking adds ${gemsPerHour} base gems per ${hoursLabel}, plus ${bonusPerRank} per ${hoursLabel} for each rank purchased from the store (distinct rank products in completed orders).`
                : `Link your gamertag on the site. While you are online on the server, RCON playtime tracking adds ${gemsPerHour} gems per ${hoursLabel} of in-game time (from playerlist ConnectedSeconds).`;
        res.json({
            success: true,
            gemsPerHour,
            bonusPerRank,
            ranksOwned,
            gemsPerHourTotal,
            secondsPerFullReward,
            earnEnabled,
            playtimeTrackingActive: rconPlayerStats.statsEnabled(),
            summary
        });
    });

    router.post('/purchase', checkAuth, async (req, res) => {
        try {
            if (!rconConfigured()) {
                return res.status(503).json({
                    success: false,
                    error: 'Gem item delivery is not configured (set 6X_RCON_* in .env).'
                });
            }
            const gamertag = req.user.gamertag;
            if (!gamertag || String(gamertag).toLowerCase() === 'unknown') {
                return res.status(400).json({
                    success: false,
                    error: 'Set your gamertag in your profile before buying gem items.'
                });
            }
            const { item_id, quantity } = req.body || {};
            const qty = Math.min(100, Math.max(1, parseInt(quantity, 10) || 1));
            if (!item_id) {
                return res.status(400).json({ success: false, error: 'Missing item_id' });
            }
            const data = loadGemItems();
            const item = (data.items || []).find((i) => i.id === item_id);
            if (!item) {
                return res.status(404).json({ success: false, error: 'Item not found' });
            }
            const totalCost = item.price * qty;
            const totalItemQty = item.quantity * qty;
            const refBase = `gem_buy_${item_id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${req.user.discord_id}`;
            const spend = await db.spendGems(
                req.user.discord_id,
                totalCost,
                'spend',
                `${qty}x ${item.name}`,
                refBase
            );
            if (!spend.success) {
                return res.status(400).json({ success: false, error: spend.error || 'Could not spend gems' });
            }
            const rcon = await rconHelper.giveToPlayer(gamertag, item.shortname, totalItemQty);
            if (!rcon.success) {
                await db.addGems(
                    req.user.discord_id,
                    totalCost,
                    'refund',
                    `Refund: RCON failed for ${item.name}`,
                    `refund_${refBase}`
                );
                return res.status(503).json({
                    success: false,
                    error: rcon.error || 'Could not deliver item; gems refunded.'
                });
            }
            await db.logGemPurchase({
                discord_id: req.user.discord_id,
                gamertag,
                item_id: item.id,
                item_name: item.name,
                quantity: qty,
                total_cost: totalCost
            });
            const row = await db.getUser(req.user.discord_id);
            const newBal = row && row.gems != null ? Math.max(0, Number(row.gems)) : 0;
            console.log(`[Gems] ${gamertag} bought ${qty}x ${item.name} for ${totalCost} gems`);
            res.json({
                success: true,
                new_balance: newBal,
                message: `Delivered ${totalItemQty}x ${item.name}`,
                cost: totalCost
            });
        } catch (e) {
            console.error('[Gems] purchase:', e);
            res.status(500).json({ success: false, error: e.message || 'Purchase failed' });
        }
    });

    router.get('/packs', checkAuth, (req, res) => {
        if (!stripeKey) {
            return res.json({ success: false, error: 'Payments not configured', packs: [] });
        }
        res.json({
            success: true,
            currency: 'gbp',
            symbol: '£',
            packs: Object.values(GEM_PACKS).map((p) => ({
                id: p.id,
                gems: p.gems,
                price: (p.pricePence / 100).toFixed(2),
                label: p.label,
                badge: p.badge
            })),
            customPencePer100Gems: GEM_PENCE_PER_100,
            customMin: CUSTOM_GEM_MIN,
            customMax: CUSTOM_GEM_MAX
        });
    });

    router.post('/buy', checkAuth, async (req, res) => {
        if (!stripeKey || !stripe) {
            return res.status(503).json({ success: false, error: 'Stripe not configured' });
        }
        try {
            const { packId, customGems } = req.body || {};
            let gems;
            let unitAmountPence;
            let metaPackId;
            let productName;

            if (customGems != null && customGems !== '') {
                const amount = parseInt(customGems, 10);
                if (Number.isNaN(amount) || amount < CUSTOM_GEM_MIN || amount > CUSTOM_GEM_MAX) {
                    return res.status(400).json({
                        success: false,
                        error: `Custom gems must be between ${CUSTOM_GEM_MIN} and ${CUSTOM_GEM_MAX.toLocaleString()}`
                    });
                }
                gems = amount;
                unitAmountPence = Math.round((amount * GEM_PENCE_PER_100) / 100);
                metaPackId = `custom_${amount}`;
                productName = `${amount.toLocaleString()} Gems`;
            } else {
                const pack = GEM_PACKS[packId];
                if (!pack) {
                    return res.status(400).json({ success: false, error: 'Invalid pack' });
                }
                gems = pack.gems;
                unitAmountPence = pack.pricePence;
                metaPackId = pack.id;
                productName = `${pack.gems.toLocaleString()} Gems (${pack.label})`;
            }

            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                currency: 'gbp',
                customer_email: req.user.email || undefined,
                line_items: [
                    {
                        price_data: {
                            currency: 'gbp',
                            product_data: {
                                name: productName,
                                description: 'Legacy Rust — gems'
                            },
                            unit_amount: unitAmountPence
                        },
                        quantity: 1
                    }
                ],
                metadata: {
                    type: 'gem_purchase',
                    packId: metaPackId,
                    gems: String(gems),
                    discord_id: req.user.discord_id,
                    gamertag: req.user.gamertag || ''
                },
                success_url: `${baseUrl}/api/gems/buy-return?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${baseUrl}/gems?canceled=1`
            });
            res.json({ success: true, url: session.url });
        } catch (e) {
            console.error('[Gems] buy:', e);
            res.status(500).json({ success: false, error: 'Could not start checkout' });
        }
    });

    router.get('/history', checkAuth, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 50;
            const history = await db.getGemTransactionHistory(req.user.discord_id, limit);
            res.json({ success: true, history });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return router;
}

module.exports = createGemRouter;
