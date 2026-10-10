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
    error: null,
    redeemConnected: false,
    redeemLogin: null,
    eventSubActive: false,
    daConnected: false,
    daLogin: null
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
    // --- DonationAlerts: OAuth + Centrifugo ---
  const DA_API = 'https://www.donationalerts.com/api/v1';
  const DA_REDIRECT_URI = 'http://localhost:' + AUTH_PORT + '/da/callback';
  const DA_SCOPE = 'oauth-user-show oauth-donation-subscribe';
  let daToken = null;
  let daRefresh = null;
  let daExpiresAt = 0;
  let daUserId = null;
  let daUserName = null;
  let daWs = null;
  let daStop = false;
  let pendingDaState = null;
  let daReconnectTimer = null;
  let daReconnectDelay = 4000;
  const DA_RECONNECT_MAX = 60000;

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
      pointsName: cfg.pointsName || '',
      daClientId: cfg.daClientId || '',
      daClientSecret: cfg.daClientSecret ? '••••••••' + cfg.daClientSecret.slice(-4) : ''
    });
  });

  app.post('/api/config', (req, res) => {
    const old = getConfig();
    const { channel, clientId, clientSecret, port, pointsName, daClientId, daClientSecret } = req.body;
    if (!channel || !channel.trim()) return res.status(400).json({ error: 'channel required' });

    const clean = channel.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
    const finalSecret = (clientSecret && !clientSecret.startsWith('••••'))
      ? clientSecret.trim() : (old.clientSecret || '');

    const newCfg = {
      channel: clean,
      clientId: (clientId || old.clientId || '').trim(),
      clientSecret: finalSecret,
      port: parseInt(port) || old.port || 6767,
      pointsName: (pointsName || '').trim(),
      daClientId: (daClientId || old.daClientId || '').trim(),
      daClientSecret: (daClientSecret && !daClientSecret.startsWith('••••'))
        ? daClientSecret.trim() : (old.daClientSecret || ''),
      // токены редимов и DA не приходят с формы — переносим, чтобы не потерять
      userAccessToken: old.userAccessToken,
      userRefreshToken: old.userRefreshToken,
      userTokenExpires: old.userTokenExpires,
      broadcasterId: old.broadcasterId,
      broadcasterLogin: old.broadcasterLogin,
      daAccessToken: old.daAccessToken,
      daRefreshToken: old.daRefreshToken,
      daExpiresAt: old.daExpiresAt,
      daUserId: old.daUserId,
      daUserName: old.daUserName
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
    bg: true,
    hide: true,
    hideAfter: 30000,
    points: '',
    emote: 20
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
      font: typeof b.font === 'string' ? b.font : old.font,
      size: parseInt(b.size, 10) > 0 ? parseInt(b.size, 10) : old.size,
      bg: typeof b.bg === 'boolean' ? b.bg : old.bg,
      hide: typeof b.hide === 'boolean' ? b.hide : old.hide,
      hideAfter: parseInt(b.hideAfter, 10) > 0 ? parseInt(b.hideAfter, 10) : old.hideAfter,
      points: typeof b.points === 'string' ? b.points : old.points,
      emote: parseInt(b.emote, 10) > 0 ? parseInt(b.emote, 10) : old.emote
    };
    const cfg = getConfig();
    cfg.style = next;
    saveConfig(cfg);
    console.log('[Style] saved + broadcast');
    // вещаем всем WS-клиентам (OBS, предпросмотр) — стиль применяется мгновенно, без перезагрузки страницы
    broadcast(JSON.stringify({ type: 'style', data: next }));
    res.json({ ok: true, style: next });
  });
  app.use(express.static(publicDir));

    // ==================== REDEEMS: OAuth + EventSub ====================

  app.get('/api/redeem-status', (req, res) => {
    const cfg = getConfig();
    res.json({
      connected: state.redeemConnected,
      login: state.redeemLogin,
      eventSubActive: state.eventSubActive,
      canAuth: !!(cfg.clientId && cfg.clientSecret),
      daConnected: state.daConnected,
      daLogin: state.daLogin,
      canDaAuth: !!(cfg.daClientId && cfg.daClientSecret)
    });
  });

  // --- SSE: сервер сам пушит изменения статуса, поллинг не нужен ---
  const sseClients = new Set();
  function redeemStatusPayload() {
    const cfg = getConfig();
    return {
      connected: state.redeemConnected,
      login: state.redeemLogin,
      eventSubActive: state.eventSubActive,
      canAuth: !!(cfg.clientId && cfg.clientSecret),
      daConnected: state.daConnected,
      daLogin: state.daLogin,
      canDaAuth: !!(cfg.daClientId && cfg.daClientSecret)
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
    if (!cfg.clientId) return res.status(400).send('Сначала укажите Client ID в настройках.');
    pendingAuthState = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const url =
      'https://id.twitch.tv/oauth2/authorize' +
      '?response_type=code' +
      '&client_id=' + encodeURIComponent(cfg.clientId) +
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

  // ==================== DONATIONALERTS ====================

  app.get('/da/auth/start', (req, res) => {
    const cfg = getConfig();
    if (!cfg.daClientId) return res.status(400).send('Сначала укажите Client ID DonationAlerts в настройках.');
    pendingDaState = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const url =
      'https://www.donationalerts.com/oauth/authorize' +
      '?response_type=code' +
      '&client_id=' + encodeURIComponent(cfg.daClientId) +
      '&redirect_uri=' + encodeURIComponent(DA_REDIRECT_URI) +
      '&scope=' + encodeURIComponent(DA_SCOPE) +
      '&state=' + encodeURIComponent(pendingDaState);
    res.redirect(url);
  });

  app.get('/da/callback', async (req, res) => {
    const code = req.query.code;
    const st = req.query.state;
    const err = req.query.error;
    if (err) return res.status(400).send(htmlPage('Ошибка DonationAlerts', 'DA вернул: ' + err));
    if (!code || st !== pendingDaState) {
      return res.status(400).send(htmlPage('Ошибка', 'Неверный state или отсутствует код DA. Попробуйте ещё раз.'));
    }
    pendingDaState = null;
    try {
      const cfg = getConfig();
      const r = await fetch('https://www.donationalerts.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: cfg.daClientId,
          client_secret: cfg.daClientSecret,
          redirect_uri: DA_REDIRECT_URI,
          code
        }).toString()
      });
      const data = await r.json();
      if (!data.access_token) throw new Error('DA exchange: ' + (data.message || JSON.stringify(data)));
      daToken = data.access_token;
      daRefresh = data.refresh_token || null;
      daExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

      const u = await fetch(DA_API + '/user/oauth', { headers: daHeaders() }).then(x => x.json());
      if (!u || !u.data || !u.data.id) throw new Error('DA user: нет id');
      daUserId = u.data.id;
      daUserName = u.data.name || u.data.code || null;

      const save = getConfig();
      save.daAccessToken = daToken;
      save.daRefreshToken = daRefresh;
      save.daExpiresAt = daExpiresAt;
      save.daUserId = daUserId;
      save.daUserName = daUserName;
      saveConfig(save);

      state.daLogin = daUserName;
      notifyRedeemStatus();
      console.log('[DA] Authorized as', daUserName, '(' + daUserId + ')');
      startDA();
      res.send(htmlPage('Готово', 'DonationAlerts подключены для <b>' + esc(daUserName || '') + '</b>. Эту вкладку можно закрыть.'));
    } catch (e) {
      console.error('[DA] callback error:', e.message);
      res.status(500).send(htmlPage('Ошибка подключения DA', e.message));
    }
  });

  function daHeaders() {
    return { 'Authorization': 'Bearer ' + daToken, 'Accept': 'application/json' };
  }

  async function ensureDaToken() {
    if (!daToken) return false;
    if (Date.now() < daExpiresAt - 60000) return true;
    if (!daRefresh) return false;
    try {
      const cfg = getConfig();
      const r = await fetch('https://www.donationalerts.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: cfg.daClientId,
          client_secret: cfg.daClientSecret,
          refresh_token: daRefresh
        }).toString()
      });
      const data = await r.json();
      if (!data.access_token) throw new Error('DA refresh: ' + (data.message || 'no token'));
      daToken = data.access_token;
      if (data.refresh_token) daRefresh = data.refresh_token;
      daExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      const save = getConfig();
      save.daAccessToken = daToken;
      save.daRefreshToken = daRefresh;
      save.daExpiresAt = daExpiresAt;
      saveConfig(save);
      return true;
    } catch (e) {
      console.error('[DA] token unusable:', e.message);
      return false;
    }
  }

  function startDA() {
    daStop = false;
    if (daWs) {
      const old = daWs;
      daWs = null;
      try { old.removeAllListeners && old.removeAllListeners(); } catch (e) {}
      try { old.close(); } catch (e) {}
    }
    connectDA();
  }
  function stopDA() {
    daStop = true;
    if (daWs) { try { daWs.close(); } catch (e) {} daWs = null; }
  }
  function resetDA() {
    stopDA();
    daToken = null; daRefresh = null; daExpiresAt = 0; daUserId = null; daUserName = null;
    state.daConnected = false; state.daLogin = null;
    notifyRedeemStatus();
    const save = getConfig();
    delete save.daAccessToken; delete save.daRefreshToken; delete save.daExpiresAt;
    delete save.daUserId; delete save.daUserName;
    saveConfig(save);
  }
  function scheduleDaReconnect() {
    if (daStop || daReconnectTimer) return;
    daReconnectTimer = setTimeout(() => { daReconnectTimer = null; connectDA(); }, daReconnectDelay);
    daReconnectDelay = Math.min(daReconnectDelay * 2, DA_RECONNECT_MAX);
  }
  function resetDaReconnect() { daReconnectDelay = 4000; }

  // Centrifugo: connect -> subscribe(HTTP) -> subscribe(WS) -> слушаем донаты
  async function connectDA() {
    if (daStop) return;
    if (!(await ensureDaToken())) { resetDA(); return; }
    let user = null;
    try { user = await fetch(DA_API + '/user/oauth', { headers: daHeaders() }).then(r => r.json()); } catch (e) {}
    const socketToken = user && user.data && user.data.socket_connection_token;
    if (!user || !user.data || !socketToken) { scheduleDaReconnect(); return; }
    daUserId = user.data.id;
    daUserName = user.data.name || user.data.code || daUserName;

    let ws;
    try { ws = new WebSocket('wss://centrifugo.donationalerts.com/connection/websocket'); }
    catch (e) { console.error('[DA] ws create error:', e.message); scheduleDaReconnect(); return; }
    daWs = ws;

    ws.on('open', () => {
      console.log('[DA] centrifugo socket open');
      ws.send(JSON.stringify({ id: 1, params: { token: socketToken } }));
    });

    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.id === 1 && m.result && m.result.client) {
        const channel = '$alerts:donation_' + daUserId;
        let sub = null;
        try {
          sub = await fetch(DA_API + '/centrifuge/subscribe', {
            method: 'POST',
            headers: { ...daHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ client: m.result.client, channels: [channel] })
          }).then(r => r.json());
        } catch (e) {}
        const ch = sub && Array.isArray(sub.channels) && sub.channels.find(c => c.channel === channel);
        if (!ch || !ch.token) {
          console.error('[DA] subscription token not received');
          try { ws.close(); } catch (e) {}
          return;
        }
        ws.send(JSON.stringify({ id: 2, method: 1, params: { channel: channel, token: ch.token } }));
        state.daConnected = true;
        state.daLogin = daUserName || String(daUserId);
        notifyRedeemStatus();
        resetDaReconnect();
        console.log('[DA] subscribed to', channel);
      } else if (m.result && m.result.data && m.result.data.data) {
        handleDaDonation(m.result.data.data);
      }
    });

    ws.on('close', () => {
      console.log('[DA] socket closed');
      state.daConnected = false;
      notifyRedeemStatus();
      if (daWs === ws) daWs = null;
      if (!daStop) scheduleDaReconnect();
    });
    ws.on('error', (e) => console.error('[DA] ws error:', e.message));
  }

  function handleDaDonation(d) {
    if (d.id) {
      if (recentDonationIds.has(d.id)) {
        console.log('[DA] duplicate donation skipped:', d.id);
        return;
      }
      recentDonationIds.set(d.id, true);
    }
    console.log('[DA] donation:', d.id, '|', d.username, '|', d.amount, d.currency);
    broadcast(JSON.stringify({
      type: 'donation',
      data: {
        id: d.id,
        username: d.username || 'Аноним',
        amount: d.amount,
        currency: d.currency || '',
        message: d.message || '',
        timestamp: Date.now()
      }
      
    }));
    
  }  
  
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
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
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
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
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
    const r = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': cfg.clientId, 'Authorization': 'Bearer ' + userToken }
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
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX); // 4 → 8 → 16 → ... → 60
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
    for (const [type, version] of EVENTSUB_TYPES) {
      const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-Id': cfg.clientId,
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
        // 403 = не хватает скоупа (пользователь не переавторизовался) — логируем и идём дальше
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

  const recentEventIds = makeLRU(500); // EventSub at-least-once: режем дубли по message_id
  const recentDonationIds = makeLRU(200); // DA at-least-once: режем дубли по id доната
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
    if (!cfg.clientId || !cfg.clientSecret) return;
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
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
    return { 'Client-Id': cfg.clientId, 'Authorization': `Bearer ${appToken}` };
  }

  function parseHelixBadges(data) {
    for (const set of data.data) {
      for (const v of set.versions) {
        badgeMap[`${set.set_id}/${v.id}`] = v.image_url_1x || v.image_url_2x;
      }
    }
  }

  async function loadBadges(cfg) {
    if (!appToken) return;
    try {
      const res = await fetch('https://api.twitch.tv/helix/chat/badges/global', { headers: helixHeaders(cfg) });
      if (res.ok) {
        badgeMap = {};
        parseHelixBadges(await res.json());
        console.log(`[Badges] Global: ${Object.keys(badgeMap).length}`);
      }
    } catch (e) { console.error('[Badges]', e.message); }
  }

  async function loadChannelBadges(roomId, cfg) {
    if (!appToken) return;
    try {
      const res = await fetch(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${roomId}`, { headers: helixHeaders(cfg) });
      if (res.ok) {
        parseHelixBadges(await res.json());
        console.log(`[Badges] Channel: total ${Object.keys(badgeMap).length}`);
        broadcast(JSON.stringify({ type: 'badges', data: badgeMap }));
        state.badges = Object.keys(badgeMap).length;
      }
    } catch (e) { console.error('[Badges]', e.message); }
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
    if (!file) return null;   // avif-только эмодзи в OBS не декодируются — пусть будут текстом, чем битой картинкой
    return { url: `${base}/${file.name}`, width: file.width || 28, height: file.height || 28 };
  }

  function parseEmoteSet(set, target) {
    if (!set || !set.emotes) return;
    for (const emote of set.emotes) {
      const info = buildEmoteUrl(emote.data?.host);
      if (info) target[emote.name] = info;
    }
  }
  // 7TV REST понимает только числовой Twitch-ID — резолвим логин через Helix
  async function resolveTwitchUserId(cfg, login) {
    if (!appToken) return null;
    try {
      const res = await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), { headers: helixHeaders(cfg) });
      if (!res.ok) { console.log('[Helix] users?login', login, '-> HTTP', res.status); return null; }
      const data = await res.json();
      return data.data && data.data[0] ? data.data[0].id : null;
    } catch (e) { console.error('[Helix] users error:', e.message); return null; }
  }

   async function load7TV(channel, channelId) {
    emoteMap = {};
    try {
      const gRes = await fetch('https://7tv.io/v3/emote-sets/global');
      if (gRes.ok) parseEmoteSet(await gRes.json(), emoteMap);
      else console.log('[7TV] Global -> HTTP', gRes.status);
    } catch (e) { console.error('[7TV] Global:', e.message); }

    // Канальный пак: основной путь — числовой ID, логин только как запасной
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

  // ==================== WATCHSTREAK: IRC sidecar через WebSocket ====================
  // Сырой TLS 6697 у Twitch отдаёт чужой сертификат; рабочий транспорт —
  // тот же, что использует tmi.js: wss://irc-ws.chat.twitch.tv:443
  let ircRawSocket = null;
  let ircRawStop = false;

  function startWatchStreakListener(channel) {
    ircRawStop = false;
    if (ircRawSocket) { 
      ircRawSocket.removeAllListeners();
      try { ircRawSocket.close(); } catch (e) {} 
      ircRawSocket = null; }
    const nick = 'justinfan' + Math.floor(10000 + Math.random() * 80000);
    let sock;
    try { sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); }
    catch (e) { console.error('[IRC-raw] ws create error:', e.message); return; }
    ircRawSocket = sock;
    sock.on('open', () => {
      sock.send('CAP REQ :twitch.tv/tags');
      sock.send('PASS SCHMOOPIIE');
      sock.send('NICK ' + nick);
      sock.send('JOIN #' + channel);
      console.log('[IRC-raw] connected for #' + channel);
    });
    sock.on('message', (raw) => handleIrcRawLine(String(raw)));
    sock.on('error', (e) => console.error('[IRC-raw] error:', e.message));
    sock.on('close', () => {
      if (ircRawSocket === sock) ircRawSocket = null;
      if (!ircRawStop) setTimeout(() => { if (!ircRawStop && state.channel) startWatchStreakListener(state.channel); }, 5000);
    });
  }

  function handleIrcRawLine(line) {
    if (!line) return;
    if (line.indexOf('PING') === 0) {
      try { ircRawSocket.send('PONG :tmi.twitch.tv'); } catch (e) {}
      return;
    }
    if (line.indexOf('USERNOTICE') === -1) return;
    const tags = {};
    let rest = line;
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      for (const kv of rest.slice(1, sp).split(';')) {
        const eq = kv.indexOf('=');
        if (eq !== -1) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    const msgId = tags['msg-id'] || '';
    const sysMsg = (tags['system-msg'] || '').replace(/\\s/g, ' ');
    if (!(msgId === 'watchstreak' || msgId.indexOf('watch') !== -1 || /watch streak/i.test(sysMsg))) return;
    const streak = tags['msg-param-streak'] || ((sysMsg.match(/\d+/) || [])[0] || '');
    const uid = tags['user-id'] || null;
    broadcast(JSON.stringify({
      type: 'watchstreak',
      data: {
        userId: uid,
        username: tags['display-name'] || tags['login'] || '?',
        color: (uid && userColorCache.get(uid)) || '#efeff1',
        streak,
        text: sysMsg,
        timestamp: Date.now()
      }
    }));
    console.log('[WatchStreak]', tags['display-name'] || tags['login'], '| streak:', streak);
  }


  // ==================== CHAT ====================

  function connectChat(channel, cfg) {
    if (client) {
      const old = client;
      client = null;
      // сначала снимаем ВСЕ слушатели: даже если зомби-сокет доживёт,
      // он больше ничего не пришлёт в broadcast
      try { old.removeAllListeners(); } catch (e) {}
      old.disconnect().catch(() => {});
    }
    channelBadgesLoaded = false;
    state.chatConnected = false;

    client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      channels: [channel]
    });

    client.on('connected', () => {
      state.chatConnected = true;
      state.startedAt = Date.now();
      state.error = null;
      console.log(`[Chat] Connected to #${channel}`);
    });

    client.on('disconnected', () => {
      state.chatConnected = false;
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
          bits: parseInt(tags.bits) || 0,
          redeem: !!tags['custom-reward-id'],
          timestamp: Date.now()
        }
      }));
    });

    client.connect().catch(err => {
      state.error = 'IRC: ' + (err.message || err);
      console.error('[Chat]', err);
    });
  }

  function parseTwitchEmotes(emotesTag, message) {
    const result = {};
    if (!emotesTag) return result;
    for (const [id, positions] of Object.entries(emotesTag)) {
      const [start, end] = positions[0].split('-');
      const name = message.substring(parseInt(start), parseInt(end) + 1);
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
      startWatchStreakListener(state.channel);
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

    // поднимаем DonationAlerts, если токен уже сохранён
    daToken = currentConfig.daAccessToken || null;
    daRefresh = currentConfig.daRefreshToken || null;
    daExpiresAt = currentConfig.daExpiresAt || 0;
    daUserId = currentConfig.daUserId || null;
    daUserName = currentConfig.daUserName || null;
    if (daToken && daUserId) {
      state.daLogin = daUserName;
      startDA();
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
    ircRawStop = true;
    if (ircRawSocket) { try { ircRawSocket.close(); } catch (e) {} ircRawSocket = null; }
    stopDA();
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