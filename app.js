/**
 * Xside AI — Profile Mini App
 * Никнейм, баланс, пополнение через Telegram Stars
 */

(function () {
  'use strict';

  const Telegram = window.Telegram?.WebApp;
  if (Telegram) { Telegram.ready(); Telegram.expand(); }

  let credits = 0;

  const TOPUP_PACKS = [
    { id: '25',  stars: 25,  credits: 50,  priceRub: 49  },
    { id: '50',  stars: 50,  credits: 100, priceRub: 95  },
    { id: '100', stars: 100, credits: 210, priceRub: 179 },
    { id: '250', stars: 250, credits: 530, priceRub: 429 },
  ];

  const $ = (sel, ctx = document) => ctx.querySelector(sel);

  const API_BASE = (typeof window !== 'undefined' && (window.__APP_CONFIG__?.apiBase || document.documentElement.dataset?.apiBase)) || '';
  const isLocalFile = typeof location !== 'undefined' && (location.protocol === 'file:' || location.origin === 'null');
  const apiUrl = (path) => (API_BASE || (isLocalFile ? 'http://localhost:3001' : location.origin)).replace(/\/$/, '') + path;

  const creditsEl          = $('#credits');
  const profileNickname    = $('#profile-nickname');
  const profileCredits     = $('#profile-credits');
  const profileGenerationsHint = $('#profile-generations-hint');
  const profileBtnTopupStars  = $('#profile-btn-topup-stars');
  const topupPacksOverlay  = $('#topup-packs-overlay');
  const topupPacksList     = $('#topup-packs-list');
  const topupPacksBackdrop = $('.topup-packs-backdrop', topupPacksOverlay);
  const topupPacksClose    = $('.topup-packs-close', topupPacksOverlay);
  const langToggle         = $('#lang-toggle');

  const LANG_STORAGE_KEY = 'xside-lang';

  function getInitialLang() {
    try {
      if (typeof localStorage !== 'undefined') {
        const s = localStorage.getItem(LANG_STORAGE_KEY);
        if (s === 'ru' || s === 'en') return s;
      }
    } catch { /* ignore */ }
    return String(Telegram?.initDataUnsafe?.user?.language_code || navigator.language || 'ru').toLowerCase().startsWith('en') ? 'en' : 'ru';
  }

  let currentLang = getInitialLang();

  function getUserId() {
    return Telegram?.initDataUnsafe?.user?.id;
  }

  function getNickname() {
    const user = Telegram?.initDataUnsafe?.user;
    const fallback = currentLang === 'en' ? 'User' : 'Пользователь';
    if (!user) return fallback;
    if (user.username) return '@' + user.username;
    if (user.first_name) return user.first_name;
    return fallback;
  }

  function renderProfile() {
    if (profileNickname) profileNickname.textContent = getNickname();
    if (profileCredits) profileCredits.textContent = String(credits);
    if (creditsEl) creditsEl.textContent = String(credits);
    const basicGens = Math.floor(credits / 10);
    if (profileGenerationsHint) {
      profileGenerationsHint.textContent = currentLang === 'en'
        ? '(≈ ' + basicGens + ' generations)'
        : '(≈ ' + basicGens + ' генераций)';
    }
  }

  async function loadCreditsFromApi() {
    const userId = getUserId();
    if (userId == null) return;
    try {
      const r = await fetch(apiUrl('/api/credits?userId=' + encodeURIComponent(String(userId))));
      if (!r.ok) return;
      const data = await r.json();
      if (typeof data.credits === 'number') {
        credits = Math.max(0, data.credits);
        renderProfile();
      }
    } catch { /* ignore */ }
  }

  function renderTopupButtons(container) {
    if (!container || !TOPUP_PACKS.length) return;
    container.innerHTML = TOPUP_PACKS.map((p) => {
      const base = p.stars === 25 ? 50 : p.stars === 50 ? 100 : p.stars === 100 ? 200 : 500;
      const bonus = p.credits > base ? p.credits - base : 0;
      const eco = bonus && base ? Math.round((bonus / base) * 100) : 0;
      return '<button type="button" class="topup-pack-btn neumorph-btn gradient-premium" data-pack-id="' + p.id + '">' +
        (eco ? '<span class="topup-pack-badge">Экономия ' + eco + '%</span>' : '') +
        '<span class="topup-pack-main"><span class="topup-pack-stars"><img src="icons/star.svg" alt="" class="icon icon-btn-sm"> ' + p.stars + ' Stars</span> <span class="topup-pack-coins">(' + base + ' монет' + (bonus ? ' <span class="topup-pack-bonus">+' + bonus + ' бонус</span>' : '') + ')</span></span>' +
        '<span class="topup-pack-rub">≈ ' + p.priceRub + ' руб</span></button>';
    }).join('');
    container.querySelectorAll('.topup-pack-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = getUserId();
        if (uid == null) {
          if (Telegram?.showPopup) Telegram.showPopup({ title: 'Ошибка', message: 'Войдите в аккаунт Telegram' });
          return;
        }
        buyPack(uid, btn.dataset.packId);
      });
    });
  }

  function openTopupPacksModal() {
    if (getUserId() == null) {
      if (Telegram?.showPopup) Telegram.showPopup({ title: 'Ошибка', message: 'Войдите в аккаунт Telegram' });
      return;
    }
    renderTopupButtons(topupPacksList);
    if (topupPacksOverlay) {
      topupPacksOverlay.classList.remove('hidden');
      topupPacksOverlay.setAttribute('aria-hidden', 'false');
    }
  }

  function closeTopupPacksModal() {
    if (topupPacksOverlay) {
      topupPacksOverlay.classList.add('hidden');
      topupPacksOverlay.setAttribute('aria-hidden', 'true');
    }
  }

  async function buyPack(userId, packId) {
    try {
      const r = await fetch(apiUrl('/api/invoice-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: String(userId), pack: String(packId) }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (Telegram?.showPopup) Telegram.showPopup({ title: 'Ошибка', message: err.error || 'Не удалось создать счёт' });
        return;
      }
      const { invoiceUrl } = await r.json();
      closeTopupPacksModal();
      if (invoiceUrl && Telegram?.openInvoice) {
        Telegram.openInvoice(invoiceUrl, (status) => {
          if (status === 'paid') loadCreditsFromApi();
        });
      } else if (invoiceUrl && Telegram?.openLink) {
        Telegram.openLink(invoiceUrl);
      }
    } catch {
      if (Telegram?.showPopup) Telegram.showPopup({ title: 'Ошибка', message: 'Нет связи с сервером' });
    }
  }

  if (profileBtnTopupStars) profileBtnTopupStars.addEventListener('click', openTopupPacksModal);
  if (topupPacksBackdrop)   topupPacksBackdrop.addEventListener('click', closeTopupPacksModal);
  if (topupPacksClose)      topupPacksClose.addEventListener('click', closeTopupPacksModal);

  [$('#profile-btn-test-2'), $('#profile-btn-test-3')].forEach((btn, i) => {
    if (btn) btn.addEventListener('click', () => {
      if (Telegram?.showPopup) Telegram.showPopup({ title: 'Скоро', message: 'Этот способ пополнения скоро будет доступен' });
    });
  });

  function applyLanguage() {
    const isEn = currentLang === 'en';
    if (document.documentElement) document.documentElement.lang = isEn ? 'en' : 'ru';
    if (langToggle) { langToggle.textContent = isEn ? 'EN' : 'RU'; langToggle.setAttribute('aria-label', isEn ? 'Language' : 'Язык'); }

    const balanceTitle = document.querySelector('.balance-title');
    if (balanceTitle) balanceTitle.textContent = isEn ? 'Current balance:' : 'Актуальный баланс:';

    const basicGens = Math.floor(credits / 10);
    if (profileGenerationsHint) {
      profileGenerationsHint.textContent = isEn ? '(≈ ' + basicGens + ' generations)' : '(≈ ' + basicGens + ' генераций)';
    }

    const btnTokens = $('#profile-btn-test-2');
    if (btnTokens) btnTokens.innerHTML = '<img src="icons/card.svg" alt="" class="icon icon-btn-sm"> ' + (isEn ? 'Buy tokens' : 'Купить токены');

    const btnStars = $('#profile-btn-topup-stars');
    if (btnStars) btnStars.innerHTML = '<img src="icons/star.svg" alt="" class="icon icon-btn-sm"> ' + (isEn ? 'Top up with Stars' : 'Пополнение через Stars');

    const btnCrypto = $('#profile-btn-test-3');
    if (btnCrypto) btnCrypto.innerHTML = '<img src="icons/bitcoin-circle.svg" alt="" class="icon icon-btn-sm"> ' + (isEn ? 'Top up with crypto' : 'Пополнение через криптовалюту');

    const packsTitle = document.querySelector('.topup-packs-title');
    if (packsTitle) packsTitle.textContent = isEn ? 'Buy coins' : 'Купить монеты';

    if (profileNickname && (profileNickname.textContent === 'Пользователь' || profileNickname.textContent === 'User')) {
      profileNickname.textContent = getNickname();
    }

    const navProfile = document.querySelector('.bottom-nav .nav-item[data-screen="profile"] .nav-label');
    if (navProfile) navProfile.textContent = isEn ? 'Profile' : 'Профиль';
    const navReferral = document.querySelector('.bottom-nav .nav-item[data-screen="referral"] .nav-label');
    if (navReferral) navReferral.textContent = isEn ? 'Referrals' : 'Рефералы';

    const soonTitle = document.querySelector('.referral-soon-title');
    if (soonTitle) soonTitle.textContent = isEn ? 'Referral Program' : 'Реферальная программа';
    const soonText = document.querySelector('.referral-soon-text');
    if (soonText) soonText.textContent = isEn ? 'Coming soon' : 'Скоро появится';
    const soonDesc = document.querySelector('.referral-soon-desc');
    if (soonDesc) soonDesc.textContent = isEn
      ? 'Invite friends and earn bonus tokens for every new user.'
      : 'Приглашайте друзей и получайте бонусные токены за каждого нового пользователя.';
  }

  function setLanguage(lang) {
    if (lang !== 'ru' && lang !== 'en') return;
    currentLang = lang;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
    applyLanguage();
  }

  if (langToggle) langToggle.addEventListener('click', () => setLanguage(currentLang === 'en' ? 'ru' : 'en'));

  // ——— Navigation ———
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === name));
    const screen = document.getElementById('screen-' + name);
    if (screen) screen.classList.add('active');
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  // Init
  renderProfile();
  loadCreditsFromApi();
  applyLanguage();
})();
