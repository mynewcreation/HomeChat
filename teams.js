// AUTH GUARD
(function() {
  if (!sessionStorage.getItem('teamsUser')) window.location.href = 'index.html';
})();

// ── NETWORK HELPERS ──────────────────────────────────────────
function isOnline() { return navigator.onLine; }

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
  quoteMsg: null,
};

// BASE CHANNELS — empty, all channels are created by users
const channels = [];

// INIT
document.addEventListener('DOMContentLoaded', async () => {
  state.currentUser = JSON.parse(sessionStorage.getItem('teamsUser'));

  document.getElementById('myName').textContent        = state.currentUser.name;
  document.getElementById('myAvatar').textContent      = state.currentUser.name[0].toUpperCase();
  document.getElementById('myAvatar').style.background = state.currentUser.color;
  updateStatusDisplay(state.currentUser.status);

  // Restore avatar photo if saved
  if (state.currentUser.avatarUrl) {
    var img = document.getElementById('myAvatarImg');
    var ini = document.getElementById('myAvatarInitial');
    if (img) { img.src = state.currentUser.avatarUrl; img.style.display = 'block'; }
    if (ini) ini.style.display = 'none';
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
  setTimeout(startNotifListeners, 1500);

  // Users listener
  state.unsubscribeUsers = db.collection('users').orderBy('name')
    .onSnapshot(function(snap) {
      const users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      _lastKnownUsers = users;
      renderDMs(users);
      renderMembers(users);
      setTimeout(startNotifListeners, 800);
      seedDmActivityFromCache(users);
    });

  window.addEventListener('beforeunload', markOffline);
});


async function loadChannelMeta() {
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
  } catch (e) {
    console.warn('Could not load channel metadata:', e.message);
  }
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

// RENDER DMs — only show users with existing conversations, sorted by most recent
function renderDMs(users, filter) {
  filter = filter || '';
  const list = document.getElementById('dmList');
  list.innerHTML = '';

  var filtered = users
    .filter(function(u) { return u.name !== state.currentUser.name; })
    .filter(function(u) { return u.name.toLowerCase().includes((filter || '').toLowerCase()); })
    // Only show if there is an existing conversation (has unread or known activity)
    .filter(function(u) {
      var dmId = dmChannelId(state.currentUser.name, u.name);
      var hasUnread  = (state.unread[dmId] || 0) > 0;
      var hasActivity = (state.dmLastActivity[dmId] || 0) > 0;
      return hasUnread || hasActivity;
    });

  // Sort: most recent activity first, then alphabetical for ties
  filtered.sort(function(a, b) {
    var dmA = dmChannelId(state.currentUser.name, a.name);
    var dmB = dmChannelId(state.currentUser.name, b.name);
    var tA  = state.dmLastActivity[dmA] || 0;
    var tB  = state.dmLastActivity[dmB] || 0;
    if (tB !== tA) return tB - tA;
    return a.name.localeCompare(b.name);
  });

  filtered.forEach(function(u) {
    const dmId      = dmChannelId(state.currentUser.name, u.name);
    const hasUnread = state.unread[dmId] > 0;

    const div = document.createElement('div');
    div.className = 'channel-item' + (dmId === state.currentChannel ? ' active' : '');
    div.onclick   = function() { loadChannelAndCloseSidebar(dmId, u.name, 'Direct message with ' + u.name); };

    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor(u.status) + ';display:inline-block;flex-shrink:0;';

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

  // Show "New Message" button to start a conversation with someone new
  renderNewDmButton(users, list);
}

// Helper to re-render DMs from current users snapshot
var _lastKnownUsers = [];
function renderDMsFromCache() {
  renderDMs(_lastKnownUsers);
}

// "New Message" button — lets user start a DM with someone they haven't talked to yet
function renderNewDmButton(allUsers, list) {
  var btn = document.createElement('button');
  btn.className = 'add-channel-btn';
  btn.textContent = '+ New Message';
  btn.style.marginTop = '6px';
  btn.onclick = function() { openNewDmModal(allUsers); };
  list.appendChild(btn);
}

// New DM modal — pick a user to start a conversation
var _newDmModal = null;

function openNewDmModal(users) {
  // Remove existing modal if any
  if (_newDmModal) _newDmModal.remove();

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'newDmModal';
  _newDmModal = overlay;

  var others = (users || _lastKnownUsers)
    .filter(function(u) { return u.name !== state.currentUser.name; });

  var rows = others.map(function(u) {
    var dmId = dmChannelId(state.currentUser.name, u.name);
    var hasMsgs = (state.dmLastActivity[dmId] || 0) > 0;
    return '<div class="new-dm-row" onclick="startDmWith(\'' + escapeHtml(u.name) + '\')">' +
      '<div class="user-avatar" style="background:' + u.color + ';width:28px;height:28px;font-size:12px;flex-shrink:0">' + u.name[0] + '</div>' +
      '<span style="flex:1;font-size:13px">' + escapeHtml(u.name) + '</span>' +
      '<span style="font-size:10px;color:' + statusColor(u.status || 'offline') + '">' + (u.status || 'offline') + '</span>' +
      (hasMsgs ? '<span style="font-size:10px;color:var(--text-muted);margin-left:6px;">existing</span>' : '') +
    '</div>';
  }).join('');

  overlay.innerHTML =
    '<div class="modal-box" style="width:min(340px,calc(100vw - 24px))">' +
      '<h3>New Message</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Choose someone to message</p>' +
      '<div style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;">' +
        rows +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn cancel" onclick="closeNewDmModal()">Cancel</button>' +
      '</div>' +
    '</div>';

  overlay.onclick = function(e) { if (e.target === overlay) closeNewDmModal(); };
  document.body.appendChild(overlay);
}

function closeNewDmModal() {
  if (_newDmModal) { _newDmModal.remove(); _newDmModal = null; }
}

function startDmWith(userName) {
  closeNewDmModal();
  var dmId = dmChannelId(state.currentUser.name, userName);
  // Mark activity so this user now appears in the DM list
  state.dmLastActivity[dmId] = Date.now();
  loadChannelAndCloseSidebar(dmId, userName, 'Direct message with ' + userName);
  renderDMsFromCache();
}

// Seed DM activity timestamps so sort order is correct on load.
// Queries Firestore once per user pair to detect existing conversations.
function seedDmActivityFromCache(users) {
  if (!users) users = _lastKnownUsers;
  users.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    if (state.dmLastActivity[dmId]) return; // already set this session

    // Check Firestore for at least one message in this DM channel
    db.collection('channels').doc(dmId).collection('messages')
      .orderBy('timestamp', 'desc').limit(1).get()
      .then(function(snap) {
        if (!snap.empty) {
          var ts = snap.docs[0].data().timestamp;
          state.dmLastActivity[dmId] = ts && ts.toDate
            ? ts.toDate().getTime()
            : Date.now();
          renderDMsFromCache();
        }
      }).catch(function() {});
  });
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

  setTimeout(startNotifListeners, 500);

  // Firestore live listener
  state.unsubscribeMessages = db
    .collection('channels').doc(id).collection('messages')
    .orderBy('timestamp')
    .onSnapshot(function(snap) {
      var msgs = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      var newCount = msgs.length;
      var oldCount = state.msgCount[id] !== undefined ? state.msgCount[id] : -1;

      if (oldCount >= 0 && newCount > oldCount) {
        var added     = newCount - oldCount;
        var newMsgs   = msgs.slice(msgs.length - added);
        var fromOthers = newMsgs.filter(function(m) { return m.sender !== state.currentUser.name; });

        if (fromOthers.length > 0) {
          if (id !== state.currentChannel) {
            state.unread[id] = (state.unread[id] || 0) + fromOthers.length;
            if (!state.unreadSenders[id]) state.unreadSenders[id] = new Set();
            fromOthers.forEach(function(m) { state.unreadSenders[id].add(m.sender); });
            renderChannels();
            renderDMsFromCache();
            updateTabTitle();
          }
          fromOthers.forEach(function(m) {
            if (m.id) state.unreadMsgIds.add(m.id);
          });
          if (fromOthers.length > 0) {
            state.lastSender[id] = fromOthers[fromOthers.length - 1].sender;
          }
          updateFavicon(true);
          fromOthers.forEach(function(m) {
            var chLabel = (channels.find(function(c) { return c.id === id; }) || {}).label || ('#' + id);
            var cleanText = (m.text || '')
              .replace(/<br\s*\/?>/gi, ' ')
              .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
              .slice(0, 100);
            showBrowserNotification(m.sender + ' · ' + chLabel, cleanText, id);
          });
        }
      }

      state.msgCount[id] = newCount;
      if (id.startsWith('dm-') && newCount > 0) {
        state.dmLastActivity[id] = Date.now();
        renderDMsFromCache();
      }
      renderMessages(msgs);
    });
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

  // Pre-compute: for each user, find the ID of the LAST message they have seen
  // so we only show the seen avatar on that one message, not all previous ones
  var lastSeenMsgPerUser = {}; // { userName: msgId }
  msgs.forEach(function(msg) {
    if (!msg.seenBy) return;
    Object.keys(msg.seenBy).forEach(function(user) {
      if (user !== state.currentUser.name) {
        lastSeenMsgPerUser[user] = msg.id; // later messages overwrite earlier ones
      }
    });
  });

  var lastLabel = null;
  msgs.forEach(function(msg) {
    var label = msgDateLabel(msg);
    if (label !== lastLabel) {
      area.appendChild(makeDateDivider(label));
      lastLabel = label;
    }
    appendMessageEl(area, msg, lastSeenMsgPerUser);
  });
  if (wasAtBottom) area.scrollTop = area.scrollHeight;

  // Mark channel as seen by current user
  markChannelSeen(state.currentChannel, msgs);

  // After rendering, schedule clearing unread IDs
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

function appendMessageEl(area, msg, lastSeenMsgPerUser) {
  const isMine   = msg.sender === state.currentUser.name;
  const group    = document.createElement('div');
  group.className = 'msg-group' + (isMine ? ' mine' : '');
  if (msg.id) group.dataset.msgId = msg.id;

  const avatarHtml = !isMine
    ? '<div class="msg-avatar" style="background:' + msg.color + '">' + msg.sender[0].toUpperCase() + '</div>'
    : '';

  // Quote block
  let quoteHtml = '';
  if (msg.quoteText) {
    quoteHtml = '<div class="msg-quote" onclick="scrollToMsg(\'' + (msg.quoteId || '') + '\')">' +
      '<strong>' + escapeHtml(msg.quoteSender || '') + '</strong>' +
      escapeHtml((msg.quoteText || '').slice(0, 120)) +
    '</div>';
  }

  let content = quoteHtml + (msg.text ? renderText(msg.text) : '');
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

  // Actions: SVG icons
  var svgReply  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>';
  var svgLike   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>';
  var svgHeart  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
  var svgLaugh  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  var svgEdit   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  var svgDelete = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

  const quoteAction  = msg.id
    ? '<span class="ma-btn" onclick="quoteMessage(\'' + msg.id + '\')" title="Reply">' + svgReply + '</span>'
    : '';
  const editAction   = isMine && msg.id
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
      senderHtml = '<strong class="sender-unread" id="sender-' + msg.id + '" onclick="markSenderRead(\'' + msg.id + '\',\'' + escapeHtml(msg.sender) + '\')" title="Click to mark as read">' + escapeHtml(msg.sender) + '</strong>';
    } else {
      senderHtml = '<strong>' + escapeHtml(msg.sender) + '</strong>';
    }
  }

  // Seen indicator — only show on the LAST message seen by each user
  var seenHtml = '';
  if (isMine && msg.id && lastSeenMsgPerUser) {
    // Collect users for whom THIS is their last-seen message
    var seenUsers = Object.keys(lastSeenMsgPerUser).filter(function(u) {
      return lastSeenMsgPerUser[u] === msg.id;
    });
    if (seenUsers.length > 0) {
      var seenAvatars = seenUsers.map(function(u) {
        var color = getUserColor(u);
        return '<span class="seen-avatar" style="background:' + color + '" title="Seen by ' + escapeHtml(u) + '">' + u[0].toUpperCase() + '</span>';
      }).join('');
      seenHtml = '<div class="seen-row">' + seenAvatars + '</div>';
    }
  }

  group.innerHTML =
    avatarHtml +
    '<div class="msg-content">' +
      '<div class="msg-meta">' +
        (isMine ? '' : senderHtml) +
        '<span>' + (msg.timestamp && msg.timestamp.toDate ? formatTime(msg.timestamp.toDate()) : msg.time) + '</span>' +
        editedTag +
      '</div>' +
      '<div class="msg-bubble" id="bubble-' + (msg.id || '') + '">' +
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
      seenHtml +
    '</div>';

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

  // If there's a file pending, upload it — caption text is included in the same message
  if (_pendingFile) {
    input.value = '';
    autoResize(input);
    await uploadPendingFile(text);
    return;
  }

  if (!text) return;
  input.value = '';
  autoResize(input);

  const msg = {
    sender:    state.currentUser.name,
    color:     state.currentUser.color,
    text:      text,
    time:      formatTime(new Date()),
    reactions: [],
  };

  if (state.quoteMsg) {
    msg.quoteId     = state.quoteMsg.id || '';
    msg.quoteSender = state.quoteMsg.sender || '';
    msg.quoteText   = (state.quoteMsg.text || '').slice(0, 200);
    cancelQuote();
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

// FILE ATTACH — preview before send
var _pendingFile = null;

function cancelFileAttach() {
  _pendingFile = null;
  document.getElementById('filePreviewBar').style.display = 'none';
  document.getElementById('filePreviewInner').innerHTML = '';
  document.getElementById('fileInput').value = '';
}

async function attachFile(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  _pendingFile = file;

  // Show preview
  const bar   = document.getElementById('filePreviewBar');
  const inner = document.getElementById('filePreviewInner');
  bar.style.display = 'flex';

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = function(e) {
      inner.innerHTML =
        '<img src="' + e.target.result + '" class="fp-img" alt="' + escapeHtml(file.name) + '">' +
        '<span class="fp-name">' + escapeHtml(file.name) + '</span>';
    };
    reader.readAsDataURL(file);
  } else {
    inner.innerHTML =
      '<span class="fp-icon">📎</span>' +
      '<span class="fp-name">' + escapeHtml(file.name) + '</span>' +
      '<span class="fp-size">(' + formatFileSize(file.size) + ')</span>';
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function uploadPendingFile(caption) {
  if (!_pendingFile) return;
  const file = _pendingFile;
  const isImage = file.type.startsWith('image/');
  caption = caption || '';
  cancelFileAttach();

  // Show a temp message immediately in the UI
  const area   = document.getElementById('messagesArea');
  const tempId = 'temp-' + Date.now();

  if (isImage) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const tempMsg = {
        id:        tempId,
        sender:    state.currentUser.name,
        color:     state.currentUser.color,
        text:      caption,
        file:      file.name,
        fileUrl:   e.target.result,
        fileType:  file.type,
        time:      formatTime(new Date()),
        timestamp: { toDate: function() { return new Date(); } },
        reactions: [],
      };
      appendMessageEl(area, tempMsg);
      area.scrollTop = area.scrollHeight;
    };
    reader.readAsDataURL(file);
  } else {
    const tempMsg = {
      id:        tempId,
      sender:    state.currentUser.name,
      color:     state.currentUser.color,
      text:      caption,
      file:      file.name,
      fileUrl:   null,
      fileType:  file.type,
      time:      formatTime(new Date()),
      timestamp: { toDate: function() { return new Date(); } },
      reactions: [],
    };
    appendMessageEl(area, tempMsg);
    area.scrollTop = area.scrollHeight;
  }

  // Upload to Firebase Storage
  try {
    const path = 'uploads/' + state.currentChannel + '/' + Date.now() + '_' + file.name;
    const ref  = storage.ref(path);
    await ref.put(file);
    const url  = await ref.getDownloadURL();

    // Remove temp message — onSnapshot will render the real one
    var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
    if (tempEl) tempEl.remove();

    // Build message — include caption and quote if set
    var firestoreMsg = {
      sender:    state.currentUser.name,
      color:     state.currentUser.color,
      text:      caption,
      file:      file.name,
      fileUrl:   url,
      fileType:  file.type,
      time:      formatTime(new Date()),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      reactions: [],
    };

    if (state.quoteMsg) {
      firestoreMsg.quoteId     = state.quoteMsg.id || '';
      firestoreMsg.quoteSender = state.quoteMsg.sender || '';
      firestoreMsg.quoteText   = (state.quoteMsg.text || '').slice(0, 200);
      cancelQuote();
    }

    await db.collection('channels').doc(state.currentChannel).collection('messages').add(firestoreMsg);

  } catch (err) {
    var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
    if (tempEl) tempEl.remove();
    alert('Upload failed: ' + err.message);
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
  var btn    = document.querySelector('.emoji-btn');
  var isOpen = picker.classList.contains('show');

  if (isOpen) {
    picker.classList.remove('show');
    return;
  }

  // Position picker above the emoji button
  if (btn) {
    var rect = btn.getBoundingClientRect();
    var pickerW = Math.min(320, window.innerWidth - 20);
    var left = Math.max(8, rect.right - pickerW);
    var bottom = window.innerHeight - rect.top + 8;
    picker.style.left   = left + 'px';
    picker.style.bottom = bottom + 'px';
    picker.style.right  = 'auto';
    picker.style.width  = pickerW + 'px';
  }

  picker.classList.add('show');
  // Populate on open
  _emojiData.recent = _emojiRecent.slice(0, 32);
  var cat = _emojiData.recent.length > 0 ? 'recent' : 'smileys';
  var tabs = document.querySelectorAll('.ep-tab');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  tabs[_emojiData.recent.length > 0 ? 0 : 1].classList.add('active');
  _currentEmojiCat = cat;
  renderEmojiGrid(_emojiData[cat]);
  document.getElementById('epSearch').value = '';
  setTimeout(function() { document.getElementById('epSearch').focus(); }, 50);
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
function setSidebarIconState(isOpen) {
  var btn = document.getElementById('hamburgerBtn');
  if (!btn) return;
  btn.textContent = isOpen ? '←' : '☰';
}

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const isMobile = window.innerWidth <= 640;

  if (isMobile) {
    const isOpen = sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', !isOpen);
    backdrop.classList.toggle('show', !isOpen);
    setSidebarIconState(!isOpen);
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function closeSidebarMobile() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
  setSidebarIconState(false);
}

// Close sidebar when a channel is tapped on mobile
function loadChannelAndCloseSidebar(id, title, desc) {
  if (window.innerWidth <= 640) closeSidebarMobile();
  loadChannel(id, title, desc);
}

function toggleMembers()  { document.getElementById('membersPanel').classList.toggle('open'); }

function filterChannels(val) {
  renderChannels(val);
  renderDMs(_lastKnownUsers, val);
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
    }

    // 2. Delete the user document from Firestore
    if (u.id) {
      await db.collection('users').doc(u.id).delete();
    }

    // 3. If removing self — log out
    if (isSelf) {
      sessionStorage.removeItem('teamsUser');
      window.location.href = 'index.html';
      return;
    }

    // 4. Re-render messages if current channel had their messages
    loadChannel(state.currentChannel);

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
  if (state.currentUser.id) {
    await db.collection('users').doc(state.currentUser.id).update({
      status: status,
      name: state.currentUser.name,
    }).catch(function() {});
  }
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

// ── AVATAR PREVIEW & UPLOAD ──────────────────────────────────
function previewAvatar(input) {
  if (!input.files || !input.files[0]) return;
  const file   = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    // Show preview immediately
    const previewImg     = document.getElementById('avatarPreviewImg');
    const previewInitial = document.getElementById('avatarPreviewInitial');
    if (previewImg) {
      previewImg.src = e.target.result;
      previewImg.style.display = 'block';
      if (previewInitial) previewInitial.style.display = 'none';
    }
    const myAvatarImg     = document.getElementById('myAvatarImg');
    const myAvatarInitial = document.getElementById('myAvatarInitial');
    if (myAvatarImg) {
      myAvatarImg.src = e.target.result;
      myAvatarImg.style.display = 'block';
      if (myAvatarInitial) myAvatarInitial.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);

  // Upload to Firebase Storage
  if (state.currentUser.id) {
    const path = 'avatars/' + state.currentUser.id + '_' + Date.now();
    const ref  = storage.ref(path);
    ref.put(file).then(function() {
      return ref.getDownloadURL();
    }).then(function(url) {
      state.currentUser.avatarUrl = url;
      sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
      db.collection('users').doc(state.currentUser.id).update({ avatarUrl: url }).catch(function() {});
    }).catch(function(err) {
      console.warn('Avatar upload failed:', err.message);
    });
  }
}

// LOGOUT
async function logout() {
  await markOffline();
  state.unsubscribeNotifs.forEach(function(u) { u(); });
  state.unsubscribeNotifs = [];
  if (state.unsubscribeMessages) { state.unsubscribeMessages(); state.unsubscribeMessages = null; }
  if (state.unsubscribeUsers) { state.unsubscribeUsers(); state.unsubscribeUsers = null; }
  sessionStorage.removeItem('teamsUser');
  window.location.href = 'index.html';
}

async function markOffline() {
  if (state.currentUser.id) {
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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert URLs in already-escaped text to clickable links
function linkify(escapedText) {
  // Match http/https URLs (already HTML-escaped so & is &amp; etc.)
  var urlPattern = /(https?:\/\/[^\s<>"']+)/g;
  return escapedText.replace(urlPattern, function(url) {
    // Decode &amp; back for the href attribute
    var href = url.replace(/&amp;/g, '&');
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" class="msg-link">' + url + '</a>';
  });
}

// Escape HTML then convert newlines and linkify
function renderText(str) {
  var escaped = escapeHtml(str);
  // Convert newlines to <br>
  escaped = escaped.replace(/\n/g, '<br>');
  // Make URLs clickable
  return linkify(escaped);
}

// Get a user's color (for seen avatars)
function getUserColor(name) {
  var u = _lastKnownUsers.find(function(u) { return u.name === name; });
  return u ? u.color : '#6264a7';
}

// Mark this channel as seen by current user
function markChannelSeen(channelId, msgs) {
  if (!msgs || msgs.length === 0) return;
  var lastMsg = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].id) { lastMsg = msgs[i]; break; }
  }
  if (!lastMsg || !lastMsg.id) return;
  if (lastMsg.sender === state.currentUser.name) return;

  var seenBy = lastMsg.seenBy || {};
  if (seenBy[state.currentUser.name]) return;

  var update = {};
  update['seenBy.' + state.currentUser.name] = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('channels').doc(channelId)
    .collection('messages').doc(lastMsg.id)
    .update(update)
    .catch(function() {});
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

// Call on load
document.addEventListener('DOMContentLoaded', function() {
  checkNotificationPermission();
  updateFavicon(false);

  // Mobile keyboard fix — scroll input into view when virtual keyboard opens
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var inputBar = document.getElementById('msgInput');
      if (!inputBar) return;
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
    text: newText,   // store raw
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

// Subscribe a SINGLE collection-group listener for cross-channel notifications.
// This replaces the old approach of one listener per channel, which was burning
// through Firestore read quota (N channels × N DMs = dozens of open listeners).
function startNotifListeners() {
  // Tear down old listeners
  state.unsubscribeNotifs.forEach(function(unsub) { unsub(); });
  state.unsubscribeNotifs = [];

  // Build a label lookup so we can show the channel name in notifications
  var labelMap = {};
  channels.forEach(function(ch) { labelMap[ch.id] = ch.label || ('#' + ch.id); });
  _lastKnownUsers.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    labelMap[dmId] = u.name;
  });

  // One collection-group query across ALL "messages" sub-collections.
  // We only look at messages newer than "now" so we don't re-read history.
  var listenFrom = firebase.firestore.Timestamp.now();

  var unsub = db.collectionGroup('messages')
    .where('timestamp', '>', listenFrom)
    .orderBy('timestamp')
    .onSnapshot(function(snap) {
      snap.docChanges().forEach(function(change) {
        if (change.type !== 'added') return;

        var doc = change.doc;
        var m   = Object.assign({ id: doc.id }, doc.data());

        // Skip own messages
        if (m.sender === state.currentUser.name) return;

        // Derive the channel ID from the document path:
        // channels/{channelId}/messages/{msgId}
        var pathParts = doc.ref.path.split('/');
        var chId = pathParts[1]; // index 1 = channelId

        // Skip the currently open channel — its main listener handles it
        if (chId === state.currentChannel) return;

        // Update unread state
        state.unread[chId] = (state.unread[chId] || 0) + 1;
        if (!state.unreadSenders[chId]) state.unreadSenders[chId] = new Set();
        state.unreadSenders[chId].add(m.sender);
        state.lastSender[chId] = m.sender;
        if (chId.startsWith('dm-')) state.dmLastActivity[chId] = Date.now();

        renderChannels();
        renderDMsFromCache();
        updateTabTitle();
        updateFavicon(true);

        var chLabel = labelMap[chId] || ('#' + chId);
        var cleanText = (m.text || '')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .slice(0, 100);

        showBrowserNotification(m.sender + ' · ' + chLabel, cleanText, chId);
      });
    }, function(err) {
      // Collection-group queries require a Firestore index.
      // If the index doesn't exist yet, fall back silently — notifications
      // will still work for the active channel via its own listener.
      console.warn('Notif listener error (index may be missing):', err.message);
    });

  state.unsubscribeNotifs.push(unsub);
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
  if (picker && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
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
