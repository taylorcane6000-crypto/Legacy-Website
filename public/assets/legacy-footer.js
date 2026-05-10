(function () {
    const html =
        '<footer class="legacy-site-footer">' +
        '<div class="legacy-site-footer-inner">' +
        '<div>' +
        '<div class="legacy-site-footer-title">LEGACY RUST SERVERS</div>' +
        '<div class="legacy-site-footer-tag">Community Rust Console Store</div>' +
        "</div>" +
        '<div class="legacy-site-footer-links">' +
        '<a href="https://discord.gg/legacyrust" target="_blank" rel="noopener noreferrer">Discord</a>' +
        '<span class="legacy-site-footer-sep">/</span>' +
        '<a href="/">Store</a>' +
        '<span class="legacy-site-footer-sep">/</span>' +
        '<a href="/leaderboard.html">Leaderboard</a>' +
        '<span class="legacy-site-footer-sep">/</span>' +
        '<a href="/subscriptions.html">Subscriptions</a>' +
        '<span class="legacy-site-footer-sep">/</span>' +
        '<a href="/profile.html">Profile</a>' +
        "</div>" +
        "</div>" +
        "</footer>";
    document.body.insertAdjacentHTML("beforeend", html);
})();
