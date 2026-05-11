// AUTH GUARD
(function() {
  if (!sessionStorage.getItem('teamsUser')) window.location.href = 'index.html';
})();

// ── NETWORK HELPERS ──────────────────────────────────────────
function isOnline() { return navigator.onLine; }

// ── OFFLINE SMS POLLING ──────────────────────────────────────
// Polls the local SMS bridge server for new messages when on LAN
const SMS_BRIDGE_URL = 'http://localhost:3000';
let smsPollTimer = null;

function startSmsPoll() {
  if (smsPollTimer) return;
  smsPollTimer = setInterval(fetchSmsFromBridge, 5000);
  fetchSmsFromBridge(); // immediate first fetch
}

function stopSmsPoll() {
  clearInterval(smsPollTimer);
  smsPollTimer = null;
}

async function fetchSmsFromBridge() {
  try {
    const res  = await fetch(SMS_BRIDGE_URL + '/log?limit=20', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    if (!Array.isArray(data)) return;

    const seen = JSON.parse(localStorage.getItem('pc_seen_sms') || '[]');
    let changed = false;

    data.forEach(function(entry) {
      if (seen.includes(entry.id)) return;
      seen.push(entry.id);
      changed = true;

      const channelId = entry.channel || state.currentChannel;
      const msg = {
        id:        'sms-' + entry.id,
        sender:    '📱 SMS (' + entry.from + ')',
        color:     '#e67e22',
        text:      escapeHtml(entry.text || ''),
        time:      new Date(entry.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: { toDate: function() { return new Date(entry.receivedAt); } },
        reactions: [],
        viaSms:    true,
        smsFrom:   entry.from,
        offline:   true,
      };

      // Store in offline cache
      OfflineStore.addSmsMessage(channelId, msg);

      // If this channel is currently open, append live
      if (channelId === state.currentChannel) {
        const area = document.getElementById('messagesArea');
        appendMessageEl(area, msg);
        area.scrollTop = area.scrollHeight;
        showSmsToast(entry.from, entry.text);
      } else {
        // Unread badge
        state.unread[channelId] = (state.unread[channelId] || 0) + 1;
        renderChannels();
        updateTabTitle();
        showSmsToast(entry.from, entry.text);
      }
    });

    if (changed) {
      // Keep seen list to last 500 entries
      if (seen.length > 500) seen.splice(0, seen.length - 500);
      localStorage.setItem('pc_seen_sms', JSON.stringify(seen));
    }
  } catch (e) {
    // Bridge not reachable — silent fail
  }
}

function showSmsToast(from, text) {
  let toast = document.getElementById('smsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'smsToast';
    toast.className = 'sms-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '<strong>📱 SMS from ' + escapeHtml(from) + '</strong><br>' + escapeHtml((text || '').slice(0, 80));
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 4000);
}

// STATE
const state = {
  currentChannel: 'general',
  currentUser: {},
  unread: {},
  msgCount: {},
  unsubscribeMessages: null,
  unsubscribeUsers: null,
  typingTimer: null,
  isOffline: false,
  quoteMsg: null,          // currently quoted message
};

// BASE CHANNELS — empty, all channels are created by users
const channels = [];

// INIT
document.addEventListener('DOMContentLoaded', async () => {
  state.currentUser = JSON.parse(sessionStorage.getItem('teamsUser'));
  state.isOffline   = !isOnline() || !!state.currentUser.isOfflineSession;

  document.getElementById('myName').textContent        = state.currentUser.name;
  document.getElementById('myAvatar').textContent      = state.currentUser.name[0].toUpperCase();
  document.getElementById('myAvatar').style.background = state.currentUser.color;
  updateStatusDisplay(state.currentUser.status);

  // Show offline session badge if needed
  if (state.currentUser.isOfflineSession) {
    showOfflineSessionBanner();
  }

  await loadChannelMeta();
  renderChannels();

  if (channels.length > 0) {
    loadChannel(channels[0].id);
  } else {
    document.getElementById('channelTitle').textContent = 'No channels yet';
    document.getElementById('channelDesc').textContent  = 'Click + Add Channel to get started';
    document.getElementById('messagesArea').innerHTML   =
      '<div style="text-align:center;color:#aaa;margin-top:60px;font-size:14px;">No channels yet.<br>Click <strong>+ Add Channel</strong> to create one.</div>';
  }

  // Users listener — graceful offline fallback
  if (isOnline()) {
    state.unsubscribeUsers = db.collection('users').orderBy('name')
      .onSnapshot(function(snap) {
        const users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
        OfflineStore.cacheUsers(users);
        renderDMs(users);
        renderMembers(users);
      });
  } else {
    const cached = OfflineStore.getCachedUsers();
    renderDMs(cached);
    renderMembers(cached);
  }

  window.addEventListener('beforeunload', markOffline);

  // Online / offline banner + sync
  function handleOnlineChange() {
    const online = isOnline();
    state.isOffline = !online;
    updateOfflineBanner(online);
    if (online) {
      syncOutbox();
      // Reload channel from Firestore now that we're back
      loadChannel(state.currentChannel);
      // Re-subscribe users
      if (!state.unsubscribeUsers) {
        state.unsubscribeUsers = db.collection('users').orderBy('name')
          .onSnapshot(function(snap) {
            const users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
            OfflineStore.cacheUsers(users);
            renderDMs(users);
            renderMembers(users);
          });
      }
    } else {
      if (state.unsubscribeUsers) { state.unsubscribeUsers(); state.unsubscribeUsers = null; }
    }
  }

  window.addEventListener('online',  handleOnlineChange);
  window.addEventListener('offline', handleOnlineChange);
  updateOfflineBanner(isOnline());

  // Always poll SMS bridge (works on LAN regardless of internet)
  startSmsPoll();
});


// OFFLINE BANNER + SESSION BANNER
function updateOfflineBanner(online) {
  const banner = document.getElementById('offlineBanner');
  if (online && !state.currentUser.isOfflineSession) {
    banner.style.display = 'none';
  } else {
    banner.style.display = 'block';
    banner.innerHTML = online
      ? '🔄 Back online — syncing messages...'
      : '📡 You are offline — SMS still works via local bridge. Messages will sync when reconnected.';
    banner.style.background = online ? '#27ae60' : '#e67e22';
  }
}

function showOfflineSessionBanner() {
  const banner = document.getElementById('offlineBanner');
  banner.style.display = 'block';
  banner.style.background = '#8e44ad';
  banner.innerHTML = '🔒 Offline session — SMS inbox active. Outgoing messages queued until reconnected.';
}

// OUTBOX SYNC — flush queued messages to Firestore when back online
async function syncOutbox() {
  const outbox = OfflineStore.getOutbox();
  if (!outbox.length) return;

  let synced = 0;
  for (let i = outbox.length - 1; i >= 0; i--) {
    const item = outbox[i];
    try {
      await db.collection('channels').doc(item.channelId).collection('messages').add({
        sender:    item.msg.sender,
        color:     item.msg.color,
        text:      item.msg.text,
        time:      item.msg.time,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        reactions: [],
      });
      OfflineStore.removeFromOutbox(i);
      synced++;
    } catch (e) {
      // leave in outbox, try next time
    }
  }

  if (synced > 0) {
    showSyncToast(synced + ' queued message' + (synced > 1 ? 's' : '') + ' synced ✓');
  }
}

function showSyncToast(msg) {
  let toast = document.getElementById('syncToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'syncToast';
    toast.className = 'sync-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 3500);
}
async function loadChannelMeta() {
  if (isOnline()) {
    try {
      const snap = await db.collection('channelMeta').get();
      snap.docs.forEach(function(d) {
        const data     = d.data();
        const existing = channels.find(function(c) { return c.id === d.id; });
        if (existing) {
          if (data.label) existing.label = data.label;
          if (data.desc)  existing.desc  = data.desc;
        } else {
          channels.push({ id: d.id, label: data.label || ('# ' + d.id), desc: data.desc || '', custom: true });
        }
      });
      OfflineStore.cacheChannels(channels.map(function(c) { return Object.assign({}, c); }));
    } catch (e) {
      loadChannelMetaFromCache();
    }
  } else {
    loadChannelMetaFromCache();
  }
}

function loadChannelMetaFromCache() {
  const cached = OfflineStore.getCachedChannels();
  cached.forEach(function(ch) {
    if (!channels.find(function(c) { return c.id === ch.id; })) {
      channels.push(ch);
    }
  });
}

// RENDER CHANNELS
function renderChannels(filter) {
  filter = filter || '';
  const list = document.getElementById('channelList');
  list.innerHTML = '';
  channels
    .filter(function(c) { return c.label.toLowerCase().includes(filter.toLowerCase()); })
    .forEach(function(c) {
      const div = document.createElement('div');
      div.className = 'channel-item' + (c.id === state.currentChannel ? ' active' : '');

      const labelSpan = document.createElement('span');
      labelSpan.textContent = c.label;
      labelSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      labelSpan.onclick = function() { loadChannelAndCloseSidebar(c.id); };

      const menuBtn = document.createElement('span');
      menuBtn.className = 'ch-menu-btn';
      menuBtn.textContent = '...';
      menuBtn.title = 'Options';
      menuBtn.onclick = function(e) { openChannelCtxMenu(e, c.id); };

      div.appendChild(labelSpan);

      const unread = state.unread[c.id] || 0;
      if (unread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = unread;
        div.appendChild(badge);
      }

      div.appendChild(menuBtn);
      list.appendChild(div);
    });
}

// RENDER DMs
function renderDMs(users, filter) {
  filter = filter || '';
  const list = document.getElementById('dmList');
  list.innerHTML = '';
  users
    .filter(function(u) { return u.name !== state.currentUser.name; })
    .filter(function(u) { return u.name.toLowerCase().includes(filter.toLowerCase()); })
    .forEach(function(u) {
      const dmId = dmChannelId(state.currentUser.name, u.name);
      const div  = document.createElement('div');
      div.className = 'channel-item' + (dmId === state.currentChannel ? ' active' : '');
      div.onclick   = function() { loadChannelAndCloseSidebar(dmId, u.name, 'Direct message with ' + u.name); };
      const dot     = '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor(u.status) + ';display:inline-block;flex-shrink:0"></span>';
      const unread  = state.unread[dmId] || 0;
      div.innerHTML = dot + '<span>' + u.name + '</span>' + (unread ? '<span class="badge">' + unread + '</span>' : '');
      list.appendChild(div);
    });
}

function dmChannelId(a, b) {
  return 'dm-' + [a, b].sort().join('-').toLowerCase().replace(/[\s.]+/g, '_');
}

// RENDER MEMBERS
function renderMembers(users) {
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  users.forEach(function(u) {
    const div = document.createElement('div');
    div.className = 'member-item';
    div.innerHTML =
      '<div class="user-avatar" style="background:' + u.color + ';width:30px;height:30px;font-size:12px">' + u.name[0] + '</div>' +
      '<span style="flex:1">' + u.name + '</span>' +
      '<span class="dot ' + (u.status || 'offline') + '"></span>';
    list.appendChild(div);
  });
}

// LOAD CHANNEL
function loadChannel(id, title, desc) {
  if (state.unsubscribeMessages) { state.unsubscribeMessages(); state.unsubscribeMessages = null; }

  closeConvSearch();

  state.currentChannel = id;
  state.unread[id]     = 0;
  updateTabTitle();

  const ch = channels.find(function(c) { return c.id === id; });
  document.getElementById('channelTitle').textContent = title || (ch ? ch.label : id);
  document.getElementById('channelDesc').textContent  = desc  || (ch ? ch.desc  || '' : '');

  renderChannels();

  if (!isOnline()) {
    // ── OFFLINE: render from cache + SMS inbox ──────────────
    const cached = OfflineStore.getCachedMessages(id);
    renderMessages(cached);
    renderOutboxPending(id);
    return;
  }

  // ── ONLINE: Firestore live listener ────────────────────────
  state.unsubscribeMessages = db
    .collection('channels').doc(id).collection('messages')
    .orderBy('timestamp')
    .onSnapshot(function(snap) {
      var msgs = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      var newCount = msgs.length;
      var oldCount = state.msgCount[id] !== undefined ? state.msgCount[id] : newCount;

      if (newCount > oldCount) {
        var added    = newCount - oldCount;
        var newMsgs  = msgs.slice(msgs.length - added);
        var fromOthers = newMsgs.filter(function(m) { return m.sender !== state.currentUser.name; });

        if (fromOthers.length > 0) {
          if (id !== state.currentChannel) {
            state.unread[id] = (state.unread[id] || 0) + fromOthers.length;
            renderChannels();
            updateTabTitle();
          }
          // Browser notification for messages in any channel when window not focused
          fromOthers.forEach(function(m) {
            var chLabel = (channels.find(function(c) { return c.id === id; }) || {}).label || id;
            showBrowserNotification(
              m.sender + ' in ' + chLabel,
              (m.text || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').slice(0, 80),
              id
            );
            // In-app toast for background channels
            if (id !== state.currentChannel) {
              showNotifToast(m.sender + ' in ' + chLabel, (m.text || '').slice(0, 80));
            }
          });
        }
      }

      state.msgCount[id] = newCount;
      // Cache for offline use
      OfflineStore.cacheMessages(id, msgs);
      renderMessages(msgs);
    });
}

// Show pending outbox messages with a "pending" indicator
function renderOutboxPending(channelId) {
  const outbox = OfflineStore.getOutbox().filter(function(o) { return o.channelId === channelId; });
  if (!outbox.length) return;
  const area = document.getElementById('messagesArea');
  outbox.forEach(function(item) {
    const pendingMsg = Object.assign({}, item.msg, { pending: true });
    appendMessageEl(area, pendingMsg);
  });
  area.scrollTop = area.scrollHeight;
}

// RENDER MESSAGES
function msgDateLabel(msg) {
  // timestamp may be a Firestore Timestamp or null (pending write)
  var d = msg.timestamp && msg.timestamp.toDate ? msg.timestamp.toDate() : new Date();
  var today     = new Date();
  var yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  var toKey  = function(dt) { return dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate(); };
  if (toKey(d) === toKey(today))     return 'Today';
  if (toKey(d) === toKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function renderMessages(msgs) {
  var area = document.getElementById('messagesArea');
  var wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
  area.innerHTML = '';

  if (!msgs || msgs.length === 0) {
    area.innerHTML = '<div style="text-align:center;color:#aaa;margin-top:40px;font-size:14px;">No messages yet. Say hello!</div>';
    return;
  }

  var lastLabel = null;
  msgs.forEach(function(msg) {
    var label = msgDateLabel(msg);
    if (label !== lastLabel) {
      area.appendChild(makeDateDivider(label));
      lastLabel = label;
    }
    appendMessageEl(area, msg);
  });
  if (wasAtBottom) area.scrollTop = area.scrollHeight;
}

function appendMessageEl(area, msg) {
  const isMine  = msg.sender === state.currentUser.name;
  const isViaSms = !!msg.viaSms;
  const group   = document.createElement('div');
  group.className = 'msg-group' + (isMine ? ' mine' : '') + (isViaSms ? ' sms-msg' : '');
  if (msg.id) group.dataset.msgId = msg.id;

  // SMS messages get a phone avatar; regular users get their initial
  const avatarInner = isViaSms
    ? '📱'
    : msg.sender[0].toUpperCase();
  const avatarHtml = '<div class="msg-avatar' + (isViaSms ? ' sms-avatar' : '') + '" style="background:' + msg.color + '">' + avatarInner + '</div>';

  // Quote block
  let quoteHtml = '';
  if (msg.quoteText) {
    quoteHtml = '<div class="msg-quote" onclick="scrollToMsg(\'' + (msg.quoteId || '') + '\')">' +
      '<strong>' + escapeHtml(msg.quoteSender || '') + '</strong>' +
      escapeHtml((msg.quoteText || '').slice(0, 120)) +
    '</div>';
  }

  let content = quoteHtml + (msg.text || '');
  if (msg.fileUrl) {
    if (msg.fileType && msg.fileType.startsWith('image/')) {
      content += '<div class="msg-image"><img src="' + msg.fileUrl + '" alt="' + msg.file + '" onclick="window.open(\'' + msg.fileUrl + '\',\'_blank\')"></div>';
    } else {
      content += '<div class="msg-file"><a href="' + msg.fileUrl + '" target="_blank">Attachment: ' + msg.file + '</a></div>';
    }
  } else if (msg.file) {
    content += '<div class="msg-file">Attachment: ' + msg.file + '</div>';
  }

  const editedTag = msg.edited ? '<span class="msg-edited-tag">(edited)</span>' : '';

  const reactions = (msg.reactions || []).map(function(r) {
    return '<span class="reaction-chip" onclick="addReaction(\'' + msg.id + '\',\'' + r.emoji + '\')">' + r.emoji + ' ' + r.count + '</span>';
  }).join('');

  // SMS badge shown next to sender name
  const smsBadge = isViaSms
    ? '<span class="sms-badge">📱 SMS</span>'
    : '';

  // Pending badge for offline queued messages
  const pendingBadge = msg.pending
    ? '<span class="pending-badge">⏳ Pending</span>'
    : '';

  // Actions: quote always available; edit/delete only for own messages
  const quoteAction = msg.id && !msg.pending
    ? '<span onclick="quoteMessage(\'' + msg.id + '\')" title="Quote">↩️</span>'
    : '';
  const editAction = isMine && msg.id && !msg.pending
    ? '<span onclick="startEdit(\'' + msg.id + '\')" title="Edit">✏️</span>'
    : '';
  const deleteAction = isMine && msg.id
    ? '<span onclick="deleteMsg(\'' + msg.id + '\')" title="Delete">🗑️</span>'
    : '';

  group.innerHTML =
    (isMine ? '' : avatarHtml) +
    '<div class="msg-content">' +
      '<div class="msg-meta">' +
        (isMine ? '' : '<strong>' + msg.sender + '</strong>' + smsBadge) +
        '<span>' + (msg.timestamp && msg.timestamp.toDate ? formatTime(msg.timestamp.toDate()) : msg.time) + '</span>' +
        editedTag +
        pendingBadge +
      '</div>' +
      '<div class="msg-bubble' + (isViaSms ? ' sms-bubble' : '') + (msg.pending ? ' pending-bubble' : '') + '" id="bubble-' + (msg.id || '') + '">' +
        content +
        '<div class="msg-actions">' +
          quoteAction +
          '<span onclick="reactTo(\'' + msg.id + '\',\'👍\')" title="Like">👍</span>' +
          '<span onclick="reactTo(\'' + msg.id + '\',\'❤️\')" title="Love">❤️</span>' +
          '<span onclick="reactTo(\'' + msg.id + '\',\'😂\')" title="Haha">😂</span>' +
          editAction +
          deleteAction +
        '</div>' +
      '</div>' +
      '<div class="reactions">' + reactions + '</div>' +
    '</div>' +
    (isMine ? avatarHtml : '');

  area.appendChild(group);
}

function makeDateDivider(label) {
  const div = document.createElement('div');
  div.className   = 'date-divider';
  div.textContent = label;
  return div;
}

// SEND MESSAGE
async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  // Keep textarea at its current height briefly, then let it resize naturally
  autoResize(input);

  const msg = {
    sender:    state.currentUser.name,
    color:     state.currentUser.color,
    text:      escapeHtml(text),
    time:      formatTime(new Date()),
    reactions: [],
  };

  // Attach quote if set
  if (state.quoteMsg) {
    msg.quoteId     = state.quoteMsg.id || '';
    msg.quoteSender = state.quoteMsg.sender || '';
    msg.quoteText   = (state.quoteMsg.text || '').slice(0, 200);
    cancelQuote();
  }

  if (!isOnline()) {
    // Queue for later sync
    const offlineMsg = Object.assign({}, msg, {
      id:        'offline-' + Date.now(),
      timestamp: { toDate: function() { return new Date(); } },
      pending:   true,
    });
    OfflineStore.addToOutbox(state.currentChannel, msg);
    OfflineStore.appendCachedMessage(state.currentChannel, offlineMsg);
    // Show immediately in UI
    const area = document.getElementById('messagesArea');
    appendMessageEl(area, offlineMsg);
    area.scrollTop = area.scrollHeight;
    return;
  }

  await db.collection('channels').doc(state.currentChannel).collection('messages').add(
    Object.assign({}, msg, { timestamp: firebase.firestore.FieldValue.serverTimestamp() })
  );
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  const newHeight = Math.min(el.scrollHeight, 120);
  // If empty, let CSS/rows=1 handle the default height naturally
  el.style.height = (el.value === '' ? '' : newHeight + 'px');
}

// TYPING
function showTyping() {
  if (!isOnline()) return;
  clearTimeout(state.typingTimer);
  const ref = db.collection('typing').doc(state.currentChannel);
  ref.set({ [state.currentUser.name]: true }, { merge: true });
  state.typingTimer = setTimeout(function() {
    ref.set({ [state.currentUser.name]: false }, { merge: true });
  }, 2000);
}

// REACTIONS
async function reactTo(msgId, emoji) {
  const ref  = db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const reactions = snap.data().reactions || [];
  const existing  = reactions.find(function(r) { return r.emoji === emoji; });
  if (existing) existing.count++;
  else reactions.push({ emoji: emoji, count: 1 });
  await ref.update({ reactions: reactions });
}

function addReaction(msgId, emoji) { reactTo(msgId, emoji); }

// DELETE MESSAGE
async function deleteMsg(msgId) {
  await db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId).delete();
}

// FILE ATTACH
async function attachFile(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  document.getElementById('typingIndicator').textContent = 'Uploading...';
  try {
    const path = 'uploads/' + state.currentChannel + '/' + Date.now() + '_' + file.name;
    const ref  = storage.ref(path);
    await ref.put(file);
    const url  = await ref.getDownloadURL();
    await db.collection('channels').doc(state.currentChannel).collection('messages').add({
      sender: state.currentUser.name, color: state.currentUser.color,
      text: '', file: file.name, fileUrl: url, fileType: file.type,
      time: formatTime(new Date()),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      reactions: [],
    });
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    document.getElementById('typingIndicator').textContent = '';
    input.value = '';
  }
}

// EMOJI
function toggleEmojiPicker() { document.getElementById('emojiPicker').classList.toggle('show'); }
function insertEmoji(emoji) {
  const input = document.getElementById('msgInput');
  input.value += emoji;
  input.focus();
  document.getElementById('emojiPicker').classList.remove('show');
}

// SIDEBAR / MEMBERS
function toggleSidebar() {
  const sidebar   = document.getElementById('sidebar');
  const backdrop  = document.getElementById('sidebarBackdrop');
  const isMobile  = window.innerWidth <= 640;

  if (isMobile) {
    const isOpen = sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', !isOpen);
    backdrop.classList.toggle('show', !isOpen);
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function closeSidebarMobile() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}

// Close sidebar when a channel is tapped on mobile
function loadChannelAndCloseSidebar(id, title, desc) {
  if (window.innerWidth <= 640) closeSidebarMobile();
  loadChannel(id, title, desc);
}

function toggleMembers()  { document.getElementById('membersPanel').classList.toggle('open'); }

function filterChannels(val) {
  renderChannels(val);
  db.collection('users').orderBy('name').get().then(function(snap) {
    renderDMs(snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); }), val);
  });
}

// ============================================================
//  CHANNEL MANAGEMENT
// ============================================================
var ctxChannelId     = null;
var channelModalMode = 'add';

// Open context menu
function openChannelCtxMenu(e, channelId) {
  e.stopPropagation();
  ctxChannelId = channelId;
  const menu = document.getElementById('channelCtxMenu');
  menu.classList.add('show');
  const x = Math.min(e.clientX, window.innerWidth  - 200);
  const y = Math.min(e.clientY, window.innerHeight - 130);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeCtxMenu() {
  document.getElementById('channelCtxMenu').classList.remove('show');
}

function ctxRename() {
  const id = ctxChannelId;
  closeCtxMenu();
  openChannelModal('rename', id);
}

function ctxManage() {
  const id = ctxChannelId;
  closeCtxMenu();
  openChannelModal('participants', id);
}

async function ctxDelete() {
  const id = ctxChannelId;
  closeCtxMenu();
  const ch = channels.find(function(c) { return c.id === id; });
  if (!ch) return;
  if (!confirm('Delete "' + ch.label + '"? This cannot be undone.')) return;
  channels.splice(channels.indexOf(ch), 1);
  if (state.currentChannel === id) loadChannel('general');
  renderChannels();
  await db.collection('channelMeta').doc(id).delete().catch(function() {});
}

// Add channel button
function openAddChannelModal() {
  openChannelModal('add', null);
}

// Open modal
async function openChannelModal(mode, channelId) {
  channelModalMode = mode;
  ctxChannelId     = channelId || null;

  const nameInput = document.getElementById('channelNameInput');
  const descInput = document.getElementById('channelDescInput');
  const nameGroup = nameInput.closest('.form-group');
  const descGroup = descInput.closest('.form-group');
  document.getElementById('channelModalError').textContent = '';

  const ch = channelId ? channels.find(function(c) { return c.id === channelId; }) : null;

  if (mode === 'add') {
    document.getElementById('channelModalTitle').textContent   = 'Add Channel';
    document.getElementById('channelModalSaveBtn').textContent = 'Create';
    nameInput.value = '';
    descInput.value = '';
    nameGroup.style.display = '';
    descGroup.style.display = '';
  } else if (mode === 'rename') {
    document.getElementById('channelModalTitle').textContent   = 'Rename Channel';
    document.getElementById('channelModalSaveBtn').textContent = 'Save';
    nameInput.value = ch ? ch.label.replace(/^[#]\s*/, '') : '';
    descInput.value = ch ? ch.desc || '' : '';
    nameGroup.style.display = '';
    descGroup.style.display = '';
  } else {
    document.getElementById('channelModalTitle').textContent   = 'Manage Participants';
    document.getElementById('channelModalSaveBtn').textContent = 'Save';
    nameGroup.style.display = 'none';
    descGroup.style.display = 'none';
  }

  await buildParticipantsList(channelId);
  document.getElementById('channelModal').classList.add('show');
}

// Build participants checklist
async function buildParticipantsList(channelId) {
  const container = document.getElementById('participantsList');
  container.innerHTML = '<div style="padding:8px;color:#aaa;font-size:13px">Loading...</div>';

  var currentParticipants = [];
  if (channelId) {
    const snap = await db.collection('channelMeta').doc(channelId).get();
    if (snap.exists) currentParticipants = snap.data().participants || [];
  }

  const usersSnap = await db.collection('users').orderBy('name').get();
  container.innerHTML = '';

  if (usersSnap.empty) {
    container.innerHTML = '<div style="padding:8px;color:#aaa;font-size:13px">No users found.</div>';
    return;
  }

  usersSnap.docs.forEach(function(d) {
    const u       = d.data();
    const checked = currentParticipants.length === 0 || currentParticipants.includes(u.name);
    const row     = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML =
      '<input type="checkbox" id="pcheck_' + d.id + '" value="' + u.name + '" ' + (checked ? 'checked' : '') + '>' +
      '<div class="p-avatar" style="background:' + u.color + '">' + u.name[0] + '</div>' +
      '<label for="pcheck_' + d.id + '" style="cursor:pointer;flex:1">' + u.name + '</label>' +
      '<span style="font-size:11px;color:' + statusColor(u.status || 'offline') + '">' + (u.status || 'offline') + '</span>';
    container.appendChild(row);
  });
}

function closeChannelModal() {
  document.getElementById('channelModal').classList.remove('show');
}

// Save channel
async function saveChannel() {
  const errEl        = document.getElementById('channelModalError');
  const nameVal      = document.getElementById('channelNameInput').value.trim();
  const descVal      = document.getElementById('channelDescInput').value.trim();
  const participants = Array.from(document.querySelectorAll('#participantsList input[type="checkbox"]:checked'))
    .map(function(cb) { return cb.value; });

  if (channelModalMode === 'add') {
    if (!nameVal) { errEl.textContent = 'Channel name is required.'; return; }
    const id = nameVal.toLowerCase().replace(/\s+/g, '-');
    if (channels.find(function(c) { return c.id === id; })) {
      errEl.textContent = 'A channel with that name already exists.';
      return;
    }
    const label = '# ' + nameVal;
    const desc  = descVal || nameVal;
    await db.collection('channelMeta').doc(id).set({
      label: label, desc: desc, participants: participants,
      createdBy: state.currentUser.name,
    });
    channels.push({ id: id, label: label, desc: desc, custom: true });
    closeChannelModal();
    renderChannels();
    loadChannel(id);

  } else if (channelModalMode === 'rename') {
    if (!nameVal) { errEl.textContent = 'Channel name is required.'; return; }
    const ch = channels.find(function(c) { return c.id === ctxChannelId; });
    if (ch) {
      ch.label = '# ' + nameVal;
      ch.desc  = descVal || nameVal;
      await db.collection('channelMeta').doc(ch.id).set(
        { label: ch.label, desc: ch.desc, participants: participants },
        { merge: true }
      );
      if (state.currentChannel === ch.id) {
        document.getElementById('channelTitle').textContent = ch.label;
        document.getElementById('channelDesc').textContent  = ch.desc;
      }
      closeChannelModal();
      renderChannels();
    }

  } else if (channelModalMode === 'participants') {
    if (ctxChannelId) {
      await db.collection('channelMeta').doc(ctxChannelId).set(
        { participants: participants }, { merge: true }
      );
    }
    closeChannelModal();
  }
}

// SETTINGS
function toggleSettings() {
  document.getElementById('settingName').value   = state.currentUser.name;
  document.getElementById('settingStatus').value = state.currentUser.status;
  document.getElementById('settingsModal').classList.add('show');
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('show'); }

async function saveSettings() {
  const newName = document.getElementById('settingName').value.trim();
  const status  = document.getElementById('settingStatus').value;
  if (newName) state.currentUser.name = newName;
  state.currentUser.status = status;
  updateStatusDisplay(status);
  document.getElementById('myName').textContent = state.currentUser.name;
  document.getElementById('myAvatarInitial').textContent = state.currentUser.name[0].toUpperCase();
  sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
  if (state.currentUser.id && isOnline()) {
    await db.collection('users').doc(state.currentUser.id).update({
      status: status,
      name: state.currentUser.name,
    }).catch(function() {});
  }
  // Always update local cache
  OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));
  document.getElementById('settingsSaveMsg').textContent = 'Saved ✓';
  setTimeout(function() {
    document.getElementById('settingsSaveMsg').textContent = '';
    closeSettings();
  }, 1000);
}

function updateStatusDisplay(status) {
  const el     = document.querySelector('.user-status');
  const labels = { online: '● Online', away: '● Away', busy: '● Busy', offline: '● Offline' };
  el.textContent = labels[status] || '● Online';
  el.className   = 'user-status ' + status;
}

// LOGOUT
async function logout() {
  await markOffline();
  sessionStorage.removeItem('teamsUser');
  window.location.href = 'index.html';
}

async function markOffline() {
  if (state.currentUser.id && isOnline()) {
    await db.collection('users').doc(state.currentUser.id).update({ status: 'offline' }).catch(function() {});
  }
}

// VIDEO CALL
function openVideoCall() {
  document.getElementById('callModal').classList.add('show');
  setTimeout(function() {
    document.getElementById('callStatus').textContent  = 'Connected';
    document.getElementById('remoteLabel').textContent = 'Waiting for others to join...';
  }, 2000);
}
function closeCall() { document.getElementById('callModal').classList.remove('show'); }
function toggleMic(btn) {
  btn.classList.toggle('muted');
  btn.textContent = btn.classList.contains('muted') ? '🔇' : '🎤';
}
function toggleCam(btn) {
  btn.classList.toggle('cam-off');
  btn.textContent = btn.classList.contains('cam-off') ? '🚫' : '📷';
}

// UTILS
function formatTime(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function updateTabTitle() {
  var total = Object.values(state.unread).reduce(function(sum, n) { return sum + n; }, 0);
  document.title = total > 0 ? '(' + total + ') Palawan Connect' : 'Palawan Connect';
}

// Clear tab title when window regains focus
window.addEventListener('focus', function() {
  state.unread[state.currentChannel] = 0;
  renderChannels();
  updateTabTitle();
});

// ── CONVERSATION SEARCH ──
function toggleConvSearch() {
  var bar = document.getElementById('convSearchBar');
  bar.classList.toggle('show');
  if (bar.classList.contains('show')) {
    document.getElementById('convSearchInput').focus();
  } else {
    closeConvSearch();
  }
}

function closeConvSearch() {
  var bar = document.getElementById('convSearchBar');
  bar.classList.remove('show');
  document.getElementById('convSearchInput').value = '';
  document.getElementById('convSearchCount').textContent = '';
  clearSearchHighlights();
}

function clearSearchHighlights() {
  var area = document.getElementById('messagesArea');
  // restore hidden groups
  area.querySelectorAll('.msg-group.search-hidden').forEach(function(el) {
    el.classList.remove('search-hidden');
  });
  // remove highlights
  area.querySelectorAll('.search-highlight').forEach(function(el) {
    var parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
  // restore date dividers
  area.querySelectorAll('.date-divider').forEach(function(el) {
    el.style.display = '';
  });
}

function searchConversation(query) {
  clearSearchHighlights();
  var count = document.getElementById('convSearchCount');
  if (!query.trim()) { count.textContent = ''; return; }

  var area   = document.getElementById('messagesArea');
  var groups = area.querySelectorAll('.msg-group');
  var q      = query.toLowerCase();
  var found  = 0;

  groups.forEach(function(group) {
    // check bubble text and file names
    var bubble   = group.querySelector('.msg-bubble');
    var textNode = bubble ? bubble.childNodes : [];
    var fullText = bubble ? bubble.innerText.toLowerCase() : '';
    var fileEl   = group.querySelector('.msg-file');
    var fileText = fileEl ? fileEl.innerText.toLowerCase() : '';

    if (fullText.indexOf(q) === -1 && fileText.indexOf(q) === -1) {
      group.classList.add('search-hidden');
    } else {
      found++;
      // highlight in bubble text nodes
      if (bubble) highlightInElement(bubble, query);
    }
  });

  // hide date dividers that have no visible messages after them
  area.querySelectorAll('.date-divider').forEach(function(divider) {
    var next = divider.nextElementSibling;
    var hasVisible = false;
    while (next && !next.classList.contains('date-divider')) {
      if (!next.classList.contains('search-hidden')) { hasVisible = true; break; }
      next = next.nextElementSibling;
    }
    divider.style.display = hasVisible ? '' : 'none';
  });

  count.textContent = found + ' result' + (found !== 1 ? 's' : '');
}

function highlightInElement(el, query) {
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
  var nodes  = [];
  var node;
  while ((node = walker.nextNode())) { nodes.push(node); }

  var q = query.toLowerCase();
  nodes.forEach(function(textNode) {
    var val = textNode.nodeValue;
    var idx = val.toLowerCase().indexOf(q);
    if (idx === -1) return;
    var before  = document.createTextNode(val.slice(0, idx));
    var mark    = document.createElement('mark');
    mark.className = 'search-highlight';
    mark.textContent = val.slice(idx, idx + query.length);
    var after   = document.createTextNode(val.slice(idx + query.length));
    var parent  = textNode.parentNode;
    parent.insertBefore(before, textNode);
    parent.insertBefore(mark, textNode);
    parent.insertBefore(after, textNode);
    parent.removeChild(textNode);
  });
}
function statusColor(s) {
  return { online: '#2ecc71', away: '#f1c40f', busy: '#e74c3c', offline: '#95a5a6' }[s] || '#95a5a6';
}

// ── SMS INBOX PANEL ──────────────────────────────────────────
function toggleSmsInbox() {
  const panel = document.getElementById('smsInboxPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderSmsInboxPanel();
}

function renderSmsInboxPanel() {
  const list   = document.getElementById('smsInboxList');
  const inbox  = OfflineStore.getSmsInbox();
  const count  = document.getElementById('smsInboxCount');

  if (!inbox.length) {
    list.innerHTML = '<div style="text-align:center;color:#aaa;padding:30px;font-size:13px;">No SMS messages yet.<br>Start the SMS bridge server<br>and send a text to your phone.</div>';
    if (count) { count.style.display = 'none'; }
    return;
  }

  if (count) {
    count.textContent = inbox.length;
    count.style.display = 'inline-block';
  }

  list.innerHTML = '';
  // Show newest first
  inbox.slice().reverse().forEach(function(item) {
    const div = document.createElement('div');
    div.className = 'sms-inbox-item';
    const time = new Date(item.receivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    div.innerHTML =
      '<div class="sms-inbox-from">📱 ' + escapeHtml(item.msg.smsFrom || 'Unknown') + '</div>' +
      '<div class="sms-inbox-text">' + escapeHtml(item.msg.text || '') + '</div>' +
      '<div class="sms-inbox-meta">' + time + ' → #' + escapeHtml(item.channelId) + '</div>';
    div.onclick = function() {
      loadChannel(item.channelId);
      toggleSmsInbox();
    };
    list.appendChild(div);
  });
}

function clearSmsInboxPanel() {
  if (!confirm('Clear all SMS inbox messages?')) return;
  OfflineStore.clearSmsInbox();
  localStorage.setItem('pc_seen_sms', '[]');
  renderSmsInboxPanel();
  const count = document.getElementById('smsInboxCount');
  if (count) count.style.display = 'none';
}

// Update SMS inbox badge count
function updateSmsInboxBadge() {
  const inbox = OfflineStore.getSmsInbox();
  const count = document.getElementById('smsInboxCount');
  if (!count) return;
  if (inbox.length > 0) {
    count.textContent    = inbox.length;
    count.style.display  = 'inline-block';
  } else {
    count.style.display  = 'none';
  }
}

// Call on load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(updateSmsInboxBadge, 500);
  checkNotificationPermission();
});

// ── QUOTE MESSAGE ──────────────────────────────────────────
function quoteMessage(msgId) {
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (!group) return;
  const bubble = group.querySelector('.msg-bubble');
  const meta   = group.querySelector('.msg-meta strong');
  const sender = meta ? meta.textContent : 'Unknown';
  
  // Get text but exclude emoji reactions and action buttons
  let text = '';
  if (bubble) {
    // Clone the bubble to manipulate it
    const clone = bubble.cloneNode(true);
    // Remove action buttons and reactions
    const actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    // Get text and clean up
    text = clone.innerText
      .replace(/👍|❤️|😂|🗑️|↩️|✏️/g, '') // Remove any remaining emoji icons
      .replace(/[\n\r]+/g, ' ')           // Replace newlines with spaces
      .trim()
      .slice(0, 200);
  }

  state.quoteMsg = { id: msgId, sender: sender, text: text };
  const preview = document.getElementById('quotePreview');
  const previewText = document.getElementById('quotePreviewText');
  previewText.innerHTML = '<strong>' + escapeHtml(sender) + ':</strong> ' + escapeHtml(text.slice(0, 100));
  preview.classList.add('show');
  document.getElementById('msgInput').focus();
}

function cancelQuote() {
  state.quoteMsg = null;
  document.getElementById('quotePreview').classList.remove('show');
}

function scrollToMsg(msgId) {
  if (!msgId) return;
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) {
    group.scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.style.background = 'rgba(98,100,167,0.3)';
    setTimeout(function() { group.style.background = ''; }, 1500);
  }
}

// ── EDIT MESSAGE ──────────────────────────────────────────
function startEdit(msgId) {
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (!group) return;

  // Get the plain text from the bubble (strip HTML tags and <br> back to newlines)
  const bubble = document.getElementById('bubble-' + msgId);
  let currentText = '';
  if (bubble) {
    // Clone and remove action buttons AND quote block before reading text
    const clone = bubble.cloneNode(true);
    const actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    const quote = clone.querySelector('.msg-quote');
    if (quote) quote.remove();
    // Convert <br> back to newlines, then strip remaining tags
    currentText = clone.innerHTML
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
  }

  // Build a full-width edit row and insert it after the group
  const editRow = document.createElement('div');
  editRow.className = 'msg-editing';
  editRow.id = 'editrow-' + msgId;
  editRow.innerHTML =
    '<div class="msg-edit-label">✏️ Editing message</div>' +
    '<textarea class="msg-edit-area" id="edit-' + msgId + '">' + currentText + '</textarea>' +
    '<div class="msg-edit-actions">' +
      '<button class="msg-edit-save" onclick="saveEdit(\'' + msgId + '\')">Save</button>' +
      '<button class="msg-edit-cancel" onclick="cancelEdit(\'' + msgId + '\')">Cancel</button>' +
      '<span style="font-size:11px;color:var(--text-muted);margin-left:6px;">Enter to save · Esc to cancel</span>' +
    '</div>';

  // Hide the original group and insert edit row after it
  group.style.display = 'none';
  group.parentNode.insertBefore(editRow, group.nextSibling);

  const ta = document.getElementById('edit-' + msgId);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  // Auto-resize the textarea
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  ta.addEventListener('input', function() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  // Keyboard shortcuts
  ta.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msgId); }
    if (e.key === 'Escape') { cancelEdit(msgId); }
  });

  editRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveEdit(msgId) {
  const textarea = document.getElementById('edit-' + msgId);
  if (!textarea) return;
  const newText = textarea.value.trim();
  if (!newText) { alert('Message cannot be empty.'); return; }

  if (!isOnline()) {
    alert('Cannot edit messages while offline.');
    cancelEdit(msgId);
    return;
  }

  await db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId).update({
    text: escapeHtml(newText),
    edited: true,
  });
  // Firestore listener will re-render and remove the edit row
}

function cancelEdit(msgId) {
  // Remove edit row and restore original group
  const editRow = document.getElementById('editrow-' + msgId);
  if (editRow) editRow.remove();
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.display = '';
}

// ── NOTIFICATIONS ──────────────────────────────────────────
function checkNotificationPermission() {
  if (!('Notification' in window)) return;
  const btn = document.getElementById('notifBtn');
  if (Notification.permission === 'default') {
    btn.style.display = 'inline-block';
  } else if (Notification.permission === 'granted') {
    btn.style.display = 'none';
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('Notifications not supported in this browser.');
    return;
  }
  Notification.requestPermission().then(function(perm) {
    if (perm === 'granted') {
      document.getElementById('notifBtn').style.display = 'none';
      showNotifToast('Notifications enabled', 'You will be notified of new messages.');
    }
  });
}

function showNotifToast(title, body) {
  let toast = document.getElementById('notifToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'notifToast';
    toast.className = 'notif-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML =
    '<div class="notif-toast-title">' + escapeHtml(title) + '</div>' +
    '<div class="notif-toast-body">' + escapeHtml(body) + '</div>';
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 4000);
}

function showBrowserNotification(title, body, channelId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return; // Don't notify if window is focused
  const notif = new Notification(title, {
    body: body,
    icon: 'M-LOGO.png',
    tag: channelId,
  });
  notif.onclick = function() {
    window.focus();
    loadChannel(channelId);
    notif.close();
  };
}

// Hook into message listener to trigger notifications
// Modify loadChannel's onSnapshot to call showBrowserNotification for new messages from others
// We'll patch this in the existing code by wrapping the logic

// CLOSE PICKERS ON OUTSIDE CLICK
document.addEventListener('click', function(e) {
  const picker = document.getElementById('emojiPicker');
  if (picker && !picker.contains(e.target) && !e.target.classList.contains('emoji-btn')) {
    picker.classList.remove('show');
  }
  const ctxMenu = document.getElementById('channelCtxMenu');
  if (ctxMenu && !ctxMenu.contains(e.target) && !e.target.classList.contains('ch-menu-btn')) {
    closeCtxMenu();
  }
});
