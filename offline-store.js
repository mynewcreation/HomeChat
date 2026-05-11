/**
 * ─────────────────────────────────────────────────────────────
 *  offline-store.js  —  MyHome Connect Local Storage Layer
 *
 *  Handles all offline data: cached users, cached channels,
 *  cached messages, outbox queue, and incoming SMS queue.
 *  Works entirely from localStorage — no network needed.
 * ─────────────────────────────────────────────────────────────
 */

const OfflineStore = (function () {

  // ── KEYS ──────────────────────────────────────────────────
  const KEYS = {
    USERS:       'pc_users',
    CHANNELS:    'pc_channels',
    MESSAGES:    'pc_messages_',   // + channelId
    OUTBOX:      'pc_outbox',
    SMS_INBOX:   'pc_sms_inbox',
    LAST_SYNC:   'pc_last_sync',
  };

  // ── HELPERS ───────────────────────────────────────────────
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function nowIso() { return new Date().toISOString(); }

  // ── USERS ─────────────────────────────────────────────────
  function cacheUsers(users) {
    save(KEYS.USERS, users);
  }

  function getCachedUsers() {
    return load(KEYS.USERS, []);
  }

  function getCachedUser(nameLower) {
    return getCachedUsers().find(u => u.nameLower === nameLower) || null;
  }

  function upsertCachedUser(user) {
    const users = getCachedUsers();
    const idx   = users.findIndex(u => u.id === user.id || u.nameLower === user.nameLower);
    if (idx >= 0) users[idx] = { ...users[idx], ...user };
    else          users.push(user);
    save(KEYS.USERS, users);
  }

  function removeCachedUser(userId) {
    const users = getCachedUsers().filter(u => u.id !== userId);
    save(KEYS.USERS, users);
  }

  // ── CHANNELS ──────────────────────────────────────────────
  function cacheChannels(channels) {
    save(KEYS.CHANNELS, channels);
  }

  function getCachedChannels() {
    return load(KEYS.CHANNELS, []);
  }

  function upsertCachedChannel(ch) {
    const channels = getCachedChannels();
    const idx      = channels.findIndex(c => c.id === ch.id);
    if (idx >= 0) channels[idx] = { ...channels[idx], ...ch };
    else          channels.push(ch);
    save(KEYS.CHANNELS, channels);
  }

  // ── MESSAGES ──────────────────────────────────────────────
  function cacheMessages(channelId, msgs) {
    // Keep last 200 messages per channel to avoid storage bloat
    const trimmed = msgs.slice(-200);
    save(KEYS.MESSAGES + channelId, trimmed);
  }

  function getCachedMessages(channelId) {
    return load(KEYS.MESSAGES + channelId, []);
  }

  function appendCachedMessage(channelId, msg) {
    const msgs = getCachedMessages(channelId);
    // avoid duplicates by id
    if (msg.id && msgs.find(m => m.id === msg.id)) return;
    msgs.push(msg);
    cacheMessages(channelId, msgs);
  }

  // ── OUTBOX (messages typed while offline) ─────────────────
  function addToOutbox(channelId, msg) {
    const outbox = load(KEYS.OUTBOX, []);
    outbox.push({ channelId, msg, queuedAt: nowIso() });
    save(KEYS.OUTBOX, outbox);
  }

  function getOutbox() {
    return load(KEYS.OUTBOX, []);
  }

  function clearOutbox() {
    save(KEYS.OUTBOX, []);
  }

  function removeFromOutbox(index) {
    const outbox = load(KEYS.OUTBOX, []);
    outbox.splice(index, 1);
    save(KEYS.OUTBOX, outbox);
  }

  // ── SMS INBOX (SMS received while offline / from bridge) ──
  function addSmsMessage(channelId, msg) {
    const inbox = load(KEYS.SMS_INBOX, []);
    inbox.push({ channelId, msg, receivedAt: nowIso() });
    save(KEYS.SMS_INBOX, inbox);
    // also append to channel message cache
    appendCachedMessage(channelId, msg);
  }

  function getSmsInbox() {
    return load(KEYS.SMS_INBOX, []);
  }

  function clearSmsInbox() {
    save(KEYS.SMS_INBOX, []);
  }

  // ── SYNC TIMESTAMP ────────────────────────────────────────
  function setLastSync() {
    save(KEYS.LAST_SYNC, nowIso());
  }

  function getLastSync() {
    return load(KEYS.LAST_SYNC, null);
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    cacheUsers, getCachedUsers, getCachedUser, upsertCachedUser, removeCachedUser,
    cacheChannels, getCachedChannels, upsertCachedChannel,
    cacheMessages, getCachedMessages, appendCachedMessage,
    addToOutbox, getOutbox, clearOutbox, removeFromOutbox,
    addSmsMessage, getSmsInbox, clearSmsInbox,
    setLastSync, getLastSync,
  };

})();
