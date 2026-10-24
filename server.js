const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const tmi = require('tmi.js');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

function createChatServer(options = {}) {
  const configPath = options.configPath || path.join(__dirname, 'config.json');
  const publicDir = options.publicDir || path.join(__dirname, 'public');

  // Порт OAuth-коллбека фиксирован и не зависит от порта чата.
  // В консоли Twitch прописывается: http://localhost:6769/auth/callback
  const AUTH_PORT = 6769;
  const REDIRECT_URI = 'http://localhost:' + AUTH_PORT + '/auth/callback';
  const DEFAULT_CLIENT_ID = 'zsgb0890siszkgvuoa7covgrayojmg';

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use(express.json());

  const state = {
    running: false,
    chatConnected: false,
    channel: null,
    port: null,
    messages: 0,
    emotes: 0,
    badges: 0,
    startedAt: null,
    streamLive: false,
    streamStartedAt: null,
    streamViewers: 0,
    error: null,
    redeemConnected: false,
    redeemLogin: null,
    eventSubActive: false
  };

  let client = null;
  let appToken = null;
  let badgeMap = {};
  let emoteMap = {};
  let currentConfig = null;
  let channelBadgesLoaded = false;

  // --- LRU-кэш: держит не больше max записей, вытесняя самых старых ---
  function makeLRU(max) {
    const m = new Map();
    return {
      get: k => m.get(k),
      has: k => m.has(k),
      set(k, v) {
        if (m.has(k)) m.delete(k);      // переместить в «конец» (самый свежий)
        m.set(k, v);
        while (m.size > max) m.delete(m.keys().next().value);
      },
      entries: () => m.entries(),
      clear: () => m.clear()
    };
  }

  // --- Redeems / EventSub / OAuth ---
  let userToken = null;
  let userRefresh = null;
  let userExpiresAt = 0;
  let broadcasterId = null;
  let broadcasterLogin = null;
  let eventSubWs = null;
  let eventSubSessionId = null;
  let eventSubActive = false;       // подписка создана и соединение живо
  let eventSubStop = false;         // намеренная остановка (без автореконнекта)
  let authServer = null;
  let pendingAuthState = null;
  const userColorCache = makeLRU(500);      // userId -> цвет ника (EventSub цвет не несёт)
  const recentEventIds = makeLRU(500);      // EventSub at-least-once: режем дубли по message_id

  // ==================== CONFIG ====================

  function getConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch { return { channel: '', clientId: '', clientSecret: '', port: 6767 }; }
  }

  function saveConfig(cfg) {
    fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
      .catch(e => console.error('[Config] write error:', e.message));
  }

  app.get('/api/config', (req, res) => {
    const cfg = getConfig();
    res.json({
      channel: cfg.channel || '',
      clientId: cfg.clientId || '',
      clientSecret: cfg.clientSecret ? '••••••••' + cfg.clientSecret.slice(-4) : '',
      port: cfg.port || 6767,
      pointsName: cfg.pointsName || ''
    });
  });

  app.post('/api/config', (req, res) => {
    const old = getConfig();
    const { channel, clientId, clientSecret, port, pointsName } = req.body;
    if (!channel || !channel.trim()) return res.status(400).json({ error: 'channel required' });

    const clean = channel.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
    const finalSecret = (clientSecret && !clientSecret.startsWith('••••'))
      ? clientSecret.trim() : (old.clientSecret || '');

    const newCfg = {
      channel: clean,
      clientId: (clientId || old.clientId || '').trim(),
      clientSecret: finalSecret,
      port: parseInt(port, 10) || old.port || 6767,
      pointsName: (pointsName || '').trim(),
      style: old.style,
      // токены редимов не приходят с формы — переносим, чтобы не потерять
      userAccessToken: old.userAccessToken,
      userRefreshToken: old.userRefreshToken,
      userTokenExpires: old.userTokenExpires,
      broadcasterId: old.broadcasterId,
      broadcasterLogin: old.broadcasterLogin
    };

    res.json({ ok: true, channel: clean, port: newCfg.port });
    // Сначала ответ, потом рестарт (иначе порт сменится до ответа)
    setTimeout(() => applyConfig(newCfg).catch(e => {
      state.error = e.message;
      console.error('[Config]', e.message);
    }), 400);
  });

  app.get('/', (req, res, next) => {
    const cfg = getConfig();
    if (!cfg || !cfg.channel) return res.redirect('/setup.html');
    next();
  });

  // ==================== STYLE (стиль оверлея хранится в config.json) ====================
  const DEFAULT_STYLE = {
    font: 'Segoe UI',
    size: 14,
    gap: 6,
    textColor: '#efeff1',
    bgColor: '#0f0f12',
    bgOpacity: 82,
    showBadges: true,
    bg: true,
    hide: true,
    hideAfter: 30000,
    points: '',
    emote: 20,
    highlightRoles: true
  };

  function getStyle() {
    const cfg = getConfig();
    return { ...DEFAULT_STYLE, ...(cfg.style || {}) };
  }

  // Панель в Electron открыта через file:// (origin null) — разрешаем ей кросс-запросы к стилю
  app.use('/api/style', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight
    next();
  });
  app.get('/api/style', (req, res) => res.json(getStyle()));

  app.post('/api/style', (req, res) => {
    const b = req.body || {};
    const old = getStyle();
    const next = {
      font: typeof b.font === 'string' && b.font.trim() ? b.font.trim() : old.font,
      size: parseInt(b.size, 10) > 0 ? parseInt(b.size, 10) : old.size,
      gap: Number.isFinite(+b.gap) && +b.gap >= 0 ? Math.min(32, Math.max(0, +b.gap)) : (old.gap != null ? old.gap : 6),
      textColor: typeof b.textColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.textColor) ? b.textColor : (old.textColor || '#efeff1'),
      bgColor: typeof b.bgColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.bgColor) ? b.bgColor : (old.bgColor || '#0f0f12'),
      bgOpacity: Number.isFinite(+b.bgOpacity) && +b.bgOpacity >= 0 && +b.bgOpacity <= 100 ? +b.bgOpacity : (old.bgOpacity != null ? old.bgOpacity : 82),
      showBadges: typeof b.showBadges === 'boolean' ? b.showBadges : (old.showBadges != null ? old.showBadges : true),
      bg: typeof b.bg === 'boolean' ? b.bg : old.bg,
      hide: typeof b.hide === 'boolean' ? b.hide : old.hide,
      hideAfter: parseInt(b.hideAfter, 10) > 0 ? parseInt(b.hideAfter, 10) : old.hideAfter,
      points: typeof b.points === 'string' ? b.points : old.points,
      emote: parseInt(b.emote, 10) > 0 ? parseInt(b.emote, 10) : old.emote,
      highlightRoles: typeof b.highlightRoles === 'boolean' ? b.highlightRoles : (old.highlightRoles != null ? old.highlightRoles : true)
    };
    const cfg = getConfig();
    cfg.style = next;
    saveConfig(cfg);
    console.log('[Style] saved + broadcast');
    // вещаем всем WS-клиентам (OBS) — стиль применяется мгновенно, без перезагрузки страницы
    broadcast(JSON.stringify({ type: 'style', data: next }));
    res.json({ ok: true, style: next });
  });
  app.use(express.static(publicDir));

  // ==================== REDEEMS: OAuth + EventSub ====================

  app.get('/api/redeem-status', (req, res) => {
    res.json(redeemStatusPayload());
  });

  // --- SSE: сервер сам пушит изменения статуса, поллинг не нужен ---
  const sseClients = new Set();
  function redeemStatusPayload() {
    const cfg = getConfig();
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    return {
      connected: state.redeemConnected,
      login: state.redeemLogin,
      eventSubActive: state.eventSubActive,
      canAuth: !!(cid && cfg.clientSecret)
    };
  }
  function notifyRedeemStatus() {
    const data = 'data: ' + JSON.stringify(redeemStatusPayload()) + '\n\n';
    sseClients.forEach(c => c.write(data));
  }
  app.get('/api/redeem-events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    res.write('data: ' + JSON.stringify(redeemStatusPayload()) + '\n\n'); // текущее состояние сразу
    req.on('close', () => sseClients.delete(res));
  });

  // Шаг 1: кнопка в настройках ведёт сюда -> 302 на страницу авторизации Twitch
  app.get('/auth/start', (req, res) => {
    const cfg = getConfig();
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    if (!cid) return res.status(400).send('Client ID не найден.');
    pendingAuthState = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const url =
      'https://id.twitch.tv/oauth2/authorize' +
      '?response_type=code' +
      '&client_id=' + encodeURIComponent(cid) +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&scope=' + encodeURIComponent('channel:read:redemptions channel:read:subscriptions bits:read') +
      '&state=' + encodeURIComponent(pendingAuthState);
    res.redirect(url);
  });

  // Шаг 2: Twitch возвращает сюда код -> обмениваем на user-токен -> стартуем EventSub
  app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    const st = req.query.state;
    const err = req.query.error;
    if (err) return res.status(400).send(htmlPage('Ошибка авторизации', 'Twitch вернул: ' + err));
    if (!code || st !== pendingAuthState) {
      return res.status(400).send(htmlPage('Ошибка', 'Неверный state или отсутствует код. Попробуйте подключить заново.'));
    }
    pendingAuthState = null;
    try {
      const cfg = getConfig();
      const tok = await exchangeCode(cfg, code);
      userToken = tok.access;
      userRefresh = tok.refresh;
      userExpiresAt = Date.now() + (tok.expires_in || 3600) * 1000;

      const me = await fetchBroadcaster(cfg);
      broadcasterId = me.id;
      broadcasterLogin = me.login;

      // сохраняем в конфиг (merge, не затирая channel/port/pointsName)
      const save = getConfig();
      save.userAccessToken = userToken;
      save.userRefreshToken = userRefresh;
      save.userTokenExpires = userExpiresAt;
      save.broadcasterId = broadcasterId;
      save.broadcasterLogin = broadcasterLogin;
      saveConfig(save);

      state.redeemConnected = true;
      state.redeemLogin = broadcasterLogin;
      notifyRedeemStatus();
      console.log('[Redeem] Authorized as', broadcasterLogin, '(' + broadcasterId + ')');

      await startEventSub(cfg);
      res.send(htmlPage('Готово', 'Редимы подключены для канала <b>' + esc(broadcasterLogin) + '</b>. Эту вкладку можно закрыть.'));
    } catch (e) {
      console.error('[Redeem] callback error:', e.message);
      res.status(500).send(htmlPage('Ошибка подключения', e.message));
    }
  });

  function htmlPage(title, body) {
    return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>' + esc(title) +
      '</title><style>body{background:#0e0e10;color:#efeff1;font-family:Segoe UI,sans-serif;' +
      'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
      '.c{background:#18181b;border:1px solid #2f2f35;border-radius:12px;padding:32px 36px;' +
      'max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 10px;color:#a78bff}' +
      'p{color:#adadb8;font-size:14px;line-height:1.6;margin:0}</style></head><body><div class="c">' +
      '<h1>' + esc(title) + '</h1><p>' + body + '</p></div>' +
      '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script></body></html>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function exchangeCode(cfg, code) {
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      }).toString()
    });
    const data = await r.json();
    if (!data.access_token) throw new Error('exchange: ' + (data.message || JSON.stringify(data)));
    return { access: data.access_token, refresh: data.refresh_token, expires_in: data.expires_in };
  }

  async function refreshUserToken(cfg) {
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: cfg.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: userRefresh
      }).toString()
    });
    const data = await r.json();
    if (!data.access_token) throw new Error('refresh: ' + (data.message || 'no token'));
    userToken = data.access_token;
    if (data.refresh_token) userRefresh = data.refresh_token;
    userExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    const save = getConfig();
    save.userAccessToken = userToken;
    save.userRefreshToken = userRefresh;
    save.userTokenExpires = userExpiresAt;
    saveConfig(save);
  }

  async function ensureUserToken() {
    if (!userToken) return false;
    try {
      if (Date.now() > userExpiresAt - 60000) await refreshUserToken(getConfig());
      return true;
    } catch (e) {
      console.error('[Redeem] token unusable:', e.message);
      return false;
    }
  }

  async function fetchBroadcaster(cfg) {
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    const r = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': cid, 'Authorization': 'Bearer ' + userToken }
    });
    const data = await r.json();
    if (!data.data || !data.data[0]) throw new Error('helix/users: ' + (data.message || 'empty'));
    return data.data[0];
  }

  // ---------- EventSub WebSocket ----------

  async function startEventSub(cfg) {
    eventSubStop = false;
    if (eventSubWs) { try { eventSubWs.close(); } catch (e) {} eventSubWs = null; }
    eventSubActive = false;
    state.eventSubActive = false;
    connectEventSub(cfg);
  }

  function stopEventSub() {
    eventSubStop = true;
    eventSubActive = false;
    state.eventSubActive = false;
    if (eventSubWs) { try { eventSubWs.close(); } catch (e) {} eventSubWs = null; }
  }

  function resetRedeem() {
    stopEventSub();
    userToken = null; userRefresh = null; userExpiresAt = 0;
    broadcasterId = null; broadcasterLogin = null;
    state.redeemConnected = false; state.redeemLogin = null;
    notifyRedeemStatus();
    const save = getConfig();
    delete save.userAccessToken; delete save.userRefreshToken;
    delete save.userTokenExpires; delete save.broadcasterId; delete save.broadcasterLogin;
    saveConfig(save);
  }

  function connectEventSub(cfg) {
    if (eventSubStop) return;
    let ws;
    try { ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws'); }
    catch (e) { console.error('[EventSub] ws create error:', e.message); scheduleReconnect(cfg); return; }
    eventSubWs = ws;

    ws.on('open', () => console.log('[EventSub] socket open'));

    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      const meta = msg.metadata || {};
      const payload = msg.payload || {};

      if (meta.message_type === 'session_welcome') {
        eventSubSessionId = payload.session.id;
        console.log('[EventSub] welcome, session', eventSubSessionId);
        resetReconnect();
        try { await createSubscription(cfg); }
        catch (e) { console.error('[EventSub] subscribe error:', e.message); }
      } else if (meta.message_type === 'session_keepalive') {
        // ничего не делаем
      } else if (meta.message_type === 'session_reconnect') {
        const reconnectUrl = payload.session && payload.session.reconnect_url;
        console.log('[EventSub] reconnect requested');
        const old = ws;
        eventSubWs = null;
        if (reconnectUrl) connectEventSubAt(cfg, reconnectUrl, old);
        else { try { old.close(); } catch (e) {} scheduleReconnect(cfg); }
      } else if (meta.message_type === 'notification') {
        handleNotification(payload, meta);
      } else if (meta.message_type === 'revocation') {
        console.log('[EventSub] subscription revoked:', payload.subscription && payload.subscription.status);
        eventSubActive = false; state.eventSubActive = false;
        notifyRedeemStatus();
      }
    });

    ws.on('close', () => {
      console.log('[EventSub] socket closed');
      eventSubActive = false; state.eventSubActive = false;
      notifyRedeemStatus();
      if (eventSubWs === ws) eventSubWs = null;
      if (!eventSubStop) scheduleReconnect(cfg);
    });

    ws.on('error', (e) => console.error('[EventSub] ws error:', e.message));
  }

  function connectEventSubAt(cfg, url, oldWs) {
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { try { oldWs.close(); } catch (er) {} scheduleReconnect(cfg); return; }
    eventSubWs = ws;
    ws.on('open', () => console.log('[EventSub] reconnect socket open'));
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      const meta = msg.metadata || {};
      const payload = msg.payload || {};
      if (meta.message_type === 'session_welcome') {
        eventSubSessionId = payload.session.id;
        resetReconnect();
        try { oldWs.close(); } catch (e) {}
        try { await createSubscription(cfg); } catch (e) { console.error('[EventSub] resub error:', e.message); }
      } else if (meta.message_type === 'notification') {
        handleNotification(payload, meta);
      }
    });
    ws.on('close', () => {
      eventSubActive = false; state.eventSubActive = false;
      notifyRedeemStatus();
      if (eventSubWs === ws) eventSubWs = null;
      if (!eventSubStop) scheduleReconnect(cfg);
    });
    ws.on('error', (e) => console.error('[EventSub] reconnect ws error:', e.message));
  }

  let reconnectTimer = null;
  let reconnectDelay = 4000;
  const RECONNECT_MAX = 60000;
  function scheduleReconnect(cfg) {
    if (eventSubStop || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectEventSub(cfg); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }
  function resetReconnect() { reconnectDelay = 4000; }

  const EVENTSUB_TYPES = [
    ['channel.channel_points_custom_reward_redemption.add', '1'],
    ['channel.cheer', '1'],
    ['channel.subscribe', '1'],
    ['channel.subscription.gift', '1'],
    ['channel.subscription.message', '1']
  ];

  async function createSubscription(cfg) {
    if (!eventSubSessionId || !broadcasterId) return;
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    for (const [type, version] of EVENTSUB_TYPES) {
      const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-Id': cid,
          'Authorization': 'Bearer ' + userToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type,
          version,
          condition: { broadcaster_user_id: broadcasterId },
          transport: { method: 'websocket', session_id: eventSubSessionId }
        })
      });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401 && await ensureUserToken()) return createSubscription(cfg);
        console.error('[EventSub] subscribe', type, '-> HTTP', r.status, ':', data.message || '');
        continue;
      }
      console.log('[EventSub] subscribed:', type);
    }
    eventSubActive = true;
    state.eventSubActive = true;
    notifyRedeemStatus();
    console.log('[EventSub] subscriptions done for', broadcasterLogin);
  }

  function handleNotification(payload, meta) {
    if (meta && meta.message_id) {
      if (recentEventIds.has(meta.message_id)) {
        console.log('[EventSub] duplicate skipped:', meta.message_id);
        return;
      }
      recentEventIds.set(meta.message_id, true);
    }
    const type = (payload.subscription || {}).type;
    const ev = payload.event || {};
    if (type === 'channel.channel_points_custom_reward_redemption.add') return handleRedeem(ev);
    if (type === 'channel.cheer') return handleCheerEv(ev);
    if (type === 'channel.subscribe') return handleSubEv(ev);
    if (type === 'channel.subscription.gift') return handleSubGiftEv(ev);
    if (type === 'channel.subscription.message') return handleResubEv(ev);
  }

  function evColor(uid) { return (uid && userColorCache.get(uid)) || '#efeff1'; }

  function handleRedeem(ev) {
    const reward = ev.reward || {};
    const uid = ev.user_id;
    broadcast(JSON.stringify({
      type: 'redeem',
      data: {
        id: ev.id,
        userId: uid,
        username: ev.user_name || ev.user_login || '?',
        color: evColor(uid),
        rewardName: reward.title || 'награду',
        cost: reward.cost != null ? reward.cost : '?',
        userInput: ev.user_input || '',
        timestamp: Date.now()
      }
    }));
  }

  function handleCheerEv(ev) {
    const uid = ev.user_id;
    broadcast(JSON.stringify({
      type: 'cheer',
      data: {
        userId: uid,
        username: ev.is_anonymous ? 'Аноним' : (ev.user_name || ev.user_login || '?'),
        color: evColor(uid),
        bits: ev.bits,
        message: ev.message || '',
        anonymous: !!ev.is_anonymous,
        timestamp: Date.now()
      }
    }));
  }

  function handleSubEv(ev) {
    const uid = ev.user_id;
    broadcast(JSON.stringify({
      type: 'sub',
      data: {
        userId: uid,
        username: ev.user_name || ev.user_login || '?',
        color: evColor(uid),
        tier: ev.tier || '1000',
        timestamp: Date.now()
      }
    }));
  }

  function handleSubGiftEv(ev) {
    const uid = ev.user_id;
    broadcast(JSON.stringify({
      type: 'subgift',
      data: {
        userId: uid,
        username: ev.is_anonymous ? 'Аноним' : (ev.user_name || ev.user_login || '?'),
        color: evColor(uid),
        total: ev.total,
        tier: ev.tier || '1000',
        timestamp: Date.now()
      }
    }));
  }

  function handleResubEv(ev) {
    const uid = ev.user_id;
    broadcast(JSON.stringify({
      type: 'resub',
      data: {
        userId: uid,
        username: ev.user_name || ev.user_login || '?',
        color: evColor(uid),
        tier: ev.tier || '1000',
        months: ev.cumulative_months,
        streak: ev.streak_months,
        message: (ev.message && ev.message.text) || '',
        timestamp: Date.now()
      }
    }));
  }

  // ==================== BADGES ====================

  async function getAppToken(cfg) {
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    if (!cid || !cfg.clientSecret) return;
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cid,
          client_secret: cfg.clientSecret,
          grant_type: 'client_credentials'
        }).toString()
      });
      const data = await res.json();
      if (data.access_token) { appToken = data.access_token; console.log('[Auth] Token OK'); }
      else console.error('[Auth]', data.message || 'failed');
    } catch (e) { console.error('[Auth]', e.message); }
  }

  function helixHeaders(cfg) {
    const cid = cfg.clientId || DEFAULT_CLIENT_ID;
    return { 'Client-Id': cid, 'Authorization': `Bearer ${appToken}` };
  }

  function parseHelixBadges(data) {
    if (!data || !Array.isArray(data.data)) return;
    for (const set of data.data) {
      for (const v of set.versions || []) {
        badgeMap[`${set.set_id}/${v.id}`] = v.image_url_1x || v.image_url_2x;
      }
    }
  }

  async function loadBadges(cfg) {
    if (appToken && (cfg.clientId || DEFAULT_CLIENT_ID)) {
      try {
        const res = await fetch('https://api.twitch.tv/helix/chat/badges/global', { headers: helixHeaders(cfg) });
        if (res.ok) {
          badgeMap = {};
          parseHelixBadges(await res.json());
          console.log(`[Badges] Global: ${Object.keys(badgeMap).length}`);
          return;
        }
      } catch (e) { console.error('[Badges] Helix:', e.message); }
    }
    // IVR fallback (работает без ключей для всех каналов)
    try {
      const res = await fetch('https://api.ivr.fi/v2/twitch/badges/global');
      if (res.ok) {
        badgeMap = {};
        const data = await res.json();
        for (const set of data) {
          for (const v of set.versions || []) {
            badgeMap[`${set.set_id}/${v.id}`] = v.image_url_1x || v.image_url_2x;
          }
        }
        console.log(`[Badges] Global (IVR): ${Object.keys(badgeMap).length}`);
      }
    } catch (e) { console.error('[Badges] IVR Global:', e.message); }
  }

  async function loadChannelBadges(roomId, cfg) {
    if (appToken && (cfg.clientId || DEFAULT_CLIENT_ID)) {
      try {
        const res = await fetch(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${roomId}`, { headers: helixHeaders(cfg) });
        if (res.ok) {
          parseHelixBadges(await res.json());
          console.log(`[Badges] Channel: total ${Object.keys(badgeMap).length}`);
          broadcast(JSON.stringify({ type: 'badges', data: badgeMap }));
          state.badges = Object.keys(badgeMap).length;
          return;
        }
      } catch (e) { console.error('[Badges] Helix Channel:', e.message); }
    }
    // IVR fallback по числовому ID комнаты
    try {
      const res = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`);
      if (res.ok) {
        const data = await res.json();
        for (const set of data) {
          for (const v of set.versions || []) {
            badgeMap[`${set.set_id}/${v.id}`] = v.image_url_1x || v.image_url_2x;
          }
        }
        console.log(`[Badges] Channel (IVR): total ${Object.keys(badgeMap).length}`);
        broadcast(JSON.stringify({ type: 'badges', data: badgeMap }));
        state.badges = Object.keys(badgeMap).length;
      }
    } catch (e) { console.error('[Badges] IVR Channel:', e.message); }
  }

  // ==================== 7TV ====================

  function buildEmoteUrl(host) {
    if (!host || !host.url) return null;
    const base = `https:${host.url}`;
    const files = host.files || [];
    const file =
      files.find(f => f.name === '2x.webp') ||
      files.find(f => f.name === '1x.webp') ||
      files.find(f => /\.webp$/.test(f.name)) ||
      null;
    if (!file) return null;   // avif-только эмодзи в OBS не декодируются
    return { url: `${base}/${file.name}`, width: file.width || 28, height: file.height || 28 };
  }

  function parseEmoteSet(set, target) {
    if (!set || !set.emotes) return;
    for (const emote of set.emotes) {
      const info = buildEmoteUrl(emote.data?.host);
      if (info) target[emote.name] = info;
    }
  }

  // 7TV REST понимает только числовой Twitch-ID — резолвим логин через Helix или Twitch GQL
  async function resolveTwitchUserId(cfg, login) {
    if (appToken && (cfg.clientId || DEFAULT_CLIENT_ID)) {
      try {
        const res = await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), { headers: helixHeaders(cfg) });
        if (res.ok) {
          const data = await res.json();
          if (data.data && data.data[0]) return data.data[0].id;
        }
      } catch (e) {}
    }
    // GQL fallback (без авторизации, мгновенный резолв логина в ID)
    try {
      const cleanCh = login.replace(/[^a-zA-Z0-9_]/g, '');
      const q = '{ user(login: "' + cleanCh + '") { id } }';
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
        body: JSON.stringify({ query: q })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.data && data.data.user && data.data.user.id) {
          return data.data.user.id;
        }
      }
    } catch (e) {}
    return null;
  }

  // ==================== СТАТУС И АПТАЙМ СТРИМА TWITCH ====================
  let streamPollTimer = null;

  async function fetchStreamInfo(channel, cfg) {
    if (!channel) return { live: false, startedAt: null, viewers: 0 };

    if (cfg && (cfg.clientId || DEFAULT_CLIENT_ID) && (appToken || (cfg && cfg.userAccessToken))) {
      try {
        const res = await fetch('https://api.twitch.tv/helix/streams?user_login=' + encodeURIComponent(channel), {
          headers: helixHeaders(cfg)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data && data.data[0]) {
            const s = data.data[0];
            return {
              live: true,
              startedAt: Date.parse(s.started_at),
              viewers: s.viewer_count || 0
            };
          }
          return { live: false, startedAt: null, viewers: 0 };
        }
      } catch (e) {}
    }

    try {
      const cleanCh = channel.replace(/[^a-zA-Z0-9_]/g, '');
      const q = '{ user(login: "' + cleanCh + '") { stream { id createdAt viewersCount } } }';
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
        body: JSON.stringify({ query: q })
      });
      if (res.ok) {
        const data = await res.json();
        const stream = data && data.data && data.data.user && data.data.user.stream;
        if (stream && stream.createdAt) {
          return {
            live: true,
            startedAt: Date.parse(stream.createdAt),
            viewers: stream.viewersCount || 0
          };
        }
        return { live: false, startedAt: null, viewers: 0 };
      }
    } catch (e) {}

    return { live: false, startedAt: null, viewers: 0 };
  }

  async function updateStreamStatus(channel, cfg) {
    if (!channel) {
      state.streamLive = false;
      state.streamStartedAt = null;
      state.streamViewers = 0;
      return;
    }
    const info = await fetchStreamInfo(channel, cfg);
    state.streamLive = info.live;
    state.streamStartedAt = info.startedAt;
    state.streamViewers = info.viewers;
  }

  function startStreamPolling(channel, cfg) {
    if (streamPollTimer) { clearInterval(streamPollTimer); streamPollTimer = null; }
    if (!channel) return;
    updateStreamStatus(channel, cfg);
    streamPollTimer = setInterval(() => {
      if (state.channel) updateStreamStatus(state.channel, getConfig());
    }, 30000);
  }

  async function load7TV(channel, channelId) {
    emoteMap = {};
    try {
      const gRes = await fetch('https://7tv.io/v3/emote-sets/global');
      if (gRes.ok) parseEmoteSet(await gRes.json(), emoteMap);
      else console.log('[7TV] Global -> HTTP', gRes.status);
    } catch (e) { console.error('[7TV] Global:', e.message); }

    // Канальный пак: числовой ID в приоритете
    const targets = [];
    if (channelId) targets.push(channelId);
    targets.push(channel);
    for (const t of targets) {
      try {
        const cRes = await fetch(`https://7tv.io/v3/users/twitch/${t}`);
        if (cRes.ok) {
          const data = await cRes.json();
          const before = Object.keys(emoteMap).length;
          if (data.emote_set) parseEmoteSet(data.emote_set, emoteMap);
          if (data.connections) for (const conn of data.connections) {
            if (conn.emote_set) parseEmoteSet(conn.emote_set, emoteMap);
          }
          console.log('[7TV] Channel', t, '-> +', Object.keys(emoteMap).length - before, 'emotes');
          break;
        }
        console.log('[7TV] Channel', t, '-> HTTP', cRes.status);
      } catch (e) { console.error('[7TV] Channel error:', e.message); }
    }
    console.log('[7TV] Emotes total:', Object.keys(emoteMap).length);
  }

  // ==================== WATCHSTREAK: обработчик стриков просмотров ====================
  function handleWatchStreakNotice(msgid, tags) {
    if (!tags) return;
    const msgId = msgid || tags['msg-id'] || '';
    const category = tags['msg-param-category'] || '';
    const sysMsg = (tags['system-msg'] || '').replace(/\\s/g, ' ');

    const isStreak = (
      msgId === 'watchstreak' ||
      msgId.indexOf('watch') !== -1 ||
      (msgId === 'viewermilestone' && category === 'watch-streak') ||
      category === 'watch-streak' ||
      /watch\s*streak|стрим(ов|а)?\s+подряд/i.test(sysMsg)
    );
    if (!isStreak) return;

    const streak = tags['msg-param-value'] || tags['msg-param-streak'] || ((sysMsg.match(/\d+/) || [])[0] || '');
    const uid = tags['user-id'] || null;
    const username = tags['display-name'] || tags.login || tags.username || '?';
    if (tags.color && uid) userColorCache.set(uid, tags.color);

    console.log('[Streak] watchstreak detected:', username, streak, 'months/streams');
    broadcast(JSON.stringify({
      type: 'watchstreak',
      data: {
        userId: uid,
        username,
        color: tags.color || evColor(uid),
        streak: parseInt(streak, 10) || streak || '1',
        message: sysMsg,
        timestamp: Date.now()
      }
    }));
  }

  // ==================== TMI.JS (TWITCH CHAT) ====================

  function connectChat(channel, cfg) {
    if (client) {
      try { client.disconnect(); } catch (e) {}
      client = null;
    }

    state.chatConnected = false;
    channelBadgesLoaded = false;

    client = new tmi.Client({
      connection: { reconnect: true, secure: true },
      channels: [channel]
    });

    client.on('connected', () => {
      state.chatConnected = true;
      state.error = null;
      console.log(`[Chat] Connected to #${channel}`);
    });

    client.on('disconnected', (reason) => {
      state.chatConnected = false;
      state.error = reason;
      console.log('[Chat] Disconnected');
    });

    client.on('message', (ch, tags, message, self) => {
      if (self) return;
      const twitchUserId = tags['user-id'];
      if (tags.color && twitchUserId) userColorCache.set(twitchUserId, tags.color);
      if (eventSubActive && tags['custom-reward-id']) return;
      const roomId = tags['room-id'];

      if (!channelBadgesLoaded && roomId) {
        channelBadgesLoaded = true;
        loadChannelBadges(roomId, cfg);
      }

      state.messages++;

      broadcast(JSON.stringify({
        type: 'chat',
        data: {
          id: tags.id,
          userId: twitchUserId,
          username: tags['display-name'] || tags.username,
          color: tags.color || '#efeff1',
          badges: tags.badges ? Object.entries(tags.badges).map(([name, version]) => ({ name, version })) : [],
          message,
          emotes: parseTwitchEmotes(tags.emotes, message),
          bits: tags.bits || null,
          timestamp: Date.now()
        }
      }));
    });

    // Модерация: удаление одного сообщения по id
    client.on('messagedeleted', (ch, username, deletedMessage, userstate) => {
      const msgId = userstate && (userstate['target-msg-id'] || userstate.id);
      if (msgId) {
        console.log('[Mod] Message deleted:', msgId);
        broadcast(JSON.stringify({ type: 'delete_message', id: msgId }));
      }
    });

    // Модерация: тайм-аут или бан пользователя (удалить все сообщения юзера)
    client.on('clearchat', (ch) => {
      console.log('[Mod] Chat cleared');
      broadcast(JSON.stringify({ type: 'clear_chat' }));
    });

    client.on('timeout', (ch, username) => {
      console.log('[Mod] Timeout user:', username);
      broadcast(JSON.stringify({ type: 'clear_user', username }));
    });

    client.on('ban', (ch, username) => {
      console.log('[Mod] Ban user:', username);
      broadcast(JSON.stringify({ type: 'clear_user', username }));
    });

    // Нативные Twitch usernotice (сабы, ресабы, гифты, стрики)
    client.on('usernotice', (msgid, ch, tags) => {
      const msgId = msgid || (tags && tags['msg-id']) || '';
      if (!msgId) return;

      if (msgId === 'sub' || msgId === 'resub') {
        const uid = tags['user-id'];
        const username = tags['display-name'] || tags.login || '?';
        const months = tags['msg-param-cumulative-months'] || tags['msg-param-months'] || 1;
        const streak = tags['msg-param-streak-months'] || 0;
        const tier = tags['msg-param-sub-plan'] || '1000';
        const msgText = (tags['system-msg'] || '').replace(/\\s/g, ' ');
        if (tags.color && uid) userColorCache.set(uid, tags.color);
        broadcast(JSON.stringify({
          type: msgId === 'resub' ? 'resub' : 'sub',
          data: {
            userId: uid,
            username,
            color: tags.color || evColor(uid),
            tier,
            months,
            streak,
            message: msgText,
            timestamp: Date.now()
          }
        }));
      } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
        const uid = tags['user-id'];
        const isAnon = msgId === 'anonsubgift' || !tags['display-name'];
        const username = isAnon ? 'Аноним' : (tags['display-name'] || tags.login || '?');
        const count = tags['msg-param-mass-gift-count'] || tags['msg-param-gift-months'] || 1;
        const tier = tags['msg-param-sub-plan'] || '1000';
        if (tags.color && uid) userColorCache.set(uid, tags.color);
        broadcast(JSON.stringify({
          type: 'subgift',
          data: {
            userId: uid,
            username,
            color: tags.color || evColor(uid),
            total: count,
            tier,
            timestamp: Date.now()
          }
        }));
      } else {
        handleWatchStreakNotice(msgId, tags);
      }
    });

    client.connect().catch((err) => {
      state.chatConnected = false;
      state.error = err.message || String(err);
      console.error('[Chat]', err);
    });
  }

  function parseTwitchEmotes(emotesTag, message) {
    const result = {};
    if (!emotesTag) return result;
    for (const [id, positions] of Object.entries(emotesTag)) {
      const [start, end] = positions[0].split('-');
      const name = message.substring(parseInt(start, 10), parseInt(end, 10) + 1);
      result[name] = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
    }
    return result;
  }

  // ==================== LIFECYCLE ====================

  let reconnecting = false;
  async function reconnect() {
    if (reconnecting) {
      console.log('[Chat] reconnect already in progress — skip');
      return;
    }
    reconnecting = true;
    try {
      currentConfig = currentConfig || getConfig();
      state.channel = currentConfig.channel || null;
      if (!state.channel) return;
      console.log(`[Chat] Connecting to #${state.channel}...`);
      await getAppToken(currentConfig);
      await loadBadges(currentConfig);
      const channelId = await resolveTwitchUserId(currentConfig, state.channel);
      await load7TV(state.channel, channelId);
      connectChat(state.channel, currentConfig);
      startStreamPolling(state.channel, currentConfig);
      state.emotes = Object.keys(emoteMap).length;
      state.badges = Object.keys(badgeMap).length;
      broadcast(JSON.stringify({ type: 'emotes', data: emoteMap }));
      broadcast(JSON.stringify({ type: 'badges', data: badgeMap }));
    } finally {
      reconnecting = false;
    }
  }

  async function applyConfig(cfg) {
    const portChanged = cfg.port && cfg.port !== state.port;
    currentConfig = cfg;
    saveConfig(cfg);
    if (portChanged) {
      state.port = cfg.port;
      wss.clients.forEach(c => c.terminate());
      await new Promise(r => server.close(r));
      await new Promise(r => server.listen(state.port, r));
      console.log(`[Server] Port -> ${state.port}`);
    }
    await reconnect();
  }

  async function start() {
    currentConfig = getConfig();
    state.port = currentConfig.port || 6767;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(state.port, () => resolve());
    });
    // второй сервер над тем же app — только чтобы коллбек жил на фиксированном порту 6769
    authServer = http.createServer(app);
    authServer.on('error', (e) => console.error('[AuthServer] port ' + AUTH_PORT + ' error:', e.message));
    authServer.listen(AUTH_PORT, () => console.log('[AuthServer] OAuth callback on http://localhost:' + AUTH_PORT + '/auth/callback'));

    state.running = true;
    if (currentConfig.channel) await reconnect();

    // поднимаем редимы, если токен уже сохранён
    userToken = currentConfig.userAccessToken || null;
    userRefresh = currentConfig.userRefreshToken || null;
    userExpiresAt = currentConfig.userTokenExpires || 0;
    broadcasterId = currentConfig.broadcasterId || null;
    broadcasterLogin = currentConfig.broadcasterLogin || null;
    if (userToken && broadcasterId) {
      state.redeemConnected = true;
      state.redeemLogin = broadcasterLogin;
      ensureUserToken()
        .then(ok => { if (ok) startEventSub(getConfig()); else resetRedeem(); })
        .catch(() => resetRedeem());
    }

    return state;
  }

  function getState() {
    return { ...state, obsUrl: `http://localhost:${state.port}` };
  }

  function broadcast(data) {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'emotes', data: emoteMap }));
    ws.send(JSON.stringify({ type: 'badges', data: badgeMap }));
  });

  // Корректное завершение: рвём внешние соединения, а не бросаем их на выходе
  async function shutdown() {
    eventSubStop = true;
    if (streamPollTimer) { clearInterval(streamPollTimer); streamPollTimer = null; }
    if (eventSubWs) { try { eventSubWs.close(); } catch (e) {} eventSubWs = null; }
    if (client) { try { client.disconnect().catch(() => {}); } catch (e) {} client = null; }
    if (authServer) { try { authServer.close(); } catch (e) {} }
    wss.clients.forEach(c => c.terminate());
    try { server.close(); } catch (e) {}
  }

  return { start, reconnect, applyConfig, getState, getConfig, shutdown };
}

module.exports = { createChatServer };

// Режим разработки: node server.js
if (require.main === module) {
  const s = createChatServer();
  s.start()
    .then(st => console.log(`[Server] http://localhost:${st.port}`))
    .catch(e => console.error('[Server] Start failed:', e.message));
}
