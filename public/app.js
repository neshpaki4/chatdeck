const chatContainer = document.getElementById('chat-container');
const MAX_MESSAGES = 50;
const _ovParams = new URLSearchParams(location.search);

// стиль — сервер как база, URL-параметры как переопределение
let ovFont = null, ovSize = 0, ovBgOff = false, ovHideOff = false, ovPoints = 'баллов', ovEmoteSize = 20;
let ovGap = 6, ovTextColor = '#efeff1', ovBgColor = '#0f0f12', ovBgOpacity = 82, ovShowBadges = true, ovHighlightRoles = true;

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string' || hex[0] !== '#') return `rgba(15,15,18,${alpha})`;
  let c = hex.slice(1);
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  if (isNaN(num)) return `rgba(15,15,18,${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyStyleObject(s) {
  if (typeof s.font === 'string') ovFont = s.font.trim() || null;
  if (Number.isFinite(+s.size) && +s.size > 0) ovSize = +s.size;
  if (Number.isFinite(+s.gap) && +s.gap >= 0) ovGap = +s.gap;
  if (typeof s.textColor === 'string' && s.textColor) ovTextColor = s.textColor;
  if (typeof s.bgColor === 'string' && s.bgColor) ovBgColor = s.bgColor;
  if (Number.isFinite(+s.bgOpacity) && +s.bgOpacity >= 0 && +s.bgOpacity <= 100) ovBgOpacity = +s.bgOpacity;
  if (typeof s.showBadges === 'boolean') ovShowBadges = s.showBadges;
  if (typeof s.highlightRoles === 'boolean') ovHighlightRoles = s.highlightRoles;
  if (typeof s.bg === 'boolean') ovBgOff = !s.bg;
  if (typeof s.hide === 'boolean') ovHideOff = !s.hide;
  if (typeof s.points === 'string' && s.points.trim()) ovPoints = s.points.trim();
  if (Number.isFinite(+s.emote) && +s.emote > 0) ovEmoteSize = +s.emote;
  if (Number.isFinite(+s.hideAfter) && +s.hideAfter > 0) messageLifetime = +s.hideAfter;
}

function applyUrlOverrides() {
  if ((_ovParams.get('font') || '').trim()) ovFont = _ovParams.get('font').trim();
  const sz = parseInt(_ovParams.get('size'), 10); if (sz > 0) ovSize = sz;
  if (_ovParams.has('gap')) { const g = parseInt(_ovParams.get('gap'), 10); if (g >= 0) ovGap = g; }
  if ((_ovParams.get('textColor') || '').trim()) ovTextColor = _ovParams.get('textColor').trim();
  if ((_ovParams.get('bgColor') || '').trim()) ovBgColor = _ovParams.get('bgColor').trim();
  if (_ovParams.has('bgOpacity')) { const o = parseInt(_ovParams.get('bgOpacity'), 10); if (o >= 0 && o <= 100) ovBgOpacity = o; }
  if (_ovParams.has('badges')) {
    const v = (_ovParams.get('badges') || '').toLowerCase();
    ovShowBadges = !['0', 'false', 'off', 'none', 'hide'].includes(v);
  }
  if (_ovParams.has('highlightRoles') || _ovParams.has('roles')) {
    const v = (_ovParams.get('highlightRoles') || _ovParams.get('roles') || '').toLowerCase();
    ovHighlightRoles = !['0', 'false', 'off', 'none', 'hide'].includes(v);
  }
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
  if (msg.type === 'delete_message') {
    if (msg.id) {
      const escaped = window.CSS && CSS.escape ? CSS.escape(msg.id) : msg.id.replace(/["\\]/g, '\\$&');
      const el = chatContainer.querySelector('[data-msg-id="' + escaped + '"]');
      if (el) removeMessageElement(el);
    }
  }
  if (msg.type === 'clear_user') {
    if (msg.username) {
      const uname = (msg.username || '').toLowerCase();
      const escaped = window.CSS && CSS.escape ? CSS.escape(uname) : uname.replace(/["\\]/g, '\\$&');
      const els = chatContainer.querySelectorAll('[data-username="' + escaped + '"]');
      for (let i = 0; i < els.length; i++) removeMessageElement(els[i]);
    }
  }
  if (msg.type === 'clear_chat') {
    chatContainer.innerHTML = '';
  }
  if (msg.type === 'badges') {
    badgeMap = msg.data;
  }
  if (msg.type === 'style') {
    const d = msg.data || {};
    if (d.font !== undefined) ovFont = d.font || null;
    if (d.size !== undefined) ovSize = d.size;
    if (d.gap !== undefined) ovGap = d.gap;
    if (d.textColor !== undefined) ovTextColor = d.textColor;
    if (d.bgColor !== undefined) ovBgColor = d.bgColor;
    if (d.bgOpacity !== undefined) ovBgOpacity = d.bgOpacity;
    if (d.showBadges !== undefined) ovShowBadges = d.showBadges;
    if (d.highlightRoles !== undefined) ovHighlightRoles = d.highlightRoles;
    if (d.bg !== undefined) ovBgOff = !d.bg;
    if (d.hide !== undefined) ovHideOff = !d.hide;
    if (d.points !== undefined) ovPoints = d.points || 'баллов';
    if (d.emote !== undefined) ovEmoteSize = d.emote;
    if (d.hideAfter !== undefined) messageLifetime = d.hideAfter;
    applyUrlOverrides();
    applyStyleVars();
    refreshAllMessagesBadges();
  }
};

ws.onclose = () => {
  console.log('[WS] Disconnected, retry in 3s...');
  setTimeout(() => location.reload(), 3000);
};

// ======================== PRELOAD ========================

const preloadedUrls = new Set();
function preloadEmote(url) {
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.src = url;
}

// ======================== RENDER ========================

function removeMessageElement(div) {
  if (!div) return;
  if (div._hideTimer) clearTimeout(div._hideTimer);
  if (div._removeTimer) clearTimeout(div._removeTimer);
  div.classList.add('hiding');
  setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, HIDE_DURATION);
}

function appendAndTrim(div) {
  chatContainer.appendChild(div);
  while (chatContainer.children.length > MAX_MESSAGES) {
    const old = chatContainer.children[0];
    if (old._hideTimer) clearTimeout(old._hideTimer);
    if (old._removeTimer) clearTimeout(old._removeTimer);
    chatContainer.removeChild(old);
  }
  if (!ovHideOff) scheduleMessageHide(div);
}

function scheduleMessageHide(div) {
  div._hideTimer = setTimeout(() => {
    div.classList.add('hiding');
    div._removeTimer = setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, HIDE_DURATION);
  }, messageLifetime);
}

function buildMessageHTML(data) {
  let html = buildBadgesHTML(data.badges);
  html += '<b class="username" style="color:' + data.color + ';font-weight:bold;">' + escapeHtml(data.username) + '</b>';
  html += '<span class="colon" style="color:#adadb8;margin:0 4px 0 1px;">:</span> ';
  html += renderEmotes(data.message, data.emotes, {});
  if (data.bits) {
    html += '<span class="bits" style="color:#ffd700;font-weight:bold;margin-left:5px;">' + data.bits + ' bits</span>';
  }
  if (data.redeem) {
    html += '<div class="redeem-badge">' + escapeHtml(data.redeem.name) + '</div>';
  }
  return html;
}

function buildBadgesHTML(badges) {
  if (!badges || !badges.length) return '';
  let bHtml = '<span class="badges-wrap">';
  for (const b of badges) {
    const key = `${b.name}/${b.version}`;
    const url = badgeMap[key];
    if (url) {
      bHtml += `<img class="badge" src="${url}" width="18" height="18" alt="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}">`;
    }
  }
  bHtml += '</span>';
  return bHtml;
}

function refreshAllMessagesBadges() {
  const msgs = chatContainer.querySelectorAll('.chat-message');
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m._msgData) m.innerHTML = buildMessageHTML(m._msgData);
  }
}

function renderMessage(data) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  if (data.redeem) div.classList.add('redeem-message');
  if (data.userId) div.dataset.uid = data.userId;
  if (data.id) div.dataset.msgId = data.id;
  if (data.username) div.dataset.username = (data.username || '').toLowerCase();
  if (Array.isArray(data.badges)) {
    if (data.badges.some(b => b && b.name === 'broadcaster')) div.classList.add('role-broadcaster');
    else if (data.badges.some(b => b && b.name === 'moderator')) div.classList.add('role-moderator');
    else if (data.badges.some(b => b && b.name === 'vip')) div.classList.add('role-vip');
  }
  div._msgData = data;
  div.innerHTML = buildMessageHTML(data);
  appendAndTrim(div);
}

function renderRedeem(d) {
  const div = document.createElement('div');
  div.className = 'chat-message redeem-message';
  if (d.userId) div.dataset.uid = d.userId;
  if (d.id) div.dataset.redeemId = d.id;
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();

  const ptsWord = ovPoints ? ' ' + ovPoints : ' баллов';
  const cost = d.cost != null ? ' (' + escapeHtml(String(d.cost)) + ptsWord + ')' : '';
  let text =
    '<span class="redeem-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="redeem-verb">активировал</span> ' +
    '<span class="redeem-reward">' + escapeHtml(d.rewardName) + '</span>' +
    '<span class="redeem-cost">' + cost + '</span>';

  if (d.userInput) {
    text += '<div class="redeem-input">&laquo;' + escapeHtml(d.userInput) + '&raquo;</div>';
  }
  div.innerHTML = '<div class="redeem-row">' + POINTS_ICON + '<div class="redeem-text">' + text + '</div></div>';
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
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();
  let text =
    '<span class="event-user" style="color:' + d.color + '">' + escapeHtml(d.username) + '</span>' +
    ' <span class="event-verb">смотрит</span> ' +
    (d.streak ? '<span class="event-sum">' + escapeHtml(String(d.streak)) + ' стримов подряд</span>' : '<span class="event-sum">серия просмотров</span>');
  if (d.message) text += '<div class="event-text">' + escapeHtml(d.message) + '</div>';
  div.innerHTML = '<div class="redeem-row">' + ICON_STREAK + '<div class="redeem-text">' + text + '</div></div>';
  appendAndTrim(div);
}

function tierLabel(t) { return t === '2000' ? 'Tier 2' : t === '3000' ? 'Tier 3' : 'Tier 1'; }

function renderCheer(d) {
  const div = document.createElement('div');
  div.className = 'chat-message event-message cheer-message';
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();
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
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();
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
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();
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
  if (d.username) div.dataset.username = (d.username || '').toLowerCase();
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
    const info = (userPersonal && userPersonal[token]) || emoteMap[token];
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
function applyStyleVars() {
  const r = document.documentElement.style;
  r.setProperty('--ov-font', ovFont ? ('"' + ovFont + '", "Segoe UI", Arial, sans-serif') : "'Segoe UI', Arial, sans-serif");
  r.setProperty('--ov-size', (ovSize || 14) + 'px');
  r.setProperty('--ov-gap', (ovGap != null ? ovGap : 6) + 'px');
  r.setProperty('--ov-text', ovTextColor || '#efeff1');
  r.setProperty('--ov-badge-display', ovShowBadges === false ? 'none' : 'inline-flex');
  r.setProperty('--ov-emote', (ovEmoteSize || 20) + 'px');
  chatContainer.classList.toggle('highlight-roles', !!ovHighlightRoles);

  if (ovBgOff) {
    r.setProperty('--ov-bg', 'transparent');
    r.setProperty('--ov-pad', '2px 0');
    r.setProperty('--ov-bg-redeem', 'transparent');
    r.setProperty('--ov-pad-redeem', '4px 10px 4px 12px');
    r.setProperty('--ov-bg-gift', 'transparent'); 
    r.setProperty('--ov-pad-gift', '4px 10px 4px 12px');
    r.setProperty('--ov-bg-streak', 'transparent'); 
    r.setProperty('--ov-pad-streak', '4px 10px 4px 12px');
  } else {
    const alpha = (Number.isFinite(+ovBgOpacity) ? Math.max(0, Math.min(100, +ovBgOpacity)) : 82) / 100;
    const bgRgba = hexToRgba(ovBgColor || '#0f0f12', alpha);
    r.setProperty('--ov-bg', bgRgba);
    r.setProperty('--ov-pad', '6px 10px');
    r.setProperty('--ov-bg-redeem', 'linear-gradient(100deg, rgba(145,71,255,0.24), rgba(46,230,168,0.10) 58%, ' + bgRgba + ')');
    r.setProperty('--ov-pad-redeem', '7px 12px 7px 14px');
    r.setProperty('--ov-bg-gift', 'linear-gradient(100deg, rgba(46,230,168,0.20), rgba(46,230,168,0.06) 58%, ' + bgRgba + ')'); 
    r.setProperty('--ov-pad-gift', '7px 12px 7px 14px');
    r.setProperty('--ov-bg-streak', 'linear-gradient(100deg, rgba(74,168,255,0.20), rgba(74,168,255,0.06) 58%, ' + bgRgba + ')'); 
    r.setProperty('--ov-pad-streak', '7px 12px 7px 14px');
  }
}

function applyOverlayStyle(s) {
  if (s.font !== undefined) ovFont = s.font || null;
  if (s.size !== undefined) ovSize = s.size;
  if (s.gap !== undefined) ovGap = s.gap;
  if (s.textColor !== undefined) ovTextColor = s.textColor;
  if (s.bgColor !== undefined) ovBgColor = s.bgColor;
  if (s.bgOpacity !== undefined) ovBgOpacity = s.bgOpacity;
  if (s.showBadges !== undefined) ovShowBadges = s.showBadges;
  if (s.highlightRoles !== undefined) ovHighlightRoles = s.highlightRoles;
  if (s.bg !== undefined) ovBgOff = !s.bg;
  if (s.hide !== undefined) ovHideOff = !s.hide;
  if (s.points !== undefined) ovPoints = s.points || 'баллов';
  if (s.emote !== undefined) ovEmoteSize = s.emote;
  if (s.hideAfter !== undefined) messageLifetime = s.hideAfter;
  applyUrlOverrides();
  applyStyleVars();
}

// Старт: 1) читаем стиль с сервера, 2) накладываем URL-оверрайды, 3) применяем
fetch('/api/style')
  .then(r => r.json())
  .then(s => { applyStyleObject(s); applyUrlOverrides(); applyStyleVars(); })
  .catch(() => { applyUrlOverrides(); applyStyleVars(); });

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'overlay-style') applyOverlayStyle(e.data);
});

try {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'overlay-ready' }, '*');
  }
} catch (e) {}
