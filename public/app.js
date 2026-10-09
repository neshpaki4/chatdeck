const chatContainer = document.getElementById('chat-container');
const MAX_MESSAGES = 50;
const _ovParams = new URLSearchParams(location.search);

// 1.4: стиль — сервер как база, URL-параметры как переопределение (для старых OBS-ссылок)
let ovFont = null, ovSize = 0, ovBgOff = false, ovHideOff = false, ovPoints = 'баллов', ovEmoteSize = 20;

function applyStyleObject(s) {
  if (typeof s.font === 'string') ovFont = s.font.trim() || null;
  if (Number.isFinite(+s.size) && +s.size > 0) ovSize = +s.size;
  if (typeof s.bg === 'boolean') ovBgOff = !s.bg;
  if (typeof s.hide === 'boolean') ovHideOff = !s.hide;
  if (typeof s.points === 'string' && s.points.trim()) ovPoints = s.points.trim();
  if (Number.isFinite(+s.emote) && +s.emote > 0) ovEmoteSize = +s.emote;
  if (Number.isFinite(+s.hideAfter) && +s.hideAfter > 0) messageLifetime = +s.hideAfter;
}

function applyUrlOverrides() {
  if ((_ovParams.get('font') || '').trim()) ovFont = _ovParams.get('font').trim();
  const sz = parseInt(_ovParams.get('size'), 10); if (sz > 0) ovSize = sz;
  if (_ovParams.has('bg')) {
    const v = (_ovParams.get('bg') || '').toLowerCase();
    ovBgOff = ['0', 'false', 'none', 'off', 'transparent'].includes(v);
  }
  if (_ovParams.has('hide')) {
    const v = (_ovParams.get('hide') || '').toLowerCase();
    ovHideOff = ['0', 'false', 'off', 'none'].includes(v);
  }
  if ((_ovParams.get('points') || '').trim()) ovPoints = _ovParams.get('points').trim();
  const em = parseInt(_ovParams.get('emote'), 10); if (em > 0) ovEmoteSize = em;
  const ha = parseInt(_ovParams.get('hideAfter'), 10); if (ha > 0) messageLifetime = ha;
}
const POINTS_ICON =
  '<svg class="redeem-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 2 L20 9 L12 22 L4 9 Z" fill="#7c3aed"/>' +
  '<path d="M12 2 L20 9 L12 12 Z" fill="#a78bfa"/>' +
  '<path d="M12 2 L4 9 L12 12 Z" fill="#c4b5fd"/>' +
  '<path d="M12 12 L20 9 L12 22 Z" fill="#6d28d9"/>' +
  '<path d="M12 12 L4 9 L12 22 Z" fill="#8b5cf6"/>' +
  '<circle cx="9.4" cy="8" r="1.3" fill="#fff" opacity="0.85"/>' +
  '</svg>';
const DONATION_ICON =
  '<svg class="donation-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 21s-7.5-4.9-10-9.5C.5 8 2.5 4.5 6 4.5c2.2 0 3.6 1.2 4.5 2.6.9-1.4 2.3-2.6 4.5-2.6 3.5 0 5.5 3.5 4 7-2.5 4.6-10 9.5-10 9.5z" fill="#ffb454"/>' +
  '<path d="M6.8 7.6c-1.5.2-2.6 1.4-2.7 2.9" stroke="#ffe3bd" stroke-width="1.4" stroke-linecap="round"/>' +
  '</svg>';
const CURRENCY_SIGN = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴', BYN: 'Br', KZT: '₸', GBP: '£', JPY: '¥' };
function formatAmount(a) {
  const n = Number(a);
  if (!isFinite(n)) return String(a);
  return (n % 1 === 0) ? String(n) : n.toFixed(2);
}
let messageLifetime = 30000;
const HIDE_DURATION = 500;
let emoteMap = {};
let badgeMap = {};


// ======================== WEBSOCKET ========================

const ws = new WebSocket(`ws://${window.location.host}`);

ws.onopen = () => console.log('[WS] Connected');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'emotes') {
    emoteMap = msg.data;
    for (const k in emoteMap) preloadEmote(emoteMap[k] && emoteMap[k].url);
  }
  if (msg.type === 'chat') {
    if (msg.data.emotes) for (const k in msg.data.emotes) preloadEmote(msg.data.emotes[k]);
    renderMessage(msg.data);
  }
  if (msg.type === 'redeem') {
    renderRedeem(msg.data);
  }
  if (msg.type === 'donation') {
    renderDonation(msg.data);
  }
  if (msg.type === 'cheer') {
    renderCheer(msg.data);
  }
  if (msg.type === 'sub') {
    renderSub(msg.data);
  }
  if (msg.type === 'subgift') {
    renderSubGift(msg.data);
  }
  if (msg.type === 'resub') {
    renderResub(msg.data);
  }
  if (msg.type === 'watchstreak') {
    renderWatchStreak(msg.data);
  }
  if (msg.type === 'badges') {
  badgeMap = msg.data;
  }
  if (msg.type === 'style') {
    // сервер разослал новый стиль — применяем + URL-переопределения + ретаймер
    const d = msg.data || {};
    const prevHideOff = ovHideOff;
    const prevLife = messageLifetime;
    applyStyleObject(d);
    applyUrlOverrides();
    applyStyleVars();
    if (ovHideOff !== prevHideOff || messageLifetime !== prevLife) {
      const nodes = chatContainer.children;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (ovHideOff) {
          clearTimeout(el._hideTimer); clearTimeout(el._removeTimer);
          el._hideTimer = null;
          el.classList.remove('hiding');
          el.style.maxHeight = ''; el.style.overflow = '';
        } else {
          clearTimeout(el._hideTimer); el._hideTimer = null;
          if (!el.classList.contains('hiding')) scheduleHide(el);
        }
      }
    }
  }
};

ws.onclose = () => {
  setTimeout(() => location.reload(), 3000);
};

// ======================== общие блоки рендеринга ========================

function buildBadgesHTML(badges) {
  if (!badges || !badges.length) return '';
  let html = '<span class="badges-wrap">';
  for (const badge of badges) {
    const key = badge.name + '/' + badge.version;
    let url = badgeMap[key];
    if (!url && badge.name === 'subscriber') url = badgeMap['subscriber/0'];
    if (url) html += '<img class="badge" src="' + url + '" width="18" height="18" alt="" title="' + badge.name + '">';
  }
  return html + '</span>';
}

function appendAndTrim(div) {
  chatContainer.appendChild(div);
  if (!ovHideOff) scheduleHide(div);
  while (chatContainer.children.length > MAX_MESSAGES) {
    const old = chatContainer.firstChild;
    clearTimeout(old._hideTimer);
    clearTimeout(old._removeTimer);
    chatContainer.removeChild(old);
  }
}

// ======================== RENDER ========================

function buildMessageHTML(data) {
  let html = buildBadgesHTML(data.badges);
  html += '<b class="username" style="color:' + data.color + ';font-weight:bold;">' + escapeHtml(data.username) + '</b>';
  html += '<span class="colon" style="color:#adadb8;margin:0 4px 0 1px;">:</span> ';
  html += renderEmotes(data.message, data.emotes, {});
  if (data.bits) {
    html += '<span class="bits" style="color:#ffd700;font-weight:bold;margin-left:5px;">' + data.bits + ' bits</span>';
  }
  if (data.redeem) {
    html = '<div class="redeem-row">' + POINTS_ICON + '<div class="redeem-text">' + html + '</div></div>';
  }
  return html;
}

function renderMessage(data) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  if (data.redeem) div.classList.add('redeem-message');
  if (data.userId) div.dataset.uid = data.userId;
  div._msgData = data;
  div.innerHTML = buildMessageHTML(data);
  appendAndTrim(div);
}


// Предзагрузка картинок: греем кэш заранее, чтобы в OBS не было пустых слотов
const _preloaded = new Set();
function preloadEmote(url) {
  if (!url || _preloaded.has(url)) return;
  _preloaded.add(url);
  const im = new Image();
  im.src = url;
}

// Пак зрителя доехал — пересобираем его уже нарисованные сообщения с его эмодзи

function scheduleHide(el) {
  el._hideTimer = setTimeout(() => startHide(el), messageLifetime);
}

function startHide(el) {
  if (!el.isConnected) return;
  clearTimeout(el._hideTimer);
  el.style.maxHeight = el.offsetHeight + 'px';
  el.style.overflow = 'hidden';
  void el.offsetWidth;
  el.classList.add('hiding');
  el._removeTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, HIDE_DURATION + 60);
}

function renderRedeem(d) {
  const div = document.createElement('div');
  div.className = 'chat-message redeem-message';

  let text =
    '<span class="redeem-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="redeem-verb">использовал</span> ' +
    '<span class="redeem-reward">' + escapeHtml(d.rewardName) + '</span>' +
    ' <span class="redeem-verb">за</span> ' +
    '<span class="redeem-cost">' + escapeHtml(String(d.cost)) + '</span> ' +
    escapeHtml(ovPoints);

  if (d.userInput) {
    text += '<div class="redeem-input">&laquo;' + escapeHtml(d.userInput) + '&raquo;</div>';
  }
  div.innerHTML = '<div class="redeem-row">' + POINTS_ICON + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}
function renderDonation(d) {
  const div = document.createElement('div');
  div.className = 'chat-message donation-message';

  const cur = CURRENCY_SIGN[(d.currency || '').toUpperCase()] || (d.currency || '');
  let text =
    '<span class="donation-user">' + escapeHtml(d.username) + '</span>' +
    ' <span class="donation-verb">задонатил</span> ' +
    '<span class="donation-sum">' + escapeHtml(formatAmount(d.amount)) + ' ' + escapeHtml(cur) + '</span>';
  if (d.message) {
    text += '<div class="donation-text">' + escapeHtml(d.message).replace(/\r?\n/g, '<br>') + '</div>';
  }
  div.innerHTML = '<div class="redeem-row">' + DONATION_ICON + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}
const ICON_BITS =
  '<svg class="event-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 2 L21 8 L18 21 H6 L3 8 Z" fill="#ffd700"/>' +
  '<path d="M12 6 L16.5 9 L12 17 L7.5 9 Z" fill="#8a6d00"/>' +
  '</svg>';
const ICON_SUB =
  '<svg class="event-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 2 L14.9 8.6 L22 9.3 L16.6 14 L18.2 21 L12 17.3 L5.8 21 L7.4 14 L2 9.3 L9.1 8.6 Z" fill="#b388ff"/>' +
  '</svg>';
const ICON_GIFT =
  '<svg class="event-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<rect x="4" y="10" width="16" height="11" rx="2" fill="#2ee6a8"/>' +
  '<rect x="3" y="7" width="18" height="4" rx="1" fill="#7ff0c8"/>' +
  '<rect x="10.6" y="7" width="2.8" height="14" fill="#0b7a55"/>' +
  '<path d="M12 7 C9 7 7.5 5.5 8 4 C8.5 2.5 11 3 12 5 C13 3 15.5 2.5 16 4 C16.5 5.5 15 7 12 7 Z" fill="#0b7a55"/>' +
  '</svg>';
  const ICON_STREAK =
  '<svg class="event-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 2 C13 7 18 8.5 18 14 A6 6 0 0 1 6 14 C6 10.5 8.5 9 9 6 C10.5 7.5 11.5 9 11.5 11 C12.5 9.5 12.5 5 12 2 Z" fill="#4aa8ff"/>' +
  '<path d="M12 21 A3.4 3.4 0 0 1 8.6 17.6 C8.6 15.4 10.4 14.4 12 12.6 C13.6 14.4 15.4 15.4 15.4 17.6 A3.4 3.4 0 0 1 12 21 Z" fill="#bfe0ff"/>' +
  '</svg>';

function renderWatchStreak(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message streak-message';
  let text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">смотрит</span> ' +
    (d.streak ? '<span class="event-sum">' + escapeHtml(String(d.streak)) + ' стримов подряд</span>' : '<span class="event-sum">серия просмотров</span>');
  if (d.text) text += '<div class="event-text">' + escapeHtml(d.text) + '</div>';
  div.innerHTML = '<div class="redeem-row">' + ICON_STREAK + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

function tierLabel(t) { return t === '2000' ? 'Tier 2' : t === '3000' ? 'Tier 3' : 'Tier 1'; }

function renderCheer(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message cheer-message';
  let text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">' + (d.anonymous ? 'анонимно поддержал' : 'поддержал') + '</span> ' +
    '<span class="event-sum">' + escapeHtml(String(d.bits)) + ' bits</span>';
  if (d.message) text += '<div class="event-text">' + escapeHtml(d.message).replace(/\r?\n/g, '<br>') + '</div>';
  div.innerHTML = '<div class="redeem-row">' + ICON_BITS + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

function renderSub(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message sub-message';
  const text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">оформил подписку</span> ' +
    '<span class="event-sum">' + tierLabel(d.tier) + '</span>';
  div.innerHTML = '<div class="redeem-row">' + ICON_SUB + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

function renderResub(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message resub-message';
  let text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">продлил подписку —</span> ' +
    '<span class="event-sum">' + escapeHtml(String(d.months || 1)) + ' мес.</span>' +
    (d.streak > 0 ? ' <span class="event-verb">(серия ' + escapeHtml(String(d.streak)) + ')</span>' : '') +
    ' <span class="event-sum">' + tierLabel(d.tier) + '</span>';
  if (d.message) text += '<div class="event-text">' + escapeHtml(d.message).replace(/\r?\n/g, '<br>') + '</div>';
  div.innerHTML = '<div class="redeem-row">' + ICON_SUB + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

function renderSubGift(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message gift-message';
  const text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">подарил</span> ' +
    '<span class="event-sum">' + escapeHtml(String(d.total)) + ' подписок</span>' +
    ' <span class="event-sum">' + tierLabel(d.tier) + '</span>';
  div.innerHTML = '<div class="redeem-row">' + ICON_GIFT + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

// ======================== EMOTES ========================

const EMOTE_STYLE = 'height:var(--ov-emote,20px);max-height:var(--ov-emote,20px);width:auto;max-width:calc(var(--ov-emote,20px)*2.8);vertical-align:middle;display:inline-block;object-fit:contain;margin:0 1px;';

function renderEmotes(message, twitchEmotes, userPersonal) {
  const tokens = message.split(/\s+/);
  let html = '';
  for (const token of tokens) {
    const info = userPersonal[token] || emoteMap[token];
    if (info) {
      html += emoteImg(info.url, token);
    } else if (twitchEmotes && twitchEmotes[token]) {
      html += emoteImg(twitchEmotes[token], token);
    } else {
      html += escapeHtml(token) + ' ';
    }
  }
  return html.trim();
}

function emoteImg(url, name) {
  return `<img class="emote" src="${url}" width="20" height="20" style="${EMOTE_STYLE}" alt="" title="${escapeHtml(name)}">`;
}

// ======================== UTILS ========================

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ==================== стиль оверлея через CSS-переменные ====================
// Одна запись на documentElement вместо цикла по всем сообщениям.
function applyStyleVars() {
  const r = document.documentElement.style;
  r.setProperty('--ov-font', ovFont ? ('"' + ovFont + '", "Segoe UI", Arial, sans-serif') : "'Segoe UI', Arial, sans-serif");
  r.setProperty('--ov-size', (ovSize || 14) + 'px');
  r.setProperty('--ov-emote', (ovEmoteSize || 20) + 'px');
  if (ovBgOff) {
    r.setProperty('--ov-bg', 'transparent');
    r.setProperty('--ov-pad', '2px 0');
    r.setProperty('--ov-bg-redeem', 'transparent');
    r.setProperty('--ov-pad-redeem', '4px 10px 4px 12px');
    r.setProperty('--ov-bg-donation', 'transparent');
    r.setProperty('--ov-pad-donation', '4px 10px 4px 12px');
    r.setProperty('--ov-bg-gift', 'transparent'); 
    r.setProperty('--ov-pad-gift', '4px 10px 4px 12px');
    r.setProperty('--ov-bg-streak', 'transparent'); 
    r.setProperty('--ov-pad-streak', '4px 10px 4px 12px');
  } else {
    r.setProperty('--ov-bg', 'rgba(15,15,18,0.82)');
    r.setProperty('--ov-pad', '6px 10px');
    r.setProperty('--ov-bg-redeem', 'linear-gradient(100deg, rgba(145,71,255,0.24), rgba(46,230,168,0.10) 58%, rgba(15,15,18,0.82))');
    r.setProperty('--ov-pad-redeem', '7px 12px 7px 14px');
    r.setProperty('--ov-bg-donation', 'linear-gradient(100deg, rgba(255,180,84,0.20), rgba(46,230,168,0.08) 58%, rgba(15,15,18,0.82))');
    r.setProperty('--ov-pad-donation', '7px 12px 7px 14px');
    r.setProperty('--ov-bg-gift', 'linear-gradient(100deg, rgba(46,230,168,0.20), rgba(46,230,168,0.06) 58%, rgba(15,15,18,0.82))'); 
    r.setProperty('--ov-pad-gift', '7px 12px 7px 14px');
    r.setProperty('--ov-bg-streak', 'linear-gradient(100deg, rgba(74,168,255,0.20), rgba(74,168,255,0.06) 58%, rgba(15,15,18,0.82))'); 
    r.setProperty('--ov-pad-streak', '7px 12px 7px 14px');
  }
  
}
// 1. Мгновенно — URL/дефолты, чтобы оверлей не мерцал без стилей
applyUrlOverrides();
applyStyleVars();
// 2. Асинхронно — серверный стиль как база, URL-переопределения поверх
fetch('/api/style')
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null)
  .then(s => {
    if (s) { applyStyleObject(s); applyUrlOverrides(); applyStyleVars(); }
  });

// ==================== Живой стиль из панели (postMessage) ====================
function applyOverlayStyle(d) {
  if (!d || d.type !== 'overlay-style') return;

  if (typeof d.font === 'string') ovFont = d.font.trim() || null;
  if (d.size != null) ovSize = parseInt(d.size, 10) || 0;
  if (d.bg != null) ovBgOff = (d.bg === false || d.bg === 0 || d.bg === '0');

  const prevHideOff = ovHideOff;
  const prevLife = messageLifetime;
  if (d.hide != null) ovHideOff = (d.hide === false || d.hide === 0 || d.hide === '0');
  if (d.hideAfter != null) { const v = parseInt(d.hideAfter, 10); if (v > 0) messageLifetime = v; }
  if (d.points != null) ovPoints = String(d.points).trim() || 'баллов';
  if (d.emote != null) { const v = parseInt(d.emote, 10); if (v > 0) ovEmoteSize = v; }
  applyStyleVars();

  const timerChanged = (prevHideOff !== ovHideOff) || (prevLife !== messageLifetime);
  if (timerChanged) {
    const nodes = chatContainer.children;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (ovHideOff) {
        clearTimeout(el._hideTimer); clearTimeout(el._removeTimer);
        el._hideTimer = null;
        el.classList.remove('hiding');
        el.style.maxHeight = ''; el.style.overflow = '';
      } else {
        clearTimeout(el._hideTimer); el._hideTimer = null;
        if (!el.classList.contains('hiding')) scheduleHide(el);
      }
    }
  }
}


window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'overlay-style') applyOverlayStyle(e.data);
});

// сказали панели «я загрузился» — она пришлёт текущий стиль
try { window.parent.postMessage({ type: 'overlay-ready' }, '*'); } catch (e) {}