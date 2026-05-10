// Gem casino API — Blackjack, Roulette, Plinko (session auth, single gem balance).
const express = require('express');
const crypto = require('crypto');

const activeBlackjackGames = new Map();
const activeBlackjackPlayers = new Map();
const activeRoulettePlayers = new Map();
const activePlinkoPlayers = new Map();

let rouletteState = {
    phase: 'betting',
    spinEndTime: null,
    lastResult: null,
    bettingEndsAt: null
};
let rouletteInterval = null;

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const value of VALUES) {
            deck.push({ suit, value });
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getCardValue(card) {
    if (['J', 'Q', 'K'].includes(card.value)) return 10;
    if (card.value === 'A') return 11;
    return parseInt(card.value, 10);
}

function calculateHandValue(hand) {
    let value = 0;
    let aces = 0;
    for (const card of hand) {
        value += getCardValue(card);
        if (card.value === 'A') aces++;
    }
    while (value > 21 && aces > 0) {
        value -= 10;
        aces--;
    }
    return value;
}

function ref(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function readGemBalance(db, discordId) {
    const row = await db.getUser(discordId);
    return row && row.gems != null ? Math.max(0, Number(row.gems)) : 0;
}

function startRouletteLoop(processRouletteBetsAsync) {
    if (rouletteInterval) return;
    const BETTING_DURATION = 25000;
    const SPINNING_DURATION = 10000;

    function runCycle() {
        rouletteState.phase = 'betting';
        rouletteState.bettingEndsAt = Date.now() + BETTING_DURATION;
        rouletteState.spinEndTime = null;

        setTimeout(() => {
            rouletteState.phase = 'spinning';
            rouletteState.spinEndTime = Date.now() + SPINNING_DURATION;
            const result = Math.floor(Math.random() * 38);

            setTimeout(() => {
                rouletteState.lastResult = result;
                Promise.resolve(processRouletteBetsAsync(result))
                    .catch((e) => console.error('[Gamble] Roulette payout:', e.message))
                    .finally(() => {
                        activeRoulettePlayers.clear();
                        runCycle();
                    });
            }, SPINNING_DURATION);
        }, BETTING_DURATION);
    }

    runCycle();
    rouletteInterval = true;
    console.log('[Gamble] Roulette loop started');
}

const PLINKO_MULTIPLIERS_TABLE = {
    8: {
        low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
        medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
        high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
    },
    9: {
        low: [5.6, 2, 1.6, 1, 0.7, 0.7, 1, 1.6, 2, 5.6],
        medium: [18, 4, 1.7, 0.9, 0.5, 0.5, 0.9, 1.7, 4, 18],
        high: [43, 7, 2, 0.6, 0.2, 0.2, 0.6, 2, 7, 43]
    },
    10: {
        low: [8.9, 3, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 3, 8.9],
        medium: [22, 5, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 5, 22],
        high: [76, 10, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 10, 76]
    },
    11: {
        low: [8.4, 3, 1.9, 1.3, 1, 0.7, 0.7, 1, 1.3, 1.9, 3, 8.4],
        medium: [24, 6, 3, 1.8, 0.7, 0.5, 0.5, 0.7, 1.8, 3, 6, 24],
        high: [120, 14, 5.2, 1.4, 0.4, 0.2, 0.2, 0.4, 1.4, 5.2, 14, 120]
    },
    12: {
        low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
        medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
        high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170]
    },
    13: {
        low: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7, 0.7, 0.9, 1.2, 1.9, 3, 4, 8.1],
        medium: [43, 13, 6, 3, 1.3, 0.7, 0.4, 0.4, 0.7, 1.3, 3, 6, 13, 43],
        high: [284, 37, 11, 4, 1, 0.2, 0.2, 0.2, 0.2, 1, 4, 11, 37, 284]
    },
    14: {
        low: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5, 1, 1.1, 1.3, 1.4, 1.9, 4, 7.1],
        medium: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2, 0.5, 1, 1.9, 4, 7, 15, 58],
        high: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 5, 18, 56, 420]
    },
    15: {
        low: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7, 0.7, 1, 1.1, 1.5, 2, 3, 8, 15],
        medium: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3, 0.3, 0.5, 1.3, 3, 5, 11, 18, 88],
        high: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2, 0.2, 0.2, 0.5, 3, 8, 27, 83, 620]
    },
    16: {
        low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
        medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
        high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
    }
};

function computePlinkoPath(serverSeed, clientSeed, nonce, rows) {
    const path = [];
    let position = 0;
    for (let i = 0; i < rows; i++) {
        const hmac = crypto.createHmac('sha256', serverSeed);
        hmac.update(`${clientSeed}:${nonce}:${i}`);
        const hex = hmac.digest('hex');
        const value = parseInt(hex.substring(0, 8), 16) / 0x100000000;
        if (value < 0.5) {
            path.push('L');
        } else {
            path.push('R');
            position++;
        }
    }
    return { path, position };
}

function simulatePlinkoDropEnhanced(rows, risk, clientSeed) {
    rows = Math.max(8, Math.min(16, rows || 16));
    risk = ['low', 'medium', 'high'].includes(risk) ? risk : 'medium';
    clientSeed = clientSeed || 'default';
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const nonce = Date.now();
    const { path, position } = computePlinkoPath(serverSeed, clientSeed, nonce, rows);
    const multipliers = PLINKO_MULTIPLIERS_TABLE[rows][risk];
    const multiplier = multipliers[position];
    return {
        position,
        multiplier,
        path,
        rows,
        risk,
        multipliers,
        serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
        serverSeed,
        clientSeed,
        nonce
    };
}

function createGambleRouter({ db, checkAuth }) {
    const router = express.Router();

    async function processRouletteBets(result) {
        const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
        const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];

        for (const [odiscordId, playerBet] of activeRoulettePlayers) {
            let winAmount = 0;
            const isZero = result === 0 || result === 37;

            if (playerBet.betType === 'number' && playerBet.betValue === result) {
                winAmount = playerBet.bet * 36;
            } else if (playerBet.betType === 'red' && !isZero && RED_NUMBERS.includes(result)) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'black' && !isZero && BLACK_NUMBERS.includes(result)) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'odd' && !isZero && result % 2 === 1) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'even' && !isZero && result % 2 === 0 && result !== 0) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'low' && !isZero && result >= 1 && result <= 18) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'high' && !isZero && result >= 19 && result <= 36) {
                winAmount = playerBet.bet * 2;
            } else if (playerBet.betType === 'dozen1' && result >= 1 && result <= 12) {
                winAmount = playerBet.bet * 3;
            } else if (playerBet.betType === 'dozen2' && result >= 13 && result <= 24) {
                winAmount = playerBet.bet * 3;
            } else if (playerBet.betType === 'dozen3' && result >= 25 && result <= 36) {
                winAmount = playerBet.bet * 3;
            }

            if (winAmount > 0) {
                try {
                    await db.addGems(
                        odiscordId,
                        winAmount,
                        'gamble_win',
                        `Roulette win: ${playerBet.betType} (${result})`,
                        ref('roul_win')
                    );
                } catch (e) {
                    console.error('[Gamble] Roulette payout error:', e.message);
                }
            }
        }
    }

    startRouletteLoop(processRouletteBets);

    setInterval(() => {
        const now = Date.now();
        const STALE_TIMEOUT = 5 * 60 * 1000;
        for (const [odiscordId, game] of activeBlackjackGames.entries()) {
            if (now - game.startTime > STALE_TIMEOUT) {
                db.addGems(odiscordId, game.bet, 'gamble_refund', 'Blackjack: abandoned game refund', ref('bj_refund')).catch(
                    (e) => console.error('[Gamble] Stale BJ refund:', e.message)
                );
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                console.log(`[Gamble] Stale blackjack cleared: ${odiscordId}`);
            }
        }
    }, 60000);

    router.get('/active-players', checkAuth, (req, res) => {
        const blackjackPlayers = Array.from(activeBlackjackPlayers.values()).map((p) => ({
            gamertag: p.gamertag,
            bet: p.bet
        }));
        const roulettePlayers = Array.from(activeRoulettePlayers.values()).map((p) => ({
            gamertag: p.gamertag,
            bet: p.bet,
            betType: p.betType
        }));
        const plinkoPlayers = Array.from(activePlinkoPlayers.values()).map((p) => ({
            gamertag: p.gamertag,
            bet: p.bet
        }));
        res.json({
            success: true,
            blackjack: { players: blackjackPlayers, currentCount: blackjackPlayers.length },
            roulette: {
                players: roulettePlayers,
                phase: rouletteState.phase,
                bettingEndsAt: rouletteState.bettingEndsAt,
                spinEndTime: rouletteState.spinEndTime,
                lastResult: rouletteState.lastResult
            },
            plinko: { players: plinkoPlayers }
        });
    });

    router.post('/blackjack/start', checkAuth, async (req, res) => {
        try {
            const { bet } = req.body || {};
            const odiscordId = req.user.discord_id;
            const gamertag = req.user.gamertag || '';

            const b = parseInt(bet, 10);
            if (!b || b < 10) {
                return res.json({ success: false, error: 'Minimum bet is 10 gems' });
            }
            if (b > 1000) {
                return res.json({ success: false, error: 'Maximum bet is 1000 gems' });
            }

            if (activeBlackjackGames.has(odiscordId)) {
                const existing = activeBlackjackGames.get(odiscordId);
                if (Date.now() - existing.startTime > 2 * 60 * 1000) {
                    await db.addGems(
                        odiscordId,
                        existing.bet,
                        'gamble_refund',
                        'Blackjack: stale game refund',
                        ref('bj_refund')
                    );
                    activeBlackjackGames.delete(odiscordId);
                    activeBlackjackPlayers.delete(odiscordId);
                } else {
                    return res.json({ success: false, error: 'You already have an active game' });
                }
            }

            const balance = await readGemBalance(db, odiscordId);
            if (balance < b) {
                return res.json({ success: false, error: 'Insufficient gems' });
            }

            const spend = await db.spendGems(odiscordId, b, 'gamble_bet', 'Blackjack bet', ref('bj_bet'));
            if (!spend.success) {
                return res.json({ success: false, error: spend.error || 'Could not place bet' });
            }

            const deck = shuffleDeck(createDeck());
            const playerHand = [deck.pop(), deck.pop()];
            const dealerHand = [deck.pop(), deck.pop()];

            const gameState = {
                deck,
                playerHand,
                dealerHand,
                bet: b,
                status: 'playing',
                startTime: Date.now()
            };

            activeBlackjackGames.set(odiscordId, gameState);
            activeBlackjackPlayers.set(odiscordId, { gamertag, odiscordId, bet: b, startTime: Date.now() });

            const playerValue = calculateHandValue(playerHand);
            const dealerFullValue = calculateHandValue(dealerHand);
            const dealerValue = calculateHandValue([dealerHand[0]]);
            const playerBlackjack = playerValue === 21;
            const dealerBlackjack = dealerFullValue === 21;

            const newBal = await readGemBalance(db, odiscordId);

            if (playerBlackjack && dealerBlackjack) {
                gameState.status = 'push';
                await db.addGems(odiscordId, b, 'gamble_push', 'Blackjack push: both natural 21', ref('bj_push'));
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand,
                    dealerHand,
                    playerValue: 21,
                    dealerValue: dealerFullValue,
                    status: 'push',
                    message: 'Both have Blackjack! Push — bet returned.',
                    winAmount: b,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            if (playerBlackjack) {
                const winAmount = Math.floor(b * 2.5);
                await db.addGems(odiscordId, winAmount, 'gamble_win', 'Blackjack! Natural 21', ref('bj_win'));
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand,
                    dealerHand,
                    playerValue: 21,
                    dealerValue: dealerFullValue,
                    status: 'blackjack',
                    message: 'Blackjack! You win!',
                    winAmount,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            if (dealerBlackjack) {
                gameState.status = 'dealer_blackjack';
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand,
                    dealerHand,
                    playerValue,
                    dealerValue: dealerFullValue,
                    status: 'dealer_blackjack',
                    message: 'Dealer has Blackjack! You lose.',
                    winAmount: 0,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            return res.json({
                success: true,
                playerHand,
                dealerHand: [dealerHand[0], { suit: 'hidden', value: '?' }],
                playerValue,
                dealerValue,
                status: 'playing',
                canDouble: newBal >= b * 2,
                newBalance: newBal
            });
        } catch (error) {
            console.error('[Gamble] Blackjack start:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/blackjack/hit', checkAuth, async (req, res) => {
        try {
            const odiscordId = req.user.discord_id;
            const game = activeBlackjackGames.get(odiscordId);
            if (!game || game.status !== 'playing') {
                return res.json({ success: false, error: 'No active game' });
            }

            game.playerHand.push(game.deck.pop());
            const playerValue = calculateHandValue(game.playerHand);

            if (playerValue > 21) {
                game.status = 'bust';
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand: game.playerHand,
                    dealerHand: game.dealerHand,
                    playerValue,
                    dealerValue: calculateHandValue(game.dealerHand),
                    status: 'bust',
                    message: 'Bust! You lose.',
                    winAmount: 0,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            if (playerValue === 21) {
                let dealerValue = calculateHandValue(game.dealerHand);
                while (dealerValue < 17) {
                    game.dealerHand.push(game.deck.pop());
                    dealerValue = calculateHandValue(game.dealerHand);
                }
                let status;
                let message;
                let winAmount = 0;
                if (dealerValue > 21) {
                    status = 'dealer_bust';
                    message = 'Dealer busts! You win!';
                    winAmount = game.bet * 2;
                } else if (dealerValue > playerValue) {
                    status = 'lose';
                    message = 'Dealer wins.';
                } else if (dealerValue < playerValue) {
                    status = 'win';
                    message = 'You win!';
                    winAmount = game.bet * 2;
                } else {
                    status = 'push';
                    message = 'Push (tie). Your bet has been returned.';
                    winAmount = game.bet;
                }
                if (winAmount > 0) {
                    const gemType = status === 'push' ? 'gamble_push' : 'gamble_win';
                    await db.addGems(odiscordId, winAmount, gemType, `Blackjack: ${status}`, ref('bj_end'));
                }
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand: game.playerHand,
                    dealerHand: game.dealerHand,
                    playerValue,
                    dealerValue,
                    status,
                    message,
                    winAmount,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            return res.json({
                success: true,
                playerHand: game.playerHand,
                dealerHand: [game.dealerHand[0], { suit: 'hidden', value: '?' }],
                playerValue,
                status: 'playing'
            });
        } catch (error) {
            console.error('[Gamble] Blackjack hit:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    async function finishDealer(game, odiscordId) {
        let dealerValue = calculateHandValue(game.dealerHand);
        while (dealerValue < 17) {
            game.dealerHand.push(game.deck.pop());
            dealerValue = calculateHandValue(game.dealerHand);
        }
        const playerValue = calculateHandValue(game.playerHand);
        let status;
        let message;
        let winAmount = 0;
        if (dealerValue > 21) {
            status = 'dealer_bust';
            message = 'Dealer busts! You win!';
            winAmount = game.bet * 2;
        } else if (dealerValue > playerValue) {
            status = 'lose';
            message = 'Dealer wins.';
        } else if (dealerValue < playerValue) {
            status = 'win';
            message = 'You win!';
            winAmount = game.bet * 2;
        } else {
            status = 'push';
            message = 'Push (tie). Your bet has been returned.';
            winAmount = game.bet;
        }
        if (winAmount > 0) {
            const gemType = status === 'push' ? 'gamble_push' : 'gamble_win';
            await db.addGems(odiscordId, winAmount, gemType, `Blackjack: ${status}`, ref('bj_end'));
        }
        activeBlackjackGames.delete(odiscordId);
        activeBlackjackPlayers.delete(odiscordId);
        return {
            success: true,
            playerHand: game.playerHand,
            dealerHand: game.dealerHand,
            playerValue,
            dealerValue,
            status,
            message,
            winAmount,
            newBalance: await readGemBalance(db, odiscordId)
        };
    }

    router.post('/blackjack/stand', checkAuth, async (req, res) => {
        try {
            const odiscordId = req.user.discord_id;
            const game = activeBlackjackGames.get(odiscordId);
            if (!game || game.status !== 'playing') {
                return res.json({ success: false, error: 'No active game' });
            }
            const out = await finishDealer(game, odiscordId);
            res.json(out);
        } catch (error) {
            console.error('[Gamble] Blackjack stand:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/blackjack/double', checkAuth, async (req, res) => {
        try {
            const odiscordId = req.user.discord_id;
            const game = activeBlackjackGames.get(odiscordId);
            if (!game || game.status !== 'playing') {
                return res.json({ success: false, error: 'No active game' });
            }
            if (game.playerHand.length !== 2) {
                return res.json({ success: false, error: 'Can only double on first two cards' });
            }
            const balance = await readGemBalance(db, odiscordId);
            if (balance < game.bet) {
                return res.json({ success: false, error: 'Insufficient gems to double' });
            }
            const spend = await db.spendGems(odiscordId, game.bet, 'gamble_bet', 'Blackjack double', ref('bj_double'));
            if (!spend.success) {
                return res.json({ success: false, error: spend.error || 'Could not double' });
            }
            game.bet *= 2;
            const pEntry = activeBlackjackPlayers.get(odiscordId);
            if (pEntry) pEntry.bet = game.bet;

            game.playerHand.push(game.deck.pop());
            const playerValue = calculateHandValue(game.playerHand);
            if (playerValue > 21) {
                activeBlackjackGames.delete(odiscordId);
                activeBlackjackPlayers.delete(odiscordId);
                return res.json({
                    success: true,
                    playerHand: game.playerHand,
                    dealerHand: game.dealerHand,
                    playerValue,
                    dealerValue: calculateHandValue(game.dealerHand),
                    status: 'bust',
                    message: 'Bust! You lose.',
                    winAmount: 0,
                    newBalance: await readGemBalance(db, odiscordId)
                });
            }

            let dealerValue = calculateHandValue(game.dealerHand);
            while (dealerValue < 17) {
                game.dealerHand.push(game.deck.pop());
                dealerValue = calculateHandValue(game.dealerHand);
            }
            let status;
            let message;
            let winAmount = 0;
            if (dealerValue > 21) {
                status = 'dealer_bust';
                message = 'Dealer busts! You win!';
                winAmount = game.bet * 2;
            } else if (dealerValue > playerValue) {
                status = 'lose';
                message = 'Dealer wins.';
            } else if (dealerValue < playerValue) {
                status = 'win';
                message = 'You win!';
                winAmount = game.bet * 2;
            } else {
                status = 'push';
                message = 'Push (tie). Your bet has been returned.';
                winAmount = game.bet;
            }
            if (winAmount > 0) {
                const gemType = status === 'push' ? 'gamble_push' : 'gamble_win';
                await db.addGems(odiscordId, winAmount, gemType, `Blackjack double: ${status}`, ref('bj_end'));
            }
            activeBlackjackGames.delete(odiscordId);
            activeBlackjackPlayers.delete(odiscordId);
            res.json({
                success: true,
                playerHand: game.playerHand,
                dealerHand: game.dealerHand,
                playerValue,
                dealerValue,
                status,
                message,
                winAmount,
                newBalance: await readGemBalance(db, odiscordId)
            });
        } catch (error) {
            console.error('[Gamble] Blackjack double:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.get('/roulette/state', checkAuth, (req, res) => {
        const players = Array.from(activeRoulettePlayers.values()).map((p) => ({
            gamertag: p.gamertag,
            bet: p.bet,
            betType: p.betType
        }));
        res.json({
            success: true,
            phase: rouletteState.phase,
            bettingEndsAt: rouletteState.bettingEndsAt,
            spinEndTime: rouletteState.spinEndTime,
            lastResult: rouletteState.lastResult,
            players
        });
    });

    router.post('/roulette/bet', checkAuth, async (req, res) => {
        try {
            const { bet, betType, betValue } = req.body || {};
            const odiscordId = req.user.discord_id;
            const gamertag = req.user.gamertag || '';

            if (rouletteState.phase !== 'betting') {
                return res.json({ success: false, error: 'Betting is closed. Wait for next round.' });
            }
            const b = parseInt(bet, 10);
            if (!b || b < 10) {
                return res.json({ success: false, error: 'Minimum bet is 10 gems' });
            }
            if (b > 500) {
                return res.json({ success: false, error: 'Maximum bet is 500 gems' });
            }
            const validBetTypes = ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen2', 'dozen3', 'number'];
            if (!validBetTypes.includes(betType)) {
                return res.json({ success: false, error: 'Invalid bet type' });
            }
            if (betType === 'number' && (betValue < 0 || betValue > 37)) {
                return res.json({ success: false, error: 'Invalid number (0-36, or 37 for 00)' });
            }
            if (activeRoulettePlayers.has(odiscordId)) {
                return res.json({ success: false, error: 'You already placed a bet this round' });
            }
            const balance = await readGemBalance(db, odiscordId);
            if (balance < b) {
                return res.json({ success: false, error: 'Insufficient gems' });
            }
            const spend = await db.spendGems(odiscordId, b, 'gamble_bet', `Roulette bet: ${betType}`, ref('roul_bet'));
            if (!spend.success) {
                return res.json({ success: false, error: spend.error || 'Could not place bet' });
            }
            activeRoulettePlayers.set(odiscordId, {
                gamertag,
                bet: b,
                betType,
                betValue: betType === 'number' ? betValue : null
            });
            res.json({
                success: true,
                message: `Bet placed: ${b} gems on ${betType}${betType === 'number' ? ` (${betValue === 37 ? '00' : betValue})` : ''}`,
                newBalance: await readGemBalance(db, odiscordId)
            });
        } catch (error) {
            console.error('[Gamble] Roulette bet:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/plinko/drop-enhanced', checkAuth, async (req, res) => {
        try {
            const { bet, rows, risk, client_seed } = req.body || {};
            const odiscordId = req.user.discord_id;
            const gamertag = req.user.gamertag || '';
            const b = parseInt(bet, 10);
            if (!b || b < 10) {
                return res.json({ success: false, error: 'Minimum bet is 10 gems' });
            }
            if (b > 500) {
                return res.json({ success: false, error: 'Maximum bet is 500 gems' });
            }
            const validRows = Math.max(8, Math.min(16, parseInt(rows, 10) || 16));
            const validRisk = ['low', 'medium', 'high'].includes(risk) ? risk : 'medium';
            const balance = await readGemBalance(db, odiscordId);
            if (balance < b) {
                return res.json({ success: false, error: 'Insufficient gems' });
            }
            const spend = await db.spendGems(
                odiscordId,
                b,
                'gamble_bet',
                `Plinko bet (${validRisk}/${validRows}r)`,
                ref('plinko_bet')
            );
            if (!spend.success) {
                return res.json({ success: false, error: spend.error || 'Could not place bet' });
            }
            activePlinkoPlayers.set(odiscordId, { gamertag, bet: b, startTime: Date.now() });
            const result = simulatePlinkoDropEnhanced(validRows, validRisk, client_seed || 'default');
            const winAmount = Math.floor(b * result.multiplier);
            setTimeout(() => activePlinkoPlayers.delete(odiscordId), 3000);
            if (winAmount > 0) {
                await db.addGems(
                    odiscordId,
                    winAmount,
                    'gamble_win',
                    `Plinko ${validRisk}/${validRows}r: ${result.multiplier}x`,
                    ref('plinko_win')
                );
            }
            res.json({
                success: true,
                path: result.path,
                position: result.position,
                multiplier: result.multiplier,
                multipliers: result.multipliers,
                rows: result.rows,
                risk: result.risk,
                betAmount: b,
                winAmount,
                profit: winAmount - b,
                newBalance: await readGemBalance(db, odiscordId),
                fairness: {
                    serverSeedHash: result.serverSeedHash,
                    serverSeed: result.serverSeed,
                    clientSeed: result.clientSeed,
                    nonce: result.nonce
                }
            });
        } catch (error) {
            console.error('[Gamble] Plinko:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.get('/plinko/multipliers', (req, res) => {
        const rows = Math.max(8, Math.min(16, parseInt(req.query.rows, 10) || 16));
        const risk = ['low', 'medium', 'high'].includes(req.query.risk) ? req.query.risk : 'medium';
        res.json({
            success: true,
            multipliers: PLINKO_MULTIPLIERS_TABLE[rows][risk],
            rows,
            risk,
            allMultipliers: PLINKO_MULTIPLIERS_TABLE
        });
    });

    return router;
}

module.exports = { createGambleRouter };
