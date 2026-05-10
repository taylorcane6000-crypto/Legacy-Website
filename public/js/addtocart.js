



const Cart = {

    storageKey: 'legacy_rust_servers_cart',

    promoStorageKey: 'legacy_rust_servers_cart_promo',

    MIN_CARD_PENCE: 30,



    items: JSON.parse(localStorage.getItem('legacy_rust_servers_cart')) || [],

    promoCode: (function () {

        try {

            return localStorage.getItem('legacy_rust_servers_cart_promo') || '';

        } catch (e) {

            return '';

        }

    })(),



    balancePence: null,

    creditApplyPence: 0,



    gbpToPence(v) {

        const n = parseFloat(String(v).replace(/,/g, ''));

        if (Number.isNaN(n) || n < 0) return 0;

        return Math.round(n * 100);

    },



    penceToGbp(p) {

        return (Math.max(0, p) / 100).toFixed(2);

    },



    syncCreditInputFromState() {

        const input = document.getElementById('cart-credit-apply-input');

        if (input) input.value = this.creditApplyPence > 0 ? this.penceToGbp(this.creditApplyPence) : '';

    },



    readCreditFromInput() {

        const input = document.getElementById('cart-credit-apply-input');

        if (!input) return;

        this.creditApplyPence = this.gbpToPence(input.value || '0');

    },



    applyMaxCredit() {

        const subtotal = this.items.reduce((s, item) => s + item.price * item.qty, 0);

        const bal = this.balancePence != null ? this.balancePence : 0;

        this.creditApplyPence = Math.min(bal, subtotal);

        this.syncCreditInputFromState();

        this._paintTotals(subtotal);

    },



    add: async function (productId, name, price, image) {

        try {

            const res = await fetch('/api/user', { credentials: 'same-origin' });

            const authData = await res.json();



            if (!authData.loggedIn) {

                if (confirm('ACCESS DENIED: Neural Link Required.\n\nYou must login with Discord to purchase items.')) {

                    window.location.href = '/auth/discord';

                }

                return;

            }

        } catch (e) {

            console.error(e);

            return;

        }



        const existingItem = this.items.find((item) => item.id === productId);



        if (existingItem) {

            existingItem.qty += 1;

        } else {

            this.items.push({

                id: productId,

                name: name,

                price: price,

                image: image,

                qty: 1

            });

        }



        this.save();

        this.updateUI();

        this.open();



        if (event && event.target) {

            event.target.closest('button');

        }

    },



    remove: function (productId) {

        this.items = this.items.filter((item) => item.id !== productId);

        this.save();

        this.updateUI();

    },



    changeQty: function (productId, change) {

        const item = this.items.find((item) => item.id === productId);

        if (!item) return;



        item.qty += change;



        if (item.qty <= 0) {

            this.remove(productId);

        } else {

            this.save();

            this.updateUI();

        }

    },



    save: function () {

        localStorage.setItem(this.storageKey, JSON.stringify(this.items));

        this.updateBadge();

    },



    _paintTotals: function (subtotal) {

        const cartSubtotalEl = document.getElementById('cart-subtotal');

        const cartTotal = document.getElementById('cart-total');

        const balEl = document.getElementById('cart-credit-balance');

        const breakdownEl = document.getElementById('cart-credit-breakdown');

        const warnEl = document.getElementById('cart-credit-warning');

        const creditLine = document.getElementById('cart-credit-line');

        const creditAppliedDisplay = document.getElementById('cart-credit-applied-display');



        const bal = this.balancePence != null ? Math.max(0, this.balancePence) : 0;

        if (balEl) balEl.textContent = '£' + this.penceToGbp(bal);



        let applied = Math.min(this.creditApplyPence, bal, subtotal);

        let due = subtotal - applied;



        if (warnEl) warnEl.classList.add('hidden');

        if (due > 0 && due < this.MIN_CARD_PENCE) {

            const extra = due;

            if (applied + extra <= subtotal && bal >= applied + extra) {

                applied += extra;

                due = 0;

                if (breakdownEl) {

                    breakdownEl.textContent =

                        'Small card amounts are not available — full total covered with store credit.';

                }

            } else {

                if (warnEl) {

                    warnEl.textContent =

                        'Use enough store credit to pay the full total, or leave at least £0.30 to pay by card.';

                    warnEl.classList.remove('hidden');

                }

            }

        } else if (breakdownEl) {

            if (applied > 0) {

                breakdownEl.textContent =

                    'Applying £' + this.penceToGbp(applied) + ' from balance · Card charge £' + this.penceToGbp(due);

            } else {

                breakdownEl.textContent = bal > 0 ? 'Enter an amount to apply, or use Use max.' : '';

            }

        }



        if (cartSubtotalEl) cartSubtotalEl.textContent = '£' + this.penceToGbp(subtotal);

        if (creditLine && creditAppliedDisplay) {

            if (applied > 0) {

                creditLine.classList.remove('hidden');

                creditAppliedDisplay.textContent = '−£' + this.penceToGbp(applied);

            } else {

                creditLine.classList.add('hidden');

            }

        }

        if (cartTotal) cartTotal.textContent = '£' + this.penceToGbp(due);

    },



    refreshCreditDisplay: function () {

        const subtotal = this.items.reduce((sum, item) => sum + item.price * item.qty, 0);

        fetch('/api/store-credit', { credentials: 'same-origin' })

            .then((r) => (r.ok ? r.json() : { balance_pence: 0 }))

            .then((data) => {

                this.balancePence = data.balance_pence || 0;

                this._paintTotals(subtotal);

            })

            .catch(() => {

                this.balancePence = 0;

                this._paintTotals(subtotal);

            });

    },



    updateUI: function () {

        const cartContainer = document.getElementById('cart-items-container');



        if (!cartContainer) return;



        cartContainer.innerHTML = '';

        let total = 0;



        if (this.items.length === 0) {

            cartContainer.innerHTML =

                '<div class="text-gray-500 text-center font-mono text-sm py-10 opacity-50">/// NO ASSETS DETECTED ///</div>';

        } else {

            this.items.forEach((item) => {

                total += item.price * item.qty;

                const priceDisplay = (item.price / 100).toFixed(2);



                cartContainer.innerHTML += `

                    <div class="flex items-center gap-3 bg-white/5 border border-white/10 p-3 relative group">

                        <div class="w-16 h-16 bg-black flex-shrink-0 border border-white/5 overflow-hidden">

                            <img src="${item.image}" class="w-full h-full object-cover opacity-80">

                        </div>

                        <div class="flex-1">

                            <h4 class="font-display font-bold text-lg leading-none uppercase text-white">${item.name}</h4>

                            <div class="text-neon text-sm font-bold">£${priceDisplay}</div>

                        </div>

                        <div class="flex flex-col items-end gap-1">

                            <div class="flex items-center bg-black border border-white/10">

                                <button onclick="Cart.changeQty('${item.id}', -1)" class="w-6 h-6 hover:bg-white hover:text-black transition-colors">-</button>

                                <span class="w-8 text-center text-xs font-mono">${item.qty}</span>

                                <button onclick="Cart.changeQty('${item.id}', 1)" class="w-6 h-6 hover:bg-white hover:text-black transition-colors">+</button>

                            </div>

                        </div>

                        <button onclick="Cart.remove('${item.id}')" class="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">

                            <i class="fa-solid fa-xmark"></i>

                        </button>

                    </div>

                `;

            });

        }



        this.syncPromoField();

        this.updateBadge();

        this.refreshCreditDisplay();

    },



    syncPromoField: function () {

        const input = document.getElementById('cart-promo-input');

        const fb = document.getElementById('cart-promo-feedback');

        if (input) input.value = this.promoCode || '';

        if (fb) {

            if (this.promoCode) {

                fb.textContent = 'Applied — discount confirmed at checkout';

                fb.classList.remove('hidden', 'text-red-400', 'text-gray-500');

                fb.classList.add('text-emerald-400/90');

            } else {

                fb.classList.add('hidden');

                fb.textContent = '';

            }

        }

    },



    setPromoFromInput: function () {

        const input = document.getElementById('cart-promo-input');

        const raw = input ? input.value.trim() : '';

        this.promoCode = raw;

        try {

            if (raw) localStorage.setItem(this.promoStorageKey, raw);

            else localStorage.removeItem(this.promoStorageKey);

        } catch (e) {

            /* ignore */

        }

        this.syncPromoField();

    },



    clearPromo: function () {

        this.promoCode = '';

        try {

            localStorage.removeItem(this.promoStorageKey);

        } catch (e) {

            /* ignore */

        }

        this.syncPromoField();

    },



    updateBadge: function () {

        const badge = document.getElementById('cart-badge');

        if (badge) {

            const count = this.items.reduce((sum, item) => sum + item.qty, 0);

            badge.innerText = count;

            badge.classList.toggle('hidden', count === 0);

        }

    },



    open: function () {

        document.getElementById('cart-drawer').classList.remove('translate-x-full');

        document.getElementById('cart-overlay').classList.remove('hidden');

        this.readCreditFromInput();

        this.refreshCreditDisplay();

    },



    close: function () {

        document.getElementById('cart-drawer').classList.add('translate-x-full');

        document.getElementById('cart-overlay').classList.add('hidden');

    },



    checkout: async function () {

        const checkoutBtn = document.getElementById('checkout-btn');

        if (this.items.length === 0) return alert('Cart is empty!');



        this.readCreditFromInput();

        const subtotal = this.items.reduce((itemSum, item) => itemSum + item.price * item.qty, 0);

        const bal = this.balancePence != null ? this.balancePence : 0;

        let applied = Math.min(this.creditApplyPence, bal, subtotal);

        let due = subtotal - applied;

        if (due > 0 && due < this.MIN_CARD_PENCE) {

            const extra = due;

            if (applied + extra <= subtotal && bal >= applied + extra) {

                applied += extra;

            } else {

                return alert(

                    'Use enough store credit to cover the full total, or leave at least £0.30 to pay by card.'

                );

            }

        }



        const originalText = checkoutBtn.innerHTML;

        checkoutBtn.innerHTML = '<span class="block unskew"><i class="fa-solid fa-spinner fa-spin"></i> INIT...</span>';

        checkoutBtn.disabled = true;



        try {

            const cartPayload = this.items.map((item) => ({

                id: item.id,

                qty: item.qty

            }));



            const response = await fetch('/create-checkout-session', {

                method: 'POST',

                credentials: 'same-origin',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({

                    cartItems: cartPayload,

                    promotionCode: this.promoCode ? this.promoCode.trim() : '',

                    storeCreditPence: applied

                })

            });



            const data = await response.json();



            if (data.url) {

                if (data.url.indexOf('after_sales') !== -1) {

                    this.items = [];

                    this.save();

                }

                window.location.href = data.url;

            } else {

                alert('Error: ' + (data.error || 'Server Error'));

                checkoutBtn.innerHTML = originalText;

                checkoutBtn.disabled = false;

            }

        } catch (error) {

            console.error(error);

            alert('Connection failed.');

            checkoutBtn.innerHTML = originalText;

            checkoutBtn.disabled = false;

        }

    }

};



document.addEventListener('DOMContentLoaded', () => {

    const applyBtn = document.getElementById('cart-promo-apply');

    const promoInput = document.getElementById('cart-promo-input');

    const creditInput = document.getElementById('cart-credit-apply-input');

    const creditMaxBtn = document.getElementById('cart-credit-max-btn');



    if (applyBtn) {

        applyBtn.addEventListener('click', () => Cart.setPromoFromInput());

    }

    if (promoInput) {

        promoInput.addEventListener('keydown', (e) => {

            if (e.key === 'Enter') {

                e.preventDefault();

                Cart.setPromoFromInput();

            }

        });

    }

    if (creditInput) {

        creditInput.addEventListener('change', () => {

            Cart.readCreditFromInput();

            const subtotal = Cart.items.reduce((s, i) => s + i.price * i.qty, 0);

            Cart._paintTotals(subtotal);

        });

        creditInput.addEventListener('input', () => {

            Cart.readCreditFromInput();

            const subtotal = Cart.items.reduce((s, i) => s + i.price * i.qty, 0);

            Cart._paintTotals(subtotal);

        });

    }

    if (creditMaxBtn) {

        creditMaxBtn.addEventListener('click', () => Cart.applyMaxCredit());

    }



    Cart.updateUI();

});

