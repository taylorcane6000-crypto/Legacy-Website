(function () {
    const path = window.location.pathname;
    const links = [
        { href: "/", label: "Home", icon: "fa-home" },
        { href: "/kits.html", label: "Kits", icon: "fa-box-open" },
        { href: "/leaderboard.html", label: "Board", icon: "fa-trophy" },
        { href: "/gems", label: "Gems", icon: "fa-gem" },
        { href: "/gamble", label: "Casino", icon: "fa-dice" },
        { href: "/profile.html", label: "Profile", icon: "fa-user" }
    ];

    function active(href) {
        if (href === "/") return path === "/";
        if (href === "/gems") return path === "/gems" || path === "/gems.html";
        if (href === "/gamble") return path === "/gamble" || path === "/gamble.html";
        return path === href;
    }

    const navItems = links
        .map(function (l) {
            const color = active(l.href) ? "#a855f7" : "#d1d5db";
            return (
                '<a href="' +
                l.href +
                '" class="legacy-nav-link" style="color:' +
                color +
                '"><i class="fas ' +
                l.icon +
                '"></i><span>' +
                l.label +
                "</span></a>"
            );
        })
        .join("");

    const html =
        '<header class="legacy-site-header">' +
        '<div class="legacy-header-inner">' +
        '<a href="/" class="legacy-brand">LEGACY RUST</a>' +
        '<nav id="legacy-nav-menu" class="legacy-nav-menu" aria-label="Main navigation">' +
        navItems +
        "</nav>" +
        '<div class="legacy-header-tools">' +
        '<div id="legacy-nav-auth-slot" class="legacy-nav-auth-slot"></div>' +
        '<button type="button" class="legacy-nav-toggle" aria-expanded="false" aria-controls="legacy-nav-menu" aria-label="Open menu">' +
        '<i class="fas fa-bars" aria-hidden="true"></i>' +
        "</button>" +
        "</div>" +
        "</div>" +
        "</header>";

    document.body.insertAdjacentHTML("afterbegin", html);

    function wireMenu() {
        var header = document.querySelector(".legacy-site-header");
        var toggle = document.querySelector(".legacy-nav-toggle");
        var menu = document.getElementById("legacy-nav-menu");
        if (!header || !toggle || !menu) return;

        function setOpen(open) {
            header.classList.toggle("legacy-nav-open", open);
            toggle.setAttribute("aria-expanded", open ? "true" : "false");
            toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
            toggle.innerHTML = open
                ? '<i class="fas fa-times" aria-hidden="true"></i>'
                : '<i class="fas fa-bars" aria-hidden="true"></i>';
        }

        toggle.addEventListener("click", function () {
            setOpen(!header.classList.contains("legacy-nav-open"));
        });

        menu.querySelectorAll("a").forEach(function (a) {
            a.addEventListener("click", function () {
                setOpen(false);
            });
        });

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") setOpen(false);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", wireMenu);
    } else {
        wireMenu();
    }

    function renderAuthSlot(loggedIn, user) {
        const slot = document.getElementById("legacy-nav-auth-slot");
        if (!slot) return;
        if (loggedIn && user) {
            const label = (user.username || user.gamertag || "Player").toString();
            const short = label.length > 14 ? label.slice(0, 12) + "…" : label;
            slot.innerHTML =
                '<span class="legacy-nav-user" title="' +
                label.replace(/"/g, "&quot;") +
                '">' +
                short.replace(/</g, "&lt;") +
                "</span>" +
                '<a href="/logout" class="legacy-nav-logout">Logout</a>';
        } else {
            slot.innerHTML = '<a href="/auth/discord" class="legacy-nav-login">Login</a>';
        }
    }

    function refreshAuth() {
        fetch("/api/user", { credentials: "same-origin" })
            .then(function (r) {
                return r.json();
            })
            .then(function (data) {
                renderAuthSlot(!!data.loggedIn, data.user);
            })
            .catch(function () {
                renderAuthSlot(false, null);
            });
    }

    function showAuthQueryBanner() {
        try {
            var p = new URLSearchParams(window.location.search);
            var msg = null;
            if (p.get("oauth_not_configured") === "1") {
                msg =
                    "Discord login is not configured on this server. Add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to the host environment (Railway Variables, panel env, etc.). Set CALLBACK_URL to your site + /auth/discord/callback and add the same URL in the Discord app under OAuth2 → Redirects.";
            } else if (p.get("login_error") === "1") {
                msg =
                    "Login failed. If you run this site: make sure CALLBACK_URL matches Discord OAuth2 redirects exactly, DOMAIN uses https, and the server clock is correct.";
            } else if (p.get("login_failed") === "1") {
                msg = "Discord sign-in was cancelled or denied. Try again and approve the prompt.";
            }
            if (!msg) return;

            var bar = document.createElement("div");
            bar.setAttribute("role", "alert");
            bar.className = "legacy-auth-banner";
            bar.style.cssText =
                "position:relative;z-index:10001;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;background:#2e1068;border-bottom:1px solid #a855f7;color:#f5f3ff;padding:14px 16px;text-align:center;font-size:13px;line-height:1.45;font-family:system-ui,-apple-system,sans-serif;";
            var span = document.createElement("span");
            span.style.maxWidth = "56rem";
            span.textContent = msg;
            bar.appendChild(span);
            var btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = "Dismiss";
            btn.style.cssText =
                "flex-shrink:0;padding:6px 12px;background:#1e1033;border:1px solid #c4b5fd;color:#ede9fe;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;";
            btn.onclick = function () {
                bar.remove();
                var u = new URL(window.location.href);
                ["oauth_not_configured", "login_error", "login_failed"].forEach(function (k) {
                    u.searchParams.delete(k);
                });
                window.history.replaceState({}, "", u.pathname + u.search + u.hash);
            };
            bar.appendChild(btn);

            var hdr = document.querySelector(".legacy-site-header");
            if (hdr && hdr.parentNode) {
                hdr.parentNode.insertBefore(bar, hdr.nextSibling);
            } else {
                document.body.insertBefore(bar, document.body.firstChild);
            }
        } catch (e) {
            /* ignore */
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            refreshAuth();
            showAuthQueryBanner();
        });
    } else {
        refreshAuth();
        showAuthQueryBanner();
    }

    window.LegacyNav = window.LegacyNav || {};
    window.LegacyNav.refreshAuth = refreshAuth;
})();
