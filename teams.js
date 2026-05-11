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
        if (!state.unreadSenders[channelId]) state.unreadSenders[channelId] = new Set();
        state.unreadSenders[channelId].add(msg.sender);
        renderChannels();
        renderDMsFromCache();
        updateTabTitle();
        updateFavicon(true);
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
  unreadSenders: {},
  unreadMsgIds: new Set(),
  lastSender: {},
  dmLastActivity: {},       // { channelId: timestamp ms } — for sorting DMs by recent activity
  msgCount: {},
  notifCount: {},
  unsubscribeMessages: null,
  unsubscribeUsers: null,
  unsubscribeNotifs: [],
  typingTimer: null,
  isOffline: false,
  quoteMsg: null,
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

  // Start notification listeners for all channels
  if (isOnline()) {
    setTimeout(startNotifListeners, 1500); // slight delay so msgCount is seeded first
  }

  // Users listener — graceful offline fallback
  if (isOnline()) {
    state.unsubscribeUsers = db.collection('users').orderBy('name')
      .onSnapshot(function(snap) {
        // Handle deletions — remove from local cache immediately
        snap.docChanges().forEach(function(change) {
          if (change.type === 'removed') {
            OfflineStore.removeCachedUser(change.doc.id);
          }
        });
        const users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
        OfflineStore.cacheUsers(users);
        renderDMs(users);
        renderMembers(users);
        // Re-start notif listeners now that DM channels are known
        if (isOnline()) setTimeout(startNotifListeners, 800);
        // Seed DM activity timestamps from cached messages for initial sort
        seedDmActivityFromCache(users);
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
            snap.docChanges().forEach(function(change) {
              if (change.type === 'removed') {
                OfflineStore.removeCachedUser(change.doc.id);
              }
            });
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
      const hasUnread = state.unread[c.id] > 0;

      const div = document.createElement('div');
      div.className = 'channel-item' + (c.id === state.currentChannel ? ' active' : '');
      div.onclick = function() { loadChannelAndCloseSidebar(c.id); };

      // Channel label — bold + orange when unread, normal when read
      const labelSpan = document.createElement('span');
      labelSpan.textContent = c.label;
      labelSpan.className = hasUnread ? 'ch-label unread-item' : 'ch-label';
      div.appendChild(labelSpan);

      if (hasUnread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = state.unread[c.id];
        div.appendChild(badge);
      }

      const menuBtn = document.createElement('span');
      menuBtn.className = 'ch-menu-btn';
      menuBtn.textContent = '...';
      menuBtn.title = 'Options';
      menuBtn.onclick = function(e) { e.stopPropagation(); openChannelCtxMenu(e, c.id); };
      div.appendChild(menuBtn);

      list.appendChild(div);
    });
}

// RENDER DMs — sorted by most recent activity (latest message first)
function renderDMs(users, filter) {
  filter = filter || '';
  const list = document.getElementById('dmList');
  list.innerHTML = '';

  var filtered = users
    .filter(function(u) { return u.name !== state.currentUser.name; })
    .filter(function(u) { return u.name.toLowerCase().includes((filter || '').toLowerCase()); });

  // Sort: most recent activity first, then alphabetical for ties
  filtered.sort(function(a, b) {
    var dmA = dmChannelId(state.currentUser.name, a.name);
    var dmB = dmChannelId(state.currentUser.name, b.name);
    var tA  = state.dmLastActivity[dmA] || 0;
    var tB  = state.dmLastActivity[dmB] || 0;
    if (tB !== tA) return tB - tA; // most recent first
    return a.name.localeCompare(b.name);
  });

  filtered.forEach(function(u) {
    const dmId      = dmChannelId(state.currentUser.name, u.name);
    const hasUnread = state.unread[dmId] > 0;

    const div = document.createElement('div');
    div.className = 'channel-item' + (dmId === state.currentChannel ? ' active' : '');
    div.onclick   = function() { loadChannelAndCloseSidebar(dmId, u.name, 'Direct message with ' + u.name); };

    // Status dot
    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor(u.status) + ';display:inline-block;flex-shrink:0;';

    // Name — bold + orange when unread, normal when read
    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.name;
    nameSpan.className = hasUnread ? 'ch-label unread-item' : 'ch-label';

    div.appendChild(dot);
    div.appendChild(nameSpan);

    if (hasUnread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = state.unread[dmId];
      div.appendChild(badge);
    }

    list.appendChild(div);
  });
}

// Helper to re-render DMs from cached users
function renderDMsFromCache() {
  const cached = OfflineStore.getCachedUsers();
  renderDMs(cached);
}

// Seed DM activity timestamps from cached messages so sort order is correct on load
function seedDmActivityFromCache(users) {
  if (!users) users = OfflineStore.getCachedUsers();
  users.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    if (state.dmLastActivity[dmId]) return; // already set
    var msgs = OfflineStore.getCachedMessages(dmId);
    if (msgs && msgs.length > 0) {
      var last = msgs[msgs.length - 1];
      var ts = last.timestamp && last.timestamp.toDate
        ? last.timestamp.toDate().getTime()
        : (last.time ? new Date().getTime() : 0);
      if (ts) state.dmLastActivity[dmId] = ts;
    }
  });
  renderDMsFromCache();
}

function dmChannelId(a, b) {
  return 'dm-' + [a, b].sort().join('-').toLowerCase().replace(/[\s.]+/g, '_');
}

// RENDER MEMBERS
function renderMembers(users) {
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  const isAdmin = state.currentUser.name === 'Admin'; // only Admin can remove users

  users.forEach(function(u) {
    const isSelf = u.name === state.currentUser.name;
    const div = document.createElement('div');
    div.className = 'member-item';

    div.innerHTML =
      '<div class="user-avatar" style="background:' + u.color + ';width:30px;height:30px;font-size:12px;flex-shrink:0">' + u.name[0] + '</div>' +
      '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(u.name) + (isSelf ? ' <span style="font-size:10px;color:var(--text-muted)">(you)</span>' : '') + '</span>' +
      '<span class="dot ' + (u.status || 'offline') + '"></span>';

    // Add ... menu button for every user (admin can remove others; anyone can remove themselves)
    if (!isSelf || isAdmin) {
      const menuBtn = document.createElement('span');
      menuBtn.className = 'member-menu-btn';
      menuBtn.textContent = '···';
      menuBtn.title = 'Options';
      menuBtn.onclick = function(e) {
        e.stopPropagation();
        openMemberCtxMenu(e, u);
      };
      div.appendChild(menuBtn);
    }

    list.appendChild(div);
  });
}

// LOAD CHANNEL
function loadChannel(id, title, desc) {
  if (state.unsubscribeMessages) { state.unsubscribeMessages(); state.unsubscribeMessages = null; }

  closeConvSearch();

  state.currentChannel = id;
  state.unread[id]     = 0;
  state.unreadSenders[id] = new Set();
  state.lastSender[id]    = null;
  // Update DM sort order when opening a DM
  if (id.startsWith('dm-')) {
    state.dmLastActivity[id] = state.dmLastActivity[id] || Date.now();
    renderDMsFromCache();
  }
  // Clear unread message IDs for this channel — loading it counts as reading
  // We'll clear them after messages render so the bold shows briefly then fades
  updateTabTitle();
  updateFavicon(Object.values(state.unread).some(function(n){ return n > 0; }));

  const ch = channels.find(function(c) { return c.id === id; });
  document.getElementById('channelTitle').textContent = title || (ch ? ch.label : id);
  document.getElementById('channelDesc').textContent  = desc  || (ch ? ch.desc  || '' : '');

  renderChannels();
  renderDMsFromCache();

  // Restart notif listeners so the new current channel is excluded
  // and the previous current channel gets a background listener
  if (isOnline()) setTimeout(startNotifListeners, 500);

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
      // Use -1 as sentinel: first snapshot never triggers notifications
      var oldCount = state.msgCount[id] !== undefined ? state.msgCount[id] : -1;

      if (oldCount >= 0 && newCount > oldCount) {
        var added     = newCount - oldCount;
        var newMsgs   = msgs.slice(msgs.length - added);
        var fromOthers = newMsgs.filter(function(m) { return m.sender !== state.currentUser.name; });

        if (fromOthers.length > 0) {
          // Unread badge for background channels
          if (id !== state.currentChannel) {
            state.unread[id] = (state.unread[id] || 0) + fromOthers.length;
            // Track unread senders
            if (!state.unreadSenders[id]) state.unreadSenders[id] = new Set();
            fromOthers.forEach(function(m) { state.unreadSenders[id].add(m.sender); });
            renderChannels();
            renderDMsFromCache();
            updateTabTitle();
          }
          // Mark message IDs as unread so sender name shows bold in bubble
          fromOthers.forEach(function(m) {
            if (m.id) state.unreadMsgIds.add(m.id);
          });
          // Record last sender for sidebar display
          if (fromOthers.length > 0) {
            state.lastSender[id] = fromOthers[fromOthers.length - 1].sender;
          }
          // Orange favicon on new unread message
          updateFavicon(true);
          // Notify for every new message from others regardless of which channel
          fromOthers.forEach(function(m) {
            var chLabel = (channels.find(function(c) { return c.id === id; }) || {}).label || ('#' + id);
            var cleanText = (m.text || '')
              .replace(/<br\s*\/?>/gi, ' ')
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
              .slice(0, 100);
            // Desktop browser notification (when window not focused)
            showBrowserNotification(m.sender + ' · ' + chLabel, cleanText, id);
          });
        }
      }

      state.msgCount[id] = newCount;
      // Update DM sort order whenever this channel gets any message activity
      if (id.startsWith('dm-') && newCount > 0) {
        state.dmLastActivity[id] = Date.now();
        renderDMsFromCache();
      }
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

  // After rendering, schedule clearing unread IDs for current channel
  // so bold shows for a moment then auto-clears when user scrolls/reads
  setTimeout(function() {
    if (document.hasFocus()) {
      clearUnreadMsgIdsForChannel();
    }
  }, 3000);
}

// Clear unread msg IDs for messages currently visible in the channel
function clearUnreadMsgIdsForChannel() {
  var area = document.getElementById('messagesArea');
  if (!area) return;
  area.querySelectorAll('.sender-unread').forEach(function(el) {
    var msgId = el.id.replace('sender-', '');
    var senderName = el.textContent;
    state.unreadMsgIds.delete(msgId);
    var replacement = document.createElement('strong');
    replacement.textContent = senderName;
    if (el.parentNode) el.parentNode.replaceChild(replacement, el);
  });
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

  const me = state.currentUser.name;
  const reactions = (msg.reactions || []).filter(function(r) { return r.count > 0; }).map(function(r) {
    var reacted = r.users && r.users.includes(me);
    return '<span class="reaction-chip' + (reacted ? ' reacted' : '') + '" onclick="addReaction(\'' + msg.id + '\',\'' + r.emoji + '\')" title="' + (reacted ? 'Remove reaction' : 'Add reaction') + '">' + r.emoji + ' ' + r.count + '</span>';
  }).join('');

  // SMS badge shown next to sender name
  const smsBadge = isViaSms
    ? '<span class="sms-badge">📱 SMS</span>'
    : '';

  // Pending badge for offline queued messages
  const pendingBadge = msg.pending
    ? '<span class="pending-badge">⏳ Pending</span>'
    : '';

  // Actions: SVG icons — elegant like Messenger
  var svgReply  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>';
  var svgLike   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>';
  var svgHeart  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
  var svgLaugh  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  var svgEdit   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  var svgDelete = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

  const quoteAction  = msg.id && !msg.pending
    ? '<span class="ma-btn" onclick="quoteMessage(\'' + msg.id + '\')" title="Reply">' + svgReply + '</span>'
    : '';
  const editAction   = isMine && msg.id && !msg.pending
    ? '<span class="ma-btn" onclick="startEdit(\'' + msg.id + '\')" title="Edit">' + svgEdit + '</span>'
    : '';
  const deleteAction = isMine && msg.id
    ? '<span class="ma-btn ma-btn-danger" onclick="deleteMsg(\'' + msg.id + '\')" title="Delete">' + svgDelete + '</span>'
    : '';

  // Sender name — bold+orange if this message is unread, clickable to mark read
  var senderHtml = '';
  if (!isMine) {
    var isUnread = msg.id && state.unreadMsgIds.has(msg.id);
    if (isUnread) {
      senderHtml = '<strong class="sender-unread" id="sender-' + msg.id + '" onclick="markSenderRead(\'' + msg.id + '\',\'' + escapeHtml(msg.sender) + '\')" title="Click to mark as read">' + escapeHtml(msg.sender) + '</strong>' + smsBadge;
    } else {
      senderHtml = '<strong>' + escapeHtml(msg.sender) + '</strong>' + smsBadge;
    }
  }

  group.innerHTML =
    (isMine ? '' : avatarHtml) +
    '<div class="msg-content">' +
      '<div class="msg-meta">' +
        (isMine ? '' : senderHtml) +
        '<span>' + (msg.timestamp && msg.timestamp.toDate ? formatTime(msg.timestamp.toDate()) : msg.time) + '</span>' +
        editedTag +
        pendingBadge +
      '</div>' +
      '<div class="msg-bubble' + (isViaSms ? ' sms-bubble' : '') + (msg.pending ? ' pending-bubble' : '') + '" id="bubble-' + (msg.id || '') + '">' +
        content +
        '<div class="msg-actions">' +
          quoteAction +
          '<span class="ma-btn ma-btn-like" onclick="reactTo(\'' + msg.id + '\',\'👍\')" title="Like">' + svgLike + '</span>' +
          '<span class="ma-btn ma-btn-heart" onclick="reactTo(\'' + msg.id + '\',\'❤️\')" title="Love">' + svgHeart + '</span>' +
          '<span class="ma-btn ma-btn-laugh" onclick="reactTo(\'' + msg.id + '\',\'😂\')" title="Haha">' + svgLaugh + '</span>' +
          editAction +
          deleteAction +
        '</div>' +
      '</div>' +
      '<div class="reactions">' + reactions + '</div>' +
    '</div>' +
    (isMine ? avatarHtml : '');

  area.appendChild(group);

  // Mobile: tap bubble to toggle action buttons
  if ('ontouchstart' in window || window.innerWidth <= 640) {
    const bubble = group.querySelector('.msg-bubble');
    if (bubble) {
      bubble.addEventListener('click', function(e) {
        // Don't toggle if user tapped an action button or a link
        if (e.target.closest('.msg-actions') || e.target.tagName === 'A') return;
        const isMobile = window.innerWidth <= 640;
        if (!isMobile) return;
        // Close all other open bubbles first
        document.querySelectorAll('.msg-bubble.actions-open').forEach(function(b) {
          if (b !== bubble) b.classList.remove('actions-open');
        });
        bubble.classList.toggle('actions-open');
      });
    }
  }
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
  const isMobile = window.innerWidth <= 640 || ('ontouchstart' in window);
  if (e.key === 'Enter') {
    if (isMobile) {
      // On mobile: Enter always sends (use the ↵ button for new lines)
      e.preventDefault();
      sendMessage();
    } else {
      // On desktop: Enter sends, Shift+Enter = new line
      if (!e.shiftKey) { e.preventDefault(); sendMessage(); }
    }
  }
}

function insertNewline() {
  const input = document.getElementById('msgInput');
  const pos = input.selectionStart;
  input.value = input.value.slice(0, pos) + '\n' + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + 1;
  autoResize(input);
  input.focus();
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

// REACTIONS — per-user toggle (tap again to remove)
async function reactTo(msgId, emoji) {
  if (!isOnline()) return;
  const ref  = db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const me        = state.currentUser.name;
  const reactions = snap.data().reactions || [];
  const existing  = reactions.find(function(r) { return r.emoji === emoji; });

  if (existing) {
    // Migrate old format (no users array) to new format
    if (!existing.users) existing.users = [];

    if (existing.users.includes(me)) {
      // Already reacted — toggle OFF
      existing.users = existing.users.filter(function(u) { return u !== me; });
      existing.count = existing.users.length;
    } else {
      // New reactor — toggle ON
      existing.users.push(me);
      existing.count = existing.users.length;
    }

    // Remove the reaction entirely if count hits 0
    const updated = reactions.filter(function(r) { return r.count > 0; });
    await ref.update({ reactions: updated });
  } else {
    // First time this emoji is used on this message
    reactions.push({ emoji: emoji, count: 1, users: [me] });
    await ref.update({ reactions: reactions });
  }
}

function addReaction(msgId, emoji) { reactTo(msgId, emoji); }

// DELETE MESSAGE — with 5-second undo window
var _deleteTimers = {}; // pending delete timers keyed by msgId

function deleteMsg(msgId) {
  // Find the message group and hide it immediately (optimistic UI)
  var group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.opacity = '0.3';

  // Show undo toast
  showUndoToast(msgId, function() {
    // UNDO — restore the message
    if (group) group.style.opacity = '';
    clearTimeout(_deleteTimers[msgId]);
    delete _deleteTimers[msgId];
  });

  // Schedule actual delete after 5 seconds
  _deleteTimers[msgId] = setTimeout(async function() {
    delete _deleteTimers[msgId];
    if (group) group.remove();
    try {
      await db.collection('channels').doc(state.currentChannel)
        .collection('messages').doc(msgId).delete();
    } catch(e) {
      // If delete fails, restore the message
      if (group) { group.style.opacity = ''; group.style.display = ''; }
    }
  }, 5000);
}

function showUndoToast(msgId, onUndo) {
  var toast = document.getElementById('undoToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.className = 'undo-toast';
    document.body.appendChild(toast);
  }

  // Clear any existing timer on the toast itself
  clearTimeout(toast._hideTimer);

  toast.innerHTML =
    '<span>Message deleted</span>' +
    '<button class="undo-btn" id="undoBtn">Undo</button>';

  document.getElementById('undoBtn').onclick = function() {
    onUndo();
    toast.classList.remove('show');
  };

  toast.classList.remove('show');
  void toast.offsetWidth; // reflow to restart animation
  toast.classList.add('show');

  toast._hideTimer = setTimeout(function() {
    toast.classList.remove('show');
  }, 5000);
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

// ── EMOJI PICKER ─────────────────────────────────────────────
var _emojiRecent = JSON.parse(localStorage.getItem('mhc_recent_emoji') || '[]');

var _emojiData = {
  recent:   [], // filled dynamically
  smileys:  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🤧','🥳','🥺','🤠','🤡','🤥','🤫','🤭','🧐','🤓'],
  gestures: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🫀','🫁','🧠','🦷','🦴','👀','👁️','👅','👄'],
  hearts:   ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘'],
  nature:   ['🌱','🌿','🍀','🌾','🌵','🌲','🌳','🌴','🌸','🌺','🌻','🌹','🥀','🌷','🌼','💐','🍄','🌰','🦔','🐾','🌍','🌎','🌏','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘','🌙','🌚','🌛','🌜','🌝','🌞','⭐','🌟','💫','✨','⚡','🌈','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌀','🌊','🌫️','🌁'],
  food:     ['🍎','🍊','🍋','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🫖','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾'],
  activity: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🎰','🧩'],
  symbols:  ['💯','🔔','🔕','🎵','🎶','💤','🔇','🔈','🔉','🔊','📢','📣','📯','🔔','🔕','🎼','💹','📈','📉','📊','✅','❌','❎','🔱','📛','🔰','⭕','✳️','❇️','💠','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🅱️','🆎','🆑','🅾️','🆘','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢️','☣️','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🛐','⚛️','🕉️','✡️','☸️','☯️','✝️','☦️','☪️','☮️','🕎','🔯'],
};

var _currentEmojiCat = 'recent';

function toggleEmojiPicker() {
  var picker = document.getElementById('emojiPicker');
  var isOpen = picker.classList.contains('show');
  picker.classList.toggle('show');
  if (!isOpen) {
    // Populate on open
    _emojiData.recent = _emojiRecent.slice(0, 32);
    var cat = _emojiData.recent.length > 0 ? 'recent' : 'smileys';
    // Activate correct tab
    var tabs = document.querySelectorAll('.ep-tab');
    tabs.forEach(function(t) { t.classList.remove('active'); });
    tabs[_emojiData.recent.length > 0 ? 0 : 1].classList.add('active');
    _currentEmojiCat = cat;
    renderEmojiGrid(_emojiData[cat]);
    document.getElementById('epSearch').value = '';
    document.getElementById('epSearch').focus();
  }
}

function showEmojiCat(btn, cat) {
  document.querySelectorAll('.ep-tab').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  _currentEmojiCat = cat;
  document.getElementById('epSearch').value = '';
  _emojiData.recent = _emojiRecent.slice(0, 32);
  renderEmojiGrid(_emojiData[cat]);
}

function renderEmojiGrid(list) {
  var grid = document.getElementById('epGrid');
  grid.innerHTML = '';
  if (!list || list.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">No emoji found</div>';
    return;
  }
  list.forEach(function(em) {
    var span = document.createElement('span');
    span.className = 'ep-emoji';
    span.textContent = em;
    span.title = em;
    span.onclick = function() { insertEmoji(em); };
    grid.appendChild(span);
  });
}

function filterEmoji(query) {
  if (!query.trim()) {
    _emojiData.recent = _emojiRecent.slice(0, 32);
    renderEmojiGrid(_emojiData[_currentEmojiCat]);
    return;
  }
  // Search across all categories
  var all = [];
  Object.keys(_emojiData).forEach(function(cat) {
    if (cat !== 'recent') all = all.concat(_emojiData[cat]);
  });
  // Simple filter: show emojis that match the query by unicode name lookup
  // Since we can't do name lookup easily, show all and let user scroll
  renderEmojiGrid(all.slice(0, 64));
}

function insertEmoji(emoji) {
  var input = document.getElementById('msgInput');
  var pos   = input.selectionStart || input.value.length;
  input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + emoji.length;
  autoResize(input);
  input.focus();
  // Track recent
  _emojiRecent = _emojiRecent.filter(function(e) { return e !== emoji; });
  _emojiRecent.unshift(emoji);
  if (_emojiRecent.length > 32) _emojiRecent.length = 32;
  localStorage.setItem('mhc_recent_emoji', JSON.stringify(_emojiRecent));
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

// ── MEMBER CONTEXT MENU ──────────────────────────────────────
var _ctxMemberUser = null;

function openMemberCtxMenu(e, user) {
  _ctxMemberUser = user;
  const menu = document.getElementById('memberCtxMenu');
  menu.classList.add('show');
  const x = Math.min(e.clientX, window.innerWidth  - 220);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeMemberCtxMenu() {
  document.getElementById('memberCtxMenu').classList.remove('show');
  _ctxMemberUser = null;
}

async function ctxRemoveMember() {
  const u = _ctxMemberUser;
  closeMemberCtxMenu();
  if (!u) return;

  const isSelf = u.name === state.currentUser.name;
  const confirmMsg = isSelf
    ? 'Remove your own account and clear all your chat history? This cannot be undone.'
    : 'Remove "' + u.name + '" and delete all their chat history across all channels? This cannot be undone.';

  if (!confirm(confirmMsg)) return;

  if (!isOnline()) {
    alert('This action requires an internet connection.');
    return;
  }

  try {
    // 1. Delete all messages by this user across all channels
    const allChannelIds = channels.map(function(c) { return c.id; });

    // Also include all DM channels involving this user
    const usersSnap = await db.collection('users').get();
    usersSnap.docs.forEach(function(d) {
      const name = d.data().name;
      if (name !== u.name) {
        allChannelIds.push(dmChannelId(u.name, name));
      }
    });

    // Delete messages in batches
    for (var i = 0; i < allChannelIds.length; i++) {
      const chId = allChannelIds[i];
      const msgsSnap = await db.collection('channels').doc(chId)
        .collection('messages')
        .where('sender', '==', u.name)
        .get();

      const batch = db.batch();
      msgsSnap.docs.forEach(function(d) { batch.delete(d.ref); });
      if (!msgsSnap.empty) await batch.commit();

      // Clear local cache for this channel
      const cached = OfflineStore.getCachedMessages(chId);
      const filtered = cached.filter(function(m) { return m.sender !== u.name; });
      OfflineStore.cacheMessages(chId, filtered);
    }

    // 2. Delete the user document from Firestore
    if (u.id) {
      await db.collection('users').doc(u.id).delete();
    }

    // 3. Remove from local cache
    OfflineStore.removeCachedUser(u.id);

    // 4. If removing self — log out
    if (isSelf) {
      sessionStorage.removeItem('teamsUser');
      window.location.href = 'index.html';
      return;
    }

    // 5. Re-render messages if current channel had their messages
    loadChannel(state.currentChannel);

    showSyncToast('✓ ' + u.name + ' removed and history cleared.');

  } catch (err) {
    alert('Error: ' + err.message);
  }
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

// ── AVATAR PREVIEW ──────────────────────────────────────────
function previewAvatar(input) {
  if (!input.files || !input.files[0]) return;
  const file   = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    // Show in settings modal preview
    const previewImg = document.getElementById('avatarPreviewImg');
    const previewInitial = document.getElementById('avatarPreviewInitial');
    if (previewImg) {
      previewImg.src = e.target.result;
      previewImg.style.display = 'block';
      if (previewInitial) previewInitial.style.display = 'none';
    }
    // Also update the sidebar avatar immediately
    const myAvatarImg = document.getElementById('myAvatarImg');
    const myAvatarInitial = document.getElementById('myAvatarInitial');
    if (myAvatarImg) {
      myAvatarImg.src = e.target.result;
      myAvatarImg.style.display = 'block';
      if (myAvatarInitial) myAvatarInitial.style.display = 'none';
    }
    // Save to user state and cache
    state.currentUser.avatarUrl = e.target.result;
    sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
    OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));
  };
  reader.readAsDataURL(file);
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
  document.title = total > 0 ? '(' + total + ') MyHome Connect' : 'MyHome Connect';
  updateFavicon(total > 0);
  updateTaskbarBadge(total);
}

// ── TASKBAR BADGE (PWA Badging API) ──────────────────────────
function updateTaskbarBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  if (count > 0) {
    navigator.setAppBadge(count).catch(function() {});
  } else {
    navigator.clearAppBadge().catch(function() {});
  }
}

// ── FAVICON ──────────────────────────────────────────────────
function updateFavicon(hasUnread) {
  var canvas = document.createElement('canvas');
  canvas.width  = 32;
  canvas.height = 32;
  var ctx = canvas.getContext('2d');

  // Background circle
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fillStyle = hasUnread ? '#f07800' : '#6264a7';
  ctx.fill();

  // Letter P
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px Segoe UI, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', 16, 17);

  // Red dot badge when unread
  if (hasUnread) {
    ctx.beginPath();
    ctx.arc(26, 6, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 26, 6);
  }

  // Apply to favicon — remove old, create new (forces browser refresh)
  var existing = document.getElementById('favicon');
  if (existing) existing.remove();
  var link = document.createElement('link');
  link.id   = 'favicon';
  link.rel  = 'icon';
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
  document.head.appendChild(link);
}

// Clear tab title when window regains focus
window.addEventListener('focus', function() {
  state.unread[state.currentChannel] = 0;
  state.unreadSenders[state.currentChannel] = new Set();
  state.lastSender[state.currentChannel] = null;
  renderChannels();
  renderDMsFromCache();
  updateTabTitle();
  updateFavicon(false);
  setTimeout(clearUnreadMsgIdsForChannel, 500);
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
  updateFavicon(false); // set initial purple favicon

  // ── Mobile keyboard fix ──────────────────────────────────
  // When the virtual keyboard opens on mobile, scroll the input into view
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var inputBar = document.getElementById('msgInput');
      if (!inputBar) return;
      // Small delay to let the browser finish resizing
      setTimeout(function() {
        inputBar.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
    });
  }
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

// Mark a specific sender's message as read (removes bold)
function markSenderRead(msgId, senderName) {
  state.unreadMsgIds.delete(msgId);
  // Also remove all unread msg IDs from this sender in current channel
  // Re-render just that sender element without full re-render
  var el = document.getElementById('sender-' + msgId);
  if (el) {
    var replacement = document.createElement('strong');
    replacement.textContent = senderName;
    el.parentNode.replaceChild(replacement, el);
  }
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

// Subscribe lightweight listeners on all channels for cross-channel notifications
function startNotifListeners() {
  // Tear down old listeners
  state.unsubscribeNotifs.forEach(function(unsub) { unsub(); });
  state.unsubscribeNotifs = [];

  if (!isOnline()) return;

  // Build full list: group channels + DM channels from cached users
  var allChannelIds = channels.map(function(ch) {
    return { id: ch.id, label: ch.label || ('#' + ch.id) };
  });

  // Add DM channels for every known user
  var cachedUsers = OfflineStore.getCachedUsers();
  cachedUsers.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    allChannelIds.push({ id: dmId, label: u.name });
  });

  allChannelIds.forEach(function(ch) {
    // Skip the current channel — its main listener already handles it
    if (ch.id === state.currentChannel) return;

    var unsub = db.collection('channels').doc(ch.id).collection('messages')
      .orderBy('timestamp')
      .limitToLast(1)
      .onSnapshot(function(snap) {
        if (snap.empty) return;
        var doc = snap.docs[0];
        var m   = Object.assign({ id: doc.id }, doc.data());

        // Skip own messages
        if (m.sender === state.currentUser.name) return;

        // Use notifCount to detect truly new messages (not initial load)
        var key = 'notif_' + ch.id;
        var seenId = state.notifCount[key];
        if (seenId === undefined) {
          // First snapshot — just record, don't notify
          state.notifCount[key] = m.id;
          return;
        }
        if (seenId === m.id) return;
        state.notifCount[key] = m.id;

        // New message — update unread state
        state.unread[ch.id] = (state.unread[ch.id] || 0) + 1;
        if (!state.unreadSenders[ch.id]) state.unreadSenders[ch.id] = new Set();
        state.unreadSenders[ch.id].add(m.sender);
        state.lastSender[ch.id] = m.sender;
        // Record activity time for DM sort order
        state.dmLastActivity[ch.id] = Date.now();

        renderChannels();
        renderDMsFromCache();
        updateTabTitle();
        updateFavicon(true);

        var cleanText = (m.text || '')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .slice(0, 100);

        showBrowserNotification(m.sender + ' · ' + ch.label, cleanText, ch.id);
      });

    state.unsubscribeNotifs.push(unsub);
  });
}

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
    }
  });
}

function showBrowserNotification(title, body, channelId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus() && channelId === state.currentChannel) return;
  try {
    var notif = new Notification(title, {
      body: body,
      icon: 'M-LOGO.png',
      tag: channelId || 'general',
      renotify: true,
    });
    notif.onclick = function() {
      window.focus();
      if (channelId) loadChannel(channelId);
      notif.close();
    };
    // Auto-close after 6s
    setTimeout(function() { notif.close(); }, 6000);
  } catch(e) {
    // ServiceWorker notifications not available — silent fail
  }
}

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
  const memberCtx = document.getElementById('memberCtxMenu');
  if (memberCtx && !memberCtx.contains(e.target) && !e.target.classList.contains('member-menu-btn')) {
    closeMemberCtxMenu();
  }
  // Mobile: close message action menus when tapping outside
  if (window.innerWidth <= 640) {
    if (!e.target.closest('.msg-bubble')) {
      document.querySelectorAll('.msg-bubble.actions-open').forEach(function(b) {
        b.classList.remove('actions-open');
      });
    }
  }
});
