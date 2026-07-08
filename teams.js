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
  _initMsgActionsDelegation(); // set up delegated right-click / long-press listeners once
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

  // Start notification listeners — once, after initial data is ready
  setTimeout(startNotifListeners, 800);

  // Start listening for incoming video calls
  setTimeout(startIncomingCallListener, 1500);

  // Users listener — debounce expensive re-renders so rapid status changes don't thrash the DOM
  var _usersRenderTimer = null;
  state.unsubscribeUsers = db.collection('users').orderBy('name')
    .onSnapshot(function(snap) {
      // Handle removals immediately
      snap.docChanges().forEach(function(change) {
        if (change.type === 'removed') {
          _lastKnownUsers = _lastKnownUsers.filter(function(u) {
            return u.id !== change.doc.id;
          });
        }
      });
      const users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      _lastKnownUsers = users;

      // Debounce: batch rapid user updates (e.g. multiple status changes) into one render
      clearTimeout(_usersRenderTimer);
      _usersRenderTimer = setTimeout(function() {
        renderDMs(users);
        renderMembers(users);
        seedDmActivityFromCache(users);
        startNotifListeners(); // guard inside ensures it only runs once
      }, 300);
    });

  window.addEventListener('beforeunload', markOffline);

  // Mark current channel as seen when user returns to the window
  function _onWindowActive() {
    if (document.hidden || !document.hasFocus()) return;
    clearUnreadMsgIdsForChannel();
    // Use already-rendered messages from the DOM — no extra Firestore fetch needed
    if (state.currentChannel) {
      var area  = document.getElementById('messagesArea');
      var groups = area ? area.querySelectorAll('.msg-group[data-msg-id]') : [];
      if (groups.length > 0) {
        var lastGroup = groups[groups.length - 1];
        var lastId    = lastGroup.dataset.msgId;
        var isMine    = lastGroup.classList.contains('mine');
        if (lastId && !isMine) {
          // Mark this message as seen
          var update = {};
          update['seenBy.' + state.currentUser.name] = firebase.firestore.FieldValue.serverTimestamp();
          db.collection('channels').doc(state.currentChannel)
            .collection('messages').doc(lastId)
            .update(update).catch(function() {});
        }
      }
      state.unread[state.currentChannel] = 0;
      state.unreadSenders[state.currentChannel] = new Set();
      renderChannels();
      renderDMsFromCache();
      updateTabTitle();
    }
  }

  window.addEventListener('focus', _onWindowActive);
  document.addEventListener('visibilitychange', _onWindowActive);
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

// DM nickname overrides — stored locally per user session
var _dmNicknames = JSON.parse(localStorage.getItem('mhc_dm_nicknames') || '{}');

function getDmNickname(userName) {
  return _dmNicknames[userName] || userName;
}

function saveDmNickname(userName, nickname) {
  nickname = nickname.trim();
  if (nickname && nickname !== userName) {
    _dmNicknames[userName] = nickname;
  } else {
    delete _dmNicknames[userName];
  }
  localStorage.setItem('mhc_dm_nicknames', JSON.stringify(_dmNicknames));
}

// RENDER DMs — show ALL users (with or without existing conversation)
function renderDMs(users, filter) {
  filter = filter || '';
  const list = document.getElementById('dmList');
  list.innerHTML = '';

  var filtered = users
    .filter(function(u) { return u.name !== state.currentUser.name; })
    .filter(function(u) {
      var displayName = getDmNickname(u.name).toLowerCase();
      var realName    = u.name.toLowerCase();
      var f = (filter || '').toLowerCase();
      return displayName.includes(f) || realName.includes(f);
    });

  // Sort: most recent activity first, then alphabetical
  filtered.sort(function(a, b) {
    var dmA = dmChannelId(state.currentUser.name, a.name);
    var dmB = dmChannelId(state.currentUser.name, b.name);
    var tA  = state.dmLastActivity[dmA] || 0;
    var tB  = state.dmLastActivity[dmB] || 0;
    if (tB !== tA) return tB - tA;
    return getDmNickname(a.name).localeCompare(getDmNickname(b.name));
  });

  filtered.forEach(function(u) {
    const dmId      = dmChannelId(state.currentUser.name, u.name);
    const hasUnread = state.unread[dmId] > 0;
    const nickname  = getDmNickname(u.name);

    const div = document.createElement('div');
    div.className = 'channel-item' + (dmId === state.currentChannel ? ' active' : '');
    div.onclick   = function() { loadChannelAndCloseSidebar(dmId, nickname, 'Direct message with ' + nickname); };

    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor(u.status) + ';display:inline-block;flex-shrink:0;';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = nickname;
    nameSpan.className = hasUnread ? 'ch-label unread-item' : 'ch-label';

    div.appendChild(dot);
    div.appendChild(nameSpan);

    if (hasUnread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = state.unread[dmId];
      div.appendChild(badge);
    }

    // ··· menu button
    const menuBtn = document.createElement('span');
    menuBtn.className = 'ch-menu-btn';
    menuBtn.textContent = '···';
    menuBtn.title = 'Options';
    menuBtn.onclick = function(e) { e.stopPropagation(); openDmCtxMenu(e, u); };
    div.appendChild(menuBtn);

    list.appendChild(div);
  });
}

// Helper to re-render DMs from current users snapshot
var _lastKnownUsers = [];
function renderDMsFromCache() {
  renderDMs(_lastKnownUsers);
}

// ── DM CONTEXT MENU ──────────────────────────────────────────
var _ctxDmUser = null;

var _dmCtxMenu = null;
function _getDmCtxMenu() {
  if (!_dmCtxMenu) {
    _dmCtxMenu = document.createElement('div');
    _dmCtxMenu.className = 'ctx-menu';
    _dmCtxMenu.id = 'dmCtxMenu';
    _dmCtxMenu.innerHTML =
      '<div class="ctx-item" onclick="openDmRenameModal()">✏️ Rename (view only)</div>' +
      '<div class="ctx-item" onclick="deleteDmForMe()">🙈 Delete for Me</div>' +
      '<div class="ctx-item danger" onclick="deleteDmConversation()">🗑️ Delete for Everyone</div>';
    document.body.appendChild(_dmCtxMenu);
  }
  return _dmCtxMenu;
}

function openDmCtxMenu(e, user) {
  _ctxDmUser = user;
  var menu = _getDmCtxMenu();
  menu.classList.add('show');
  var x = Math.min(e.clientX, window.innerWidth  - 220);
  var y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeDmCtxMenu() {
  var menu = _getDmCtxMenu();
  if (menu) menu.classList.remove('show');
  _ctxDmUser = null;
}

// Rename — view only, stored in localStorage
function openDmRenameModal() {
  var u = _ctxDmUser;
  closeDmCtxMenu();
  if (!u) return;
  var current = getDmNickname(u.name);

  // Build inline modal
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.innerHTML =
    '<div class="modal-box" style="width:min(320px,calc(100vw - 24px))">' +
      '<h3>Rename Contact</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">Only visible to you. Real name: <strong>' + escapeHtml(u.name) + '</strong></p>' +
      '<div class="form-group" style="margin-bottom:16px;">' +
        '<input type="text" id="dmRenameInput" placeholder=" " value="' + escapeHtml(current) + '">' +
        '<label>Display Name</label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn cancel" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn confirm" onclick="saveDmRename(this,\'' + escapeHtml(u.name) + '\')">Save</button>' +
      '</div>' +
    '</div>';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  setTimeout(function() {
    var inp = document.getElementById('dmRenameInput');
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}

function saveDmRename(btn, realName) {
  var inp = document.getElementById('dmRenameInput');
  if (!inp) return;
  saveDmNickname(realName, inp.value);
  btn.closest('.modal-overlay').remove();
  renderDMsFromCache();
  // If this DM is currently open, update the topbar title
  var dmId = dmChannelId(state.currentUser.name, realName);
  if (state.currentChannel === dmId) {
    var nickname = getDmNickname(realName);
    document.getElementById('channelTitle').textContent = nickname;
    document.getElementById('channelDesc').textContent  = 'Direct message with ' + nickname;
  }
}

// Delete conversation for me only — marks all messages with deletedFor so only I stop seeing them
async function deleteDmForMe() {
  var u = _ctxDmUser;
  closeDmCtxMenu();
  if (!u) return;

  var nickname = getDmNickname(u.name);
  if (!confirm('Hide this conversation with "' + nickname + '" from your view? The other person will not be affected.')) return;

  var dmId = dmChannelId(state.currentUser.name, u.name);
  var me   = state.currentUser.name;
  try {
    var snap = await db.collection('channels').doc(dmId).collection('messages').get();
    // Batch update all messages — add current user to deletedFor
    var batchSize = 0;
    var batch = db.batch();
    snap.docs.forEach(function(d) {
      var data = d.data();
      var df = data.deletedFor || [];
      if (!df.includes(me)) {
        batch.update(d.ref, { deletedFor: firebase.firestore.FieldValue.arrayUnion(me) });
        batchSize++;
      }
    });
    if (batchSize > 0) await batch.commit();

    // If currently viewing this DM, clear the message area for this user
    if (state.currentChannel === dmId) {
      document.getElementById('messagesArea').innerHTML =
        '<div style="text-align:center;color:#aaa;margin-top:40px;font-size:14px;">No messages yet. Say hello!</div>';
    }
    renderDMsFromCache();
  } catch(err) {
    alert('Error: ' + err.message);
  }
}

// Delete conversation for everyone — removes messages from Firestore
async function deleteDmConversation() {
  var u = _ctxDmUser;
  closeDmCtxMenu();
  if (!u) return;

  var nickname = getDmNickname(u.name);
  if (!confirm('Delete conversation with "' + nickname + '" for EVERYONE? This removes all messages permanently and cannot be undone.')) return;

  var dmId = dmChannelId(state.currentUser.name, u.name);
  try {
    var snap = await db.collection('channels').doc(dmId).collection('messages').get();
    var batch = db.batch();
    snap.docs.forEach(function(d) { batch.delete(d.ref); });
    if (!snap.empty) await batch.commit();

    // Clear local activity so DM stays visible but shows empty
    state.dmLastActivity[dmId] = 0;

    // If currently viewing this DM, clear the message area
    if (state.currentChannel === dmId) {
      document.getElementById('messagesArea').innerHTML =
        '<div style="text-align:center;color:#aaa;margin-top:40px;font-size:14px;">No messages yet. Say hello!</div>';
    }
    renderDMsFromCache();
  } catch(err) {
    alert('Error deleting conversation: ' + err.message);
  }
}

// Close DM ctx menu when clicking outside
document.addEventListener('mousedown', function(e) {
  if (!e.target.closest('#dmCtxMenu') && !e.target.closest('.ch-menu-btn')) {
    closeDmCtxMenu();
  }
});

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

    // Add ... menu button: admin can manage all users; anyone can remove themselves
    if (isSelf || isAdmin) {
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

  // Firestore live listener
  state.unsubscribeMessages = db
    .collection('channels').doc(id).collection('messages')
    .orderBy('timestamp')
    .onSnapshot(function(snap) {
      var msgs = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      var newCount = msgs.length;
      var oldCount = state.msgCount[id] !== undefined ? state.msgCount[id] : -1;
      var isFirstLoad = oldCount < 0;

      if (oldCount >= 0 && newCount > oldCount) {
        var added      = newCount - oldCount;
        var newMsgs    = msgs.slice(msgs.length - added);
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
          fromOthers.forEach(function(m) { if (m.id) state.unreadMsgIds.add(m.id); });
          state.lastSender[id] = fromOthers[fromOthers.length - 1].sender;
          updateFavicon(true);
        }
      }

      state.msgCount[id] = newCount;
      if (id.startsWith('dm-') && newCount > 0) {
        state.dmLastActivity[id] = Date.now();
        // Only re-sort DM list, don't call heavy renderDMsFromCache on every message
        if (!isFirstLoad) renderDMsFromCache();
      }

      // ── Incremental render: append only new messages instead of full rebuild ──
      var area = document.getElementById('messagesArea');
      var hasExistingContent = area && area.querySelector('.msg-group');

      if (!isFirstLoad && hasExistingContent && newCount > oldCount) {
        // Only new messages added — append them without wiping the DOM
        var added   = newCount - oldCount;
        var newMsgs = msgs.slice(msgs.length - added);
        var wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;

        // Remove any optimistic temp elements for messages that now have a real ID
        // (the Firestore snapshot has returned with the committed message)
        newMsgs.forEach(function(msg) {
          if (msg.sender !== state.currentUser.name) return;
          // Find any temp element with the same text content sent by me
          area.querySelectorAll('[data-temp-msg="1"]').forEach(function(el) {
            var bubble = el.querySelector('.msg-bubble');
            var tempText = bubble ? (bubble.innerText || bubble.textContent || '').trim() : '';
            // Match by text — remove the first matching temp so the real one replaces it
            if (tempText && msg.text && tempText.startsWith(msg.text.slice(0, 50).trim())) {
              el.remove();
            }
          });
        });

        // Pre-compute lastSeenMsgPerUser for seen indicators
        var lastSeenMsgPerUser = {};
        msgs.forEach(function(msg) {
          if (!msg.seenBy) return;
          Object.keys(msg.seenBy).forEach(function(user) {
            if (user !== state.currentUser.name) lastSeenMsgPerUser[user] = msg.id;
          });
        });

        newMsgs.forEach(function(msg) {
          if (msg.deletedFor && msg.deletedFor.includes(state.currentUser.name)) return;
          // Insert date divider if the date has changed
          var label    = msgDateLabel(msg);
          var dividers = area.querySelectorAll('.date-divider');
          var lastDiv  = dividers.length ? dividers[dividers.length - 1] : null;
          if (!lastDiv || lastDiv.textContent !== label) {
            area.appendChild(makeDateDivider(label));
          }
          appendMessageEl(area, msg, lastSeenMsgPerUser);
        });

        if (wasAtBottom) area.scrollTop = area.scrollHeight;
        markChannelSeen(state.currentChannel, msgs);

        // Schedule clearing unread highlights
        setTimeout(function() {
          if (document.hasFocus() && !document.hidden) clearUnreadMsgIdsForChannel();
        }, 3000);
      } else {
        // Full render: initial load, deletion, reaction update, seen update, etc.
        // Remove temp elements before full render so there are no duplicates
        if (area) {
          area.querySelectorAll('[data-temp-msg="1"]').forEach(function(el) { el.remove(); });
        }
        renderMessages(msgs);
      }
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

  // Clean up any optimistic temp elements before full rebuild
  area.querySelectorAll('[data-temp-msg="1"]').forEach(function(el) { el.remove(); });

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
    // Skip messages the current user has hidden for themselves
    if (msg.deletedFor && msg.deletedFor.includes(state.currentUser.name)) return;

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

  // After rendering, schedule clearing unread IDs — only if window is active
  setTimeout(function() {
    if (document.hasFocus() && !document.hidden) {
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
  // If emoji-only, mark the bubble so CSS can remove the background
  const emojiOnly = msg.text && !msg.quoteText && !msg.fileUrl && !msg.file && isEmojiOnly(msg.text);
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

  // Sender name — bold+orange if this message is unread, clickable to mark read
  var senderHtml = '';
  if (!isMine) {
    var isUnread = msg.id && state.unreadMsgIds.has(msg.id);
    if (isUnread) {
      senderHtml = '<strong class="sender-unread" id="sender-' + msg.id + '" title="Click to mark as read">' + escapeHtml(msg.sender) + '</strong>';
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
      '<div class="msg-bubble' + (emojiOnly ? ' emoji-bubble' : '') + '" id="bubble-' + (msg.id || '') + '">' +
        content +
      '</div>' +
      '<div class="reactions">' + reactions + '</div>' +
      seenHtml +
    '</div>';

  area.appendChild(group);

  // Wire sender name click (mark unread as read)
  if (!isMine && msg.id) {
    var senderEl = group.querySelector('.sender-unread');
    if (senderEl) {
      senderEl.addEventListener('click', function() {
        markSenderRead(msg.id, msg.sender);
      });
    }
  }
  // contextmenu (desktop) and touch long-press (mobile) are handled by
  // delegated listeners on document/messagesArea — see _initMsgActionsDelegation()
}

// ── GLOBAL FLOATING MESSAGE ACTION BAR ───────────────────────────────────────
// Single shared bar that moves to the cursor on right-click / long-press.

// ── Delegated event listeners for message actions ────────────────────────────
// Attached once to document/messagesArea — survive DOM rebuilds from renderMessages.
var _msgActionsDelegated = false;
var _barJustOpened = false; // prevents the same gesture that opens the bar from closing it

function _initMsgActionsDelegation() {
  if (_msgActionsDelegated) return;
  _msgActionsDelegated = true;

  // ── Desktop: right-click on any .msg-content ──────────────────────────────
  document.addEventListener('contextmenu', function(e) {
    if (e.target.tagName === 'A') return;
    if (e.target.closest('#globalMsgActionsBar') || e.target.closest('#msgEmojiPicker')) return;

    var msgContent = e.target.closest('.msg-content');
    if (!msgContent) return;

    if (_isTouchDevice()) { e.preventDefault(); return; }

    e.preventDefault();

    var group = msgContent.closest('.msg-group');
    if (!group) return;

    _showBarForGroup(group, e.clientX, e.clientY);
  });

  // ── Desktop: close bar on outside left-click ─────────────────────────────
  document.addEventListener('mousedown', function(e) {
    if (e.button === 2) return; // right-click handled by contextmenu
    if (_barJustOpened) { _barJustOpened = false; return; }
    if (e.target.closest('#globalMsgActionsBar') ||
        e.target.closest('#globalDelMenu') ||
        e.target.closest('#msgEmojiPicker')) return;
    hideMsgActionsBar();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideMsgActionsBar();
  });

  // ── Mobile: long-press on any .msg-bubble ─────────────────────────────────
  var _touchTimer = null;
  var _touchStartX = 0, _touchStartY = 0, _touchMoved = false;

  document.addEventListener('touchstart', function(e) {
    // Close bar on outside tap — but not on the same touch that opens it
    if (_msgActionsBar && _msgActionsBar.classList.contains('actions-open')) {
      if (!e.target.closest('#globalMsgActionsBar') &&
          !e.target.closest('#globalDelMenu') &&
          !e.target.closest('#msgEmojiPicker')) {
        // Only close if this touch is NOT on a bubble (which would re-open)
        if (!e.target.closest('.msg-bubble')) {
          setTimeout(hideMsgActionsBar, 10);
          return;
        }
      }
    }

    var bubble = e.target.closest('.msg-bubble');
    if (!bubble) return;
    if (e.target.tagName === 'A') return;
    if (e.target.closest('#globalMsgActionsBar') || e.target.closest('#msgEmojiPicker')) return;

    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    _touchMoved  = false;

    clearTimeout(_touchTimer);
    _touchTimer = setTimeout(function() {
      _touchTimer = null;
      if (_touchMoved) return;
      var group = bubble.closest('.msg-group');
      if (!group || !group.isConnected) return; // DOM was rebuilt
      _barJustOpened = true;
      _showBarForGroup(group, _touchStartX, _touchStartY);
      setTimeout(function() { _barJustOpened = false; }, 50);
    }, 700);
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!_touchTimer) return;
    var dx = e.touches[0].clientX - _touchStartX;
    var dy = e.touches[0].clientY - _touchStartY;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      _touchMoved = true;
      clearTimeout(_touchTimer);
      _touchTimer = null;
    }
  }, { passive: true });

  document.addEventListener('touchend',    function() { clearTimeout(_touchTimer); _touchTimer = null; }, { passive: true });
  document.addEventListener('touchcancel', function() { clearTimeout(_touchTimer); _touchTimer = null; }, { passive: true });
}

// Resolve msg from the live DOM group and open the action bar
function _showBarForGroup(group, clientX, clientY) {
  var msgId  = group.dataset.msgId;
  var isMine = group.classList.contains('mine');
  if (!msgId) return;

  var bubble   = group.querySelector('.msg-bubble');
  var metaName = group.querySelector('.msg-meta strong');

  var msgText = '';
  if (bubble) {
    var clone = bubble.cloneNode(true);
    var q = clone.querySelector('.msg-quote'); if (q) q.remove();
    msgText = (clone.innerText || clone.textContent || '').trim();
  }

  showMsgActionsBar(clientX, clientY, {
    id:     msgId,
    text:   msgText,
    sender: metaName ? metaName.textContent.trim() : '',
  }, isMine);
}

function _isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

var _msgActionsBar = null;   // the DOM element
var _msgActionsBarSvg = {
  reply:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>',
  like:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>',
  heart:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
  laugh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  copy:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  edit:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  del:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
};

function _getMsgActionsBar() {
  if (!_msgActionsBar) {
    _msgActionsBar = document.createElement('div');
    _msgActionsBar.className = 'msg-actions';
    _msgActionsBar.id = 'globalMsgActionsBar';
    document.body.appendChild(_msgActionsBar);
  }
  return _msgActionsBar;
}

function hideMsgActionsBar() {
  var bar = _msgActionsBar;
  if (!bar) return;
  bar.classList.remove('actions-open');
  bar.querySelectorAll('.del-menu.show').forEach(function(m) { m.classList.remove('show'); });
  closeMsgEmojiPicker();
}

// ── MORE EMOJI PICKER ────────────────────────────────────────
var _msgEmojiPicker = null;

var _allReactEmoji = [
  '😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘',
  '😗','🙂','🤗','🤩','🤔','😐','😶','🙄','😏','😣','😥','😮','😯','😪','😫',
  '😴','😌','😛','😜','😝','😒','😓','😔','😕','🙃','😲','☹️','😖','😞','😟',
  '😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','😳','😵','😠','😡',
  '🤬','😷','🤒','🤕','🤢','🤮','🤧','🥳','🥺','🥴',
  '👍','👎','👏','🙌','🤝','🙏','✌️','🤞','🤟','🤘','👌','🤌','👈','👉',
  '👆','👇','☝️','✋','🤚','🖐️','💪','🫂',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓',
  '💗','💖','💘','💝','💯','🔥','⭐','✨','💫','🎉','🎊','🎈','🎁','🏆',
  '👑','💎','🌈','☀️','🌙','⚡','❄️','🌸','🌹','🍀','🎵','🎶',
  '🍕','🍔','🍟','🌮','🍜','🍣','🍰','🎂','🍫','🍬','🍭','☕','🧋','🍺','🥂',
  '🐶','🐱','🐰','🦊','🐻','🐼','🐸','🦋','🐙',
];

function toggleMsgEmojiPicker(anchorBtn, msgId) {
  // Toggle off if already open
  if (_msgEmojiPicker) { closeMsgEmojiPicker(); return; }

  var picker = document.createElement('div');
  picker.id = 'msgEmojiPicker';
  picker.innerHTML =
    '<input id="mepSearch" type="text" placeholder="🔍 Search..." autocomplete="off">' +
    '<div id="mepGrid">' +
      _allReactEmoji.map(function(em, i) {
        return '<span class="mep-em" data-idx="' + i + '">' + em + '</span>';
      }).join('') +
    '</div>';
  document.body.appendChild(picker);
  _msgEmojiPicker = picker;

  // Search
  var inp  = picker.querySelector('#mepSearch');
  var grid = picker.querySelector('#mepGrid');
  inp.addEventListener('input', function() {
    var q = this.value.trim();
    grid.querySelectorAll('.mep-em').forEach(function(el) {
      var em = _allReactEmoji[parseInt(el.dataset.idx, 10)];
      el.style.display = (!q || em.includes(q)) ? '' : 'none';
    });
  });
  inp.addEventListener('keydown', function(e) { e.stopPropagation(); });

  // Emoji click — use index to get the original emoji from the array (avoids HTML encoding issues)
  grid.querySelectorAll('.mep-em').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      var emoji = _allReactEmoji[parseInt(el.dataset.idx, 10)];
      closeMsgEmojiPicker();
      hideMsgActionsBar();
      if (emoji && msgId) reactTo(msgId, emoji);
    });
  });

  // Position: above the action bar aligned to anchor button
  picker.style.visibility = 'hidden';
  var pw = picker.offsetWidth  || 280;
  var ph = picker.offsetHeight || 260;
  picker.style.visibility = '';

  var vw  = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
  var vh  = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  var bar = _msgActionsBar;
  var barRect = bar ? bar.getBoundingClientRect() : null;
  var btnRect = anchorBtn ? anchorBtn.getBoundingClientRect() : null;
  var mg  = 8;

  var x = btnRect ? btnRect.left : (barRect ? barRect.left : mg);
  var y = barRect ? (barRect.top - ph - mg) : (btnRect ? (btnRect.top - ph - mg) : mg);

  if (y < mg) y = (barRect ? barRect.bottom : (btnRect ? btnRect.bottom : 0)) + mg;
  if (x + pw > vw - mg) x = vw - pw - mg;
  if (x < mg) x = mg;

  picker.style.left = x + 'px';
  picker.style.top  = y + 'px';

  setTimeout(function() { inp.focus(); }, 40);

  // Close on outside click/tap
  setTimeout(function() {
    function outside(e) {
      if (e.target === anchorBtn) return; // let the toggle handle it
      if (_msgEmojiPicker && !_msgEmojiPicker.contains(e.target)) {
        closeMsgEmojiPicker();
        document.removeEventListener('mousedown', outside);
        document.removeEventListener('touchstart', outside);
      }
    }
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside, { passive: true });
  }, 0);
}

function closeMsgEmojiPicker() {
  if (_msgEmojiPicker) { _msgEmojiPicker.remove(); _msgEmojiPicker = null; }
}

// ── TRANSLATE MESSAGE ─────────────────────────────────────────────────────────
// ── TRANSLATE MESSAGE ─────────────────────────────────────────────────────────
// Supports all world languages including all Philippine regional languages:
// Tagalog, Cebuano, Ilocano, Hiligaynon, Waray, Kapampangan, Pangasinan,
// Bikol, Maranao, Tausug, Chavacano, and more.

// Philippine language codes known to Google Translate
var _phLangs = ['tl','ceb','ilo','hil','war','pam','pag','bcl','mdh','tsg'];

// PH language retry order — tried one by one when auto-detect fails
var _phRetryOrder = ['tl','ceb','bcl','ilo','hil','war','pam','pag'];

// Common words from ALL major Philippine languages for heuristic detection
var _phHints = [
  // ── High-confidence Tagalog code-switching markers ──
  // These appear even in heavily English-mixed messages
  'yung','yun','yon','yan','yung','nga','naman','kasi','daw','raw','pala',
  'yata','lang','din','rin','na','pa','ba','eh','kaya','talaga','sobra',
  'grabe','nako','OMG','hay','oo','hindi','hinde','wala','meron','may',
  'sige','ok','okay','tara','halika','dito','doon','ngayon','kanina',
  'bukas','kahapon','ngane','ngani','gane','gani','tsaka','tapos',
  'pero','kung','kapag','habang','dahil','para','pwede','pwed','pede',
  'dapat','gusto','ayaw','alam','hindi','huwag','bawal','libre',
  'lodi','beh','bro','pre','mare','mare','idol','bes','bestie',
  // ── Tagalog/Filipino ──
  'po','opo','siya','niya','sino','bakit','paano','kanino','kahit',
  'siguro','natin','namin','ninyo','basta','iyan','iyon','ako','ikaw',
  'tayo','kami','kayo','sila','ang','ng','sa','at','mahal','salamat',
  'ano','sino','saan','kailan','paano','magkano','ilan','alin',
  // ── Bikol (Central Bikol / Naga) ──
  'padaba','taka','ini','iyan','idto','dini','duman','digdi','diyan',
  'dai','bako','hoo','tabi','marhay','maogma','makulog','namit','garo',
  'ta','asin','pero','kaya','kun','harong','tawo','gadan','buhay',
  'ngapit','ngonian','kasubanggi','boot','saimo','sakuya','ninda','nita',
  // ── Cebuano / Bisaya ──
  'nako','nimo','nato','kini','kana','adto','dili','mao','bitaw',
  'gyud','man','lagi','pud','sad','kaayo','unsay','asa','ngano',
  'kinsa','unsa','gikan','hangtod','ug','og','ni','kang',
  // ── Ilocano ──
  'ania','naay','daytoy','dayta','sika','isuna','ditoy','idiay',
  'ket','ngem','wenno','ti','dagiti','kenkuana','kastoy','kasano',
  // ── Hiligaynon / Ilonggo ──
  'indi','bala','guid','gid','kag','sang','kon','ukon',
  'naton','namon','nila','aga','hapon',
  // ── Waray ──
  'hini','hira','dire','didto','ngan','waray','amo','hiya',
  'aton','amon','inyo','ira',
  // ── Kapampangan ──
  'eku','itamu','ikami','niti','neta','king','kareng','keng','ban','nung',
  // ── Pangasinan ──
  'siak','sikato','sikatayo','sikami','sikayo','sikara','nayan','natan',
  'diad','diman','tan','balet',
];

function _isProbablyPhilippine(text) {
  var lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  var words = lower.split(/\s+/).filter(function(w) { return w.length > 1; });
  if (!words.length) return false;
  // Even ONE known PH word is enough — code-switched messages always have at least one
  for (var i = 0; i < words.length; i++) {
    if (_phHints.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

function _googleTranslate(sl, q, onSuccess, onFail) {
  // dt=t  → translation
  // dt=bd → bilingual dictionary (word meanings per part-of-speech)
  // dt=rm → romanization / transliteration
  var enc = encodeURIComponent(q);
  var url = 'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx&sl=' + sl + '&tl=en&dt=t&dt=bd&dt=rm&q=' + enc;
  fetch(url)
    .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(data) {
      if (!data || !data[0]) throw new Error('empty');
      // data[0]  → translation chunks [ [translated, original], ... ]
      // data[1]  → bilingual dict     [ [pos, [meanings]], ... ]  (may be null)
      // data[2]  → detected lang
      var out = data[0].reduce(function(acc, chunk) { return acc + (chunk[0] || ''); }, '').trim();
      if (!out) throw new Error('empty');
      var detected = (sl === 'auto' && data[2]) ? data[2] : sl;
      var dict     = (data[1] && Array.isArray(data[1])) ? data[1] : null;
      onSuccess(out, detected, dict);
    })
    .catch(onFail);
}

// Try each Philippine language code in sequence until we get a real translation
function _tryPhRetry(q, idx, onSuccess, onFail) {
  if (idx >= _phRetryOrder.length) { onFail(); return; }
  var lang = _phRetryOrder[idx];
  _googleTranslate(lang, q, function(out, detected, dict) {
    // Accept if translation is meaningfully different from the input
    if (out.trim().toLowerCase() !== q.trim().toLowerCase()) {
      onSuccess(out, lang, dict);
    } else {
      // This language gave same result — try next
      _tryPhRetry(q, idx + 1, onSuccess, onFail);
    }
  }, function() {
    _tryPhRetry(q, idx + 1, onSuccess, onFail);
  });
}

function translateMessage(msg) {
  if (!msg || !msg.text) return;

  var msgId = msg.id;
  var text  = msg.text.trim();
  if (!text) return;

  // Toggle — clicking 🌐 again dismisses the translation
  var existing = document.getElementById('tr-' + msgId);
  if (existing) { existing.remove(); return; }

  // Find the bubble to insert translation below it
  var group  = msgId ? document.querySelector('[data-msg-id="' + msgId + '"]') : null;
  var bubble = group ? group.querySelector('.msg-bubble') : null;
  if (!bubble) return;

  // Insert loading placeholder
  var trEl = document.createElement('div');
  trEl.id        = 'tr-' + msgId;
  trEl.className = 'msg-translation';
  trEl.innerHTML =
    '<span class="tr-label">🌐 EN</span>' +
    '<span class="tr-text tr-loading">Translating…</span>' +
    '<span class="tr-close" title="Dismiss">✕</span>';
  bubble.parentNode.insertBefore(trEl, bubble.nextSibling);

  trEl.querySelector('.tr-close').addEventListener('click', function(e) {
    e.stopPropagation(); trEl.remove();
  });

  // Language display names for Philippine languages
  var _langNames = {
    tl:'Filipino', ceb:'Cebuano', ilo:'Ilocano', hil:'Hiligaynon',
    war:'Waray', pam:'Kapampangan', pag:'Pangasinan', bcl:'Bikol',
    mdh:'Maguindanao', tsg:'Tausug',
    zh:'Chinese', ja:'Japanese', ko:'Korean', ar:'Arabic',
    es:'Spanish', fr:'French', de:'German', pt:'Portuguese',
    ru:'Russian', hi:'Hindi', id:'Indonesian', ms:'Malay',
    th:'Thai', vi:'Vietnamese',
  };

  function langLabel(code) {
    return _langNames[code] || code.toUpperCase();
  }

  function showResult(translated, detectedLang, dict) {
    var textEl = trEl.querySelector('.tr-text');
    if (!textEl) return;
    textEl.classList.remove('tr-loading');
    var clean = (translated || '').trim();

    if (!clean || clean.toLowerCase() === text.toLowerCase()) {
      textEl.textContent = '(already in English)';
      return;
    }

    // Update label with detected language name
    if (detectedLang && detectedLang !== 'en') {
      var label = trEl.querySelector('.tr-label');
      if (label) label.textContent = '🌐 ' + langLabel(detectedLang) + ' → EN';
    }

    // Build output: main translation first
    var html = '<span class="tr-main">' + escapeHtml(clean) + '</span>';

    // If the API returned a bilingual dictionary (word is short / single-word),
    // render each part-of-speech group with its list of meanings
    // dict format: [ ["noun", ["meaning1","meaning2",...], null, ["synonym",...]], ... ]
    if (dict && dict.length > 0) {
      html += '<ul class="tr-meanings">';
      dict.forEach(function(entry) {
        var pos      = entry[0] || '';          // e.g. "noun", "verb", "adjective"
        var meanings = entry[1] || [];          // array of English meaning strings
        if (!meanings.length) return;
        // Show up to 4 meanings per POS to keep it concise
        var limited = meanings.slice(0, 4);
        html += '<li class="tr-pos"><em>' + escapeHtml(pos) + ':</em> ' +
                limited.map(function(m) { return '<span class="tr-meaning">' + escapeHtml(m) + '</span>'; }).join(', ') +
                '</li>';
      });
      html += '</ul>';
    }

    textEl.innerHTML = html;
  }

  function showError() {
    var textEl = trEl.querySelector('.tr-text');
    if (textEl) { textEl.classList.remove('tr-loading'); textEl.textContent = 'Translation unavailable. Check connection.'; }
  }

  var q = text.slice(0, 1000);

  // Detect clearly non-Latin scripts (CJK, Arabic, Cyrillic, Devanagari, etc.)
  // These are definitely NOT Filipino so we skip the PH-first path
  function _isNonLatinScript(t) {
    return /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F]/.test(t);
  }

  // ── MAIN TRANSLATION LOGIC ──────────────────────────────────────────────────
  // Priority: Filipino/PH languages FIRST, then fall back to global auto-detect.
  // Exception: non-Latin scripts are sent directly to auto-detect (they're clearly
  // not Filipino).

  if (_isNonLatinScript(q)) {
    // Non-Latin script (Chinese, Arabic, Russian, etc.) — go straight to auto-detect
    _googleTranslate('auto', q, function(out, detected, dict) {
      showResult(out, detected, dict);
    }, function() {
      fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.slice(0,500)) + '&langpair=autodetect|en-US')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var t = data && data.responseData && data.responseData.translatedText;
          showResult(t || q, '', null);
        })
        .catch(showError);
    });
    return;
  }

  // For ALL Latin-script text: try Tagalog first (handles Filipino + Taglish perfectly)
  // If Tagalog gives a meaningful translation → done.
  // If not → try the full PH retry chain.
  // If still nothing → fall back to Google auto-detect (catches Spanish, Indonesian, etc.)
  _googleTranslate('tl', q, function(out, detected, dict) {
    var sameAsInput = out.trim().toLowerCase() === q.trim().toLowerCase();

    if (!sameAsInput) {
      // Tagalog gave a real translation — use it
      showResult(out, 'tl', dict);
    } else {
      // Tagalog returned same text — try other PH languages
      _tryPhRetry(q, 1, showResult, function() {
        // No PH language worked — fall back to Google auto-detect
        // (covers genuine English, Spanish, Indonesian, Malay, etc.)
        _googleTranslate('auto', q, function(out2, detected2, dict2) {
          showResult(out2, detected2, dict2);
        }, function() {
          // Engine 2: MyMemory
          fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.slice(0,500)) + '&langpair=autodetect|en-US')
            .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function(data) {
              var t = data && data.responseData && data.responseData.translatedText;
              if (!t || t === 'NO QUERY SPECIFIED') throw new Error('empty');
              showResult(t, '', null);
            })
            .catch(function() {
              // Engine 3: Lingva
              fetch('https://lingva.ml/api/v1/auto/en/' + encodeURIComponent(q))
                .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
                .then(function(data) { showResult(data && data.translation || '', (data && data.info && data.info.detectedSource) || '', null); })
                .catch(showError);
            });
        });
      });
    }
  }, function() {
    // Tagalog fetch failed — go straight to auto-detect
    _googleTranslate('auto', q, function(out, detected, dict) {
      showResult(out, detected, dict);
    }, showError);
  });
}

function showMsgActionsBar(clientX, clientY, msg, isMine) {
  var bar = _getMsgActionsBar();

  // Rebuild buttons for this specific message
  var svgR = _msgActionsBarSvg;
  bar.innerHTML =
    (msg.id ? '<span class="ma-btn ma-act-reply" title="Reply">'                   + svgR.reply + '</span>' : '') +
    '<span class="ma-btn ma-btn-like  ma-act-like"  title="Like">'                 + svgR.like  + '</span>' +
    '<span class="ma-btn ma-btn-heart ma-act-heart" title="Love">'                 + svgR.heart + '</span>' +
    '<span class="ma-btn ma-btn-laugh ma-act-laugh" title="Haha">'                 + svgR.laugh + '</span>' +
    (msg.id ? '<span class="ma-btn ma-act-more-emoji" title="More reactions" style="font-size:15px;font-weight:700;">＋</span>' : '') +
    (msg.text ? '<span class="ma-btn ma-act-translate" title="Translate to English" style="font-size:14px;">🌐</span>' : '') +
    (msg.text ? '<span class="ma-btn ma-act-copy" title="Copy selected text (or full message)">' + svgR.copy + '</span>' : '') +
    (isMine && msg.id ? '<span class="ma-btn ma-act-edit" title="Edit">'           + svgR.edit  + '</span>' : '') +
    (msg.id
      ? '<span class="ma-btn ma-btn-danger del-wrap ma-act-delete" title="Delete">' +
          svgR.del +
          '<div class="del-menu" id="globalDelMenu">' +
            (isMine ? '<div class="del-everyone"><span style="font-size:11px">🗑️</span> Delete for Everyone</div>' : '') +
            '<div class="del-for-me"><span style="font-size:11px">🙈</span> Delete for Me</div>' +
          '</div>' +
        '</span>'
      : '');

  // Wire buttons
  var replyBtn    = bar.querySelector('.ma-act-reply');
  var likeBtn     = bar.querySelector('.ma-act-like');
  var heartBtn    = bar.querySelector('.ma-act-heart');
  var laughBtn    = bar.querySelector('.ma-act-laugh');
  var moreEmojiBtn= bar.querySelector('.ma-act-more-emoji');
  var translateBtn= bar.querySelector('.ma-act-translate');
  var copyBtn     = bar.querySelector('.ma-act-copy');
  var editBtn     = bar.querySelector('.ma-act-edit');
  var deleteBtn   = bar.querySelector('.ma-act-delete');
  var delMenu     = bar.querySelector('.del-menu');
  var delEveryone = delMenu && delMenu.querySelector('.del-everyone');
  var delForMe    = delMenu && delMenu.querySelector('.del-for-me');

  if (replyBtn)  replyBtn.addEventListener('click',  function(e) { e.stopPropagation(); hideMsgActionsBar(); quoteMessage(msg.id); });
  if (likeBtn)   likeBtn.addEventListener('click',   function(e) { e.stopPropagation(); hideMsgActionsBar(); reactTo(msg.id, '👍'); });
  if (heartBtn)  heartBtn.addEventListener('click',  function(e) { e.stopPropagation(); hideMsgActionsBar(); reactTo(msg.id, '❤️'); });
  if (laughBtn)  laughBtn.addEventListener('click',  function(e) { e.stopPropagation(); hideMsgActionsBar(); reactTo(msg.id, '😂'); });
  if (moreEmojiBtn) moreEmojiBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    toggleMsgEmojiPicker(moreEmojiBtn, msg.id);
  });
  if (translateBtn) translateBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    hideMsgActionsBar();
    translateMessage(msg);
  });
  if (copyBtn) copyBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    hideMsgActionsBar();

    // Use the active text selection if it exists and is non-empty,
    // otherwise fall back to the full message text
    var sel = window.getSelection && window.getSelection();
    var textToCopy = (sel && sel.toString().trim())
      ? sel.toString()
      : (msg.text || '');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(function() {
        _showCopyToast();
      }).catch(function() { _copyFallback(textToCopy); });
    } else {
      _copyFallback(textToCopy);
    }
  });
  if (editBtn)   editBtn.addEventListener('click',   function(e) { e.stopPropagation(); hideMsgActionsBar(); startEdit(msg.id); });
  if (deleteBtn) deleteBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (!delMenu) return;
    var isOpen = delMenu.classList.contains('show');
    document.querySelectorAll('.del-menu.show').forEach(function(m) { m.classList.remove('show'); });
    if (!isOpen) delMenu.classList.add('show');
  });
  if (delEveryone) delEveryone.addEventListener('click', function(e) {
    e.stopPropagation();
    hideMsgActionsBar(); deleteMsg(msg.id);
  });
  if (delForMe) delForMe.addEventListener('click', function(e) {
    e.stopPropagation();
    hideMsgActionsBar(); deleteForMe(msg.id);
  });

  // Show bar so we can measure its dimensions
  bar.classList.add('actions-open');

  // Position near cursor/touch point, keeping within the visual viewport
  var vw = (window.visualViewport ? window.visualViewport.width  : window.innerWidth);
  var vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  var vx = (window.visualViewport ? window.visualViewport.offsetLeft : 0);
  var vy = (window.visualViewport ? window.visualViewport.offsetTop  : 0);

  var barW   = bar.offsetWidth  || 240;
  var barH   = bar.offsetHeight || 44;
  var margin = 10;
  var x = clientX + margin;
  var y = clientY + margin;
  // Flip left if overflowing right edge
  if (x + barW > vx + vw - margin) x = clientX - barW - margin;
  // Flip up if overflowing bottom edge
  if (y + barH > vy + vh - margin) y = clientY - barH - margin;
  bar.style.left = Math.max(vx + margin, x) + 'px';
  bar.style.top  = Math.max(vy + margin, y) + 'px';
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
  if (_pendingFiles.length > 0) {
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

  // ── Optimistic render — show message instantly, don't wait for Firestore ──
  var tempId  = 'temp-' + Date.now();
  var tempMsg = Object.assign({}, msg, {
    id:        tempId,
    timestamp: { toDate: function() { return new Date(); } },
  });

  var area = document.getElementById('messagesArea');
  var wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;

  // Append date divider if needed
  var label    = msgDateLabel(tempMsg);
  var dividers = area.querySelectorAll('.date-divider');
  var lastDiv  = dividers.length ? dividers[dividers.length - 1] : null;
  if (!lastDiv || lastDiv.textContent !== label) {
    area.appendChild(makeDateDivider(label));
  }

  appendMessageEl(area, tempMsg, {});
  if (wasAtBottom) area.scrollTop = area.scrollHeight;

  // Mark the temp element so we can remove it when the real one arrives
  var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
  if (tempEl) tempEl.dataset.tempMsg = '1';

  // ── Fire Firestore write in background — no await ─────────────────────────
  db.collection('channels').doc(state.currentChannel).collection('messages').add(
    Object.assign({}, msg, { timestamp: firebase.firestore.FieldValue.serverTimestamp() })
  ).catch(function(err) {
    // Write failed — remove the optimistic element and restore the input
    if (tempEl && tempEl.parentNode) tempEl.remove();
    var inp = document.getElementById('msgInput');
    if (inp && !inp.value) inp.value = text;
    autoResize(inp);
    console.error('Send failed:', err);
  });
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

// PASTE IMAGE — intercept Ctrl+V / long-press paste in the textarea
document.addEventListener('DOMContentLoaded', function() {
  var msgInput = document.getElementById('msgInput');
  if (!msgInput) return;
  msgInput.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var imageFiles = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        var file = items[i].getAsFile();
        if (!file) continue;
        var ext  = file.type.split('/')[1] || 'png';
        var name = 'pasted-image-' + Date.now() + '-' + i + '.' + ext;
        imageFiles.push(new File([file], name, { type: file.type }));
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFilesToPending(imageFiles);
    }
  });
});

// REACTIONS — per-user toggle (tap again to remove)
// Reads current reaction state from the local DOM (already rendered) to avoid
// a blocking Firestore GET before the write.
async function reactTo(msgId, emoji) {
  if (!isOnline()) return;

  const me  = state.currentUser.name;
  const ref = db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId);

  // ── Optimistic update from local DOM ─────────────────────────────────────
  // Read current reactions from the rendered message instead of fetching from Firestore
  var group = document.querySelector('[data-msg-id="' + msgId + '"]');
  var currentReactions = [];

  if (group) {
    group.querySelectorAll('.reaction-chip').forEach(function(chip) {
      // chip text: "😂 3"
      var parts  = chip.textContent.trim().split(' ');
      var emj    = parts[0];
      var count  = parseInt(parts[1], 10) || 0;
      var reacted = chip.classList.contains('reacted');
      // Reconstruct a users array approximation
      currentReactions.push({ emoji: emj, count: count, _reacted: reacted });
    });
  }

  // ── Compute new reactions array optimistically ────────────────────────────
  // Then do a single Firestore write — no GET needed
  // Use a transaction to guarantee correctness on the server side
  try {
    await db.runTransaction(async function(tx) {
      var snap = await tx.get(ref);
      if (!snap.exists) return;

      var reactions = snap.data().reactions || [];
      var existing  = reactions.find(function(r) { return r.emoji === emoji; });

      if (existing) {
        if (!existing.users) existing.users = [];
        if (existing.users.includes(me)) {
          existing.users = existing.users.filter(function(u) { return u !== me; });
        } else {
          existing.users.push(me);
        }
        existing.count = existing.users.length;
        const updated = reactions.filter(function(r) { return r.count > 0; });
        tx.update(ref, { reactions: updated });
      } else {
        reactions.push({ emoji: emoji, count: 1, users: [me] });
        tx.update(ref, { reactions: reactions });
      }
    });
  } catch (err) {
    console.error('Reaction failed:', err);
  }
}

function addReaction(msgId, emoji) { reactTo(msgId, emoji); }

// ── DELETE FOR ME — hides the message only from the current user's view ──────
function deleteForMe(msgId) {
  var group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.opacity = '0.3';

  showUndoToast(msgId + '_me', function() {
    if (group) group.style.opacity = '';
    clearTimeout(_deleteTimers['me_' + msgId]);
    delete _deleteTimers['me_' + msgId];
  });

  _deleteTimers['me_' + msgId] = setTimeout(async function() {
    delete _deleteTimers['me_' + msgId];
    if (group) group.remove();
    try {
      await db.collection('channels').doc(state.currentChannel)
        .collection('messages').doc(msgId)
        .update({
          deletedFor: firebase.firestore.FieldValue.arrayUnion(state.currentUser.name)
        });
    } catch(e) {
      if (group) group.style.opacity = '';
    }
  }, 5000);
}

// ── DELETE DROPDOWN — toggle mini-menu on own messages ───────────────────────
function toggleDeleteMenu(msgId, e) {
  e.stopPropagation();
  var menu = document.getElementById('delmenu-' + msgId);
  if (!menu) return;
  var isOpen = menu.classList.contains('show');
  document.querySelectorAll('.del-menu.show').forEach(function(m) { m.classList.remove('show'); });
  if (!isOpen) menu.classList.add('show');
}

function closeDeleteMenu() {
  document.querySelectorAll('.del-menu.show').forEach(function(m) { m.classList.remove('show'); });
}

document.addEventListener('mousedown', function(e) {
  if (!e.target.closest('.del-wrap')) closeDeleteMenu();
});

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

// FILE ATTACH — multiple files, preview before send
var _pendingFiles = []; // array of File objects

function cancelFileAttach() {
  _pendingFiles = [];
  document.getElementById('filePreviewBar').style.display = 'none';
  document.getElementById('filePreviewInner').innerHTML = '';
  document.getElementById('fileInput').value = '';
}

function removePendingFile(index) {
  _pendingFiles.splice(index, 1);
  if (_pendingFiles.length === 0) {
    cancelFileAttach();
  } else {
    renderFilePreview();
  }
}

function renderFilePreview() {
  var bar   = document.getElementById('filePreviewBar');
  var inner = document.getElementById('filePreviewInner');
  if (!bar || !inner) return;

  if (_pendingFiles.length === 0) {
    bar.style.display = 'none';
    inner.innerHTML = '';
    return;
  }

  bar.style.display = 'flex';
  inner.innerHTML = '';

  _pendingFiles.forEach(function(file, index) {
    var item = document.createElement('div');
    item.className = 'fp-item';

    var removeBtn = '<span class="fp-remove" onclick="removePendingFile(' + index + ')" title="Remove">✕</span>';

    if (file.type.startsWith('image/')) {
      var reader = new FileReader();
      reader.onload = function(e) {
        item.innerHTML =
          '<img src="' + e.target.result + '" class="fp-img" alt="' + escapeHtml(file.name) + '">' +
          '<span class="fp-name">' + escapeHtml(file.name) + '</span>' +
          removeBtn;
      };
      reader.readAsDataURL(file);
    } else {
      item.innerHTML =
        '<span class="fp-icon">📎</span>' +
        '<span class="fp-name">' + escapeHtml(file.name) + '</span>' +
        '<span class="fp-size">(' + formatFileSize(file.size) + ')</span>' +
        removeBtn;
    }

    inner.appendChild(item);
  });
}

async function attachFile(input) {
  if (!input.files.length) return;
  var rejected = [];
  Array.from(input.files).forEach(function(f) {
    if (f.size > 10 * 1024 * 1024) {
      rejected.push(f.name);
    } else {
      _pendingFiles.push(f);
    }
  });
  input.value = ''; // reset so same file can be re-selected
  if (rejected.length > 0) {
    alert('File' + (rejected.length > 1 ? 's' : '') + ' too large (max 10 MB):\n' + rejected.join('\n'));
  }
  renderFilePreview();
}

function addFilesToPending(files) {
  var rejected = [];
  Array.from(files).forEach(function(f) {
    if (f.size > 10 * 1024 * 1024) {
      rejected.push(f.name);
    } else {
      _pendingFiles.push(f);
    }
  });
  if (rejected.length > 0) {
    alert('File' + (rejected.length > 1 ? 's' : '') + ' too large (max 10 MB):\n' + rejected.join('\n'));
  }
  renderFilePreview();
}

function formatFileSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function uploadPendingFile(caption) {
  if (!_pendingFiles.length) return;
  var files = _pendingFiles.slice(); // copy
  caption = caption || '';
  cancelFileAttach();

  var area = document.getElementById('messagesArea');

  // Upload each file as a separate message; caption only on the first
  for (var i = 0; i < files.length; i++) {
    var file    = files[i];
    var msgCaption = (i === 0) ? caption : '';
    var isImage = file.type.startsWith('image/');
    var tempId  = 'temp-' + Date.now() + '-' + i;

    // Show temp message immediately
    await (function(f, tc, ti, img) {
      return new Promise(function(resolve) {
        if (img) {
          var reader = new FileReader();
          reader.onload = function(e) {
            var tempMsg = {
              id: ti, sender: state.currentUser.name, color: state.currentUser.color,
              text: tc, file: f.name, fileUrl: e.target.result, fileType: f.type,
              time: formatTime(new Date()),
              timestamp: { toDate: function() { return new Date(); } },
              reactions: [],
            };
            appendMessageEl(area, tempMsg);
            area.scrollTop = area.scrollHeight;
            resolve();
          };
          reader.readAsDataURL(f);
        } else {
          var tempMsg = {
            id: ti, sender: state.currentUser.name, color: state.currentUser.color,
            text: tc, file: f.name, fileUrl: null, fileType: f.type,
            time: formatTime(new Date()),
            timestamp: { toDate: function() { return new Date(); } },
            reactions: [],
          };
          appendMessageEl(area, tempMsg);
          area.scrollTop = area.scrollHeight;
          resolve();
        }
      });
    })(file, msgCaption, tempId, isImage);

    // Fade temp while uploading
    var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
    if (tempEl) tempEl.style.opacity = '0.5';

    try {
      var path  = 'uploads/' + state.currentChannel + '/' + Date.now() + '_' + file.name;
      var ref   = storage.ref(path);
      await ref.put(file);
      var url   = await ref.getDownloadURL();

      // Remove temp
      var tel = document.querySelector('[data-msg-id="' + tempId + '"]');
      if (tel) tel.remove();

      var firestoreMsg = {
        sender: state.currentUser.name, color: state.currentUser.color,
        text: msgCaption, file: file.name, fileUrl: url, fileType: file.type,
        time: formatTime(new Date()),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        reactions: [],
      };

      // Attach quote only to first file
      if (i === 0 && state.quoteMsg) {
        firestoreMsg.quoteId     = state.quoteMsg.id || '';
        firestoreMsg.quoteSender = state.quoteMsg.sender || '';
        firestoreMsg.quoteText   = (state.quoteMsg.text || '').slice(0, 200);
        cancelQuote();
      }

      await db.collection('channels').doc(state.currentChannel).collection('messages').add(firestoreMsg);

    } catch (err) {
      var tel2 = document.querySelector('[data-msg-id="' + tempId + '"]');
      if (tel2) tel2.remove();
      console.error('Upload error:', err);
      if (err.code === 'storage/unauthorized') {
        alert('Upload failed: Storage permission denied.\n\nGo to Firebase Console → Storage → Rules and set:\nallow read, write: if true;');
      } else {
        alert('Upload failed: ' + (err.message || err.code || err));
      }
    }
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
//  SECTION HEADER MENUS (CHANNELS / DIRECT MESSAGES ···)
// ============================================================
function toggleSectionMenu(menuId, e) {
  e.stopPropagation();
  var menu = document.getElementById(menuId);
  if (!menu) return;
  var isOpen = menu.classList.contains('show');
  document.querySelectorAll('.section-menu.show').forEach(function(m) { m.classList.remove('show'); });
  if (!isOpen) menu.classList.add('show');
}

function closeSectionMenu(menuId) {
  var menu = document.getElementById(menuId);
  if (menu) menu.classList.remove('show');
}

document.addEventListener('mousedown', function(e) {
  if (!e.target.closest('.section-row')) {
    document.querySelectorAll('.section-menu.show').forEach(function(m) { m.classList.remove('show'); });
  }
});

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
  const isSelf = user.name === state.currentUser.name;
  const removeLabel = document.getElementById('memberCtxRemove');
  if (removeLabel) {
    removeLabel.innerHTML = isSelf
      ? '🗑️ Delete My Account &amp; Clear History'
      : '🗑️ Remove User &amp; Clear History';
  }
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
  const oldName = state.currentUser.name;
  const msgEl   = document.getElementById('settingsSaveMsg');

  if (!newName) return;

  const nameChanged = newName !== oldName;

  // Check for duplicate username using the already-loaded users cache (no network round-trip)
  if (nameChanged) {
    var duplicate = _lastKnownUsers.find(function(u) {
      return u.name.toLowerCase() === newName.toLowerCase() && u.id !== state.currentUser.id;
    });
    if (duplicate) {
      msgEl.style.color = '#e74c3c';
      msgEl.textContent = 'Username "' + newName + '" is already taken.';
      return;
    }
  }

  // Update local state immediately
  state.currentUser.name   = newName;
  state.currentUser.status = status;
  updateStatusDisplay(status);
  document.getElementById('myName').textContent          = state.currentUser.name;
  document.getElementById('myAvatarInitial').textContent = state.currentUser.name[0].toUpperCase();
  sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));

  // Update users doc
  if (state.currentUser.id) {
    await db.collection('users').doc(state.currentUser.id).update({
      status:    status,
      name:      newName,
      nameLower: newName.toLowerCase(),
    }).catch(function() {});
  }

  // ── Retroactive rename across all messages ──────────────────
  if (nameChanged) {
    msgEl.style.color = '#9ea2c8';
    msgEl.textContent = 'Updating messages…';

    try {
      // Collect all channel IDs: group channels + DM channels involving this user
      var allChannelIds = channels.map(function(c) { return c.id; });

      // Add DM channels involving the current user
      var usersSnap = await db.collection('users').get();
      usersSnap.docs.forEach(function(d) {
        var uName = d.data().name;
        if (uName && uName !== newName) {
          allChannelIds.push(dmChannelId(oldName, uName));
        }
      });

      var totalUpdated = 0;

      for (var i = 0; i < allChannelIds.length; i++) {
        var chId = allChannelIds[i];

        // --- Update sender field on messages ---
        var msgsSnap = await db.collection('channels').doc(chId)
          .collection('messages')
          .where('sender', '==', oldName)
          .get()
          .catch(function() { return { empty: true, docs: [] }; });

        if (!msgsSnap.empty) {
          // Firestore batch limit is 500 writes
          var docs = msgsSnap.docs;
          for (var j = 0; j < docs.length; j += 400) {
            var batch = db.batch();
            docs.slice(j, j + 400).forEach(function(d) {
              batch.update(d.ref, { sender: newName });
            });
            await batch.commit();
            totalUpdated += Math.min(400, docs.length - j);
          }
        }

        // --- Update seenBy keys: {oldName: ts} → {newName: ts} ---
        // seenBy is a map field; we must fetch docs that have seenBy[oldName]
        // Firestore can't query map keys directly, so we scan all messages in
        // channels the user participated in (already fetched above covers most;
        // do a full scan for seenBy keys in all channels)
        var allMsgsSnap = await db.collection('channels').doc(chId)
          .collection('messages')
          .get()
          .catch(function() { return { empty: true, docs: [] }; });

        if (!allMsgsSnap.empty) {
          var seenDocs = allMsgsSnap.docs.filter(function(d) {
            var data = d.data();
            return data.seenBy && data.seenBy[oldName] !== undefined;
          });

          for (var k = 0; k < seenDocs.length; k += 400) {
            var seenBatch = db.batch();
            seenDocs.slice(k, k + 400).forEach(function(d) {
              var data   = d.data();
              var oldTs  = data.seenBy[oldName];
              var update = {};
              update['seenBy.' + newName]  = oldTs;
              update['seenBy.' + oldName]  = firebase.firestore.FieldValue.delete();
              seenBatch.update(d.ref, update);
            });
            await seenBatch.commit();
          }
        }
      }

      msgEl.style.color = '#0e7c63';
      msgEl.textContent = 'Saved ✓  (' + totalUpdated + ' messages updated)';
    } catch (err) {
      console.error('Retroactive rename error:', err);
      msgEl.style.color = '#e67e22';
      msgEl.textContent = 'Saved, but some messages could not be updated.';
    }
  } else {
    msgEl.style.color = '#0e7c63';
    msgEl.textContent = 'Saved ✓';
  }

  setTimeout(function() {
    msgEl.style.color = '';
    msgEl.textContent = '';
    closeSettings();
  }, 2000);
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
  _notifListenerActive = false;
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

// ══════════════════════════════════════════════════════════════
//  RINGTONE  —  Web Audio API (no audio files needed)
// ══════════════════════════════════════════════════════════════
var _ring = {
  ctx:        null,   // AudioContext
  gainNode:   null,
  oscillators: [],
  timer:      null,
  playing:    false,
};

function _ringGetCtx() {
  if (!_ring.ctx) {
    _ring.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (_ring.ctx.state === 'suspended') _ring.ctx.resume();
  return _ring.ctx;
}

function _ringStop() {
  if (_ring.timer)  { clearTimeout(_ring.timer); _ring.timer = null; }
  _ring.oscillators.forEach(function(o) { try { o.stop(); o.disconnect(); } catch(e){} });
  _ring.oscillators = [];
  if (_ring.gainNode) { try { _ring.gainNode.disconnect(); } catch(e){} _ring.gainNode = null; }
  _ring.playing = false;
}

// Play a short tone burst: freqs[] = chord, duration ms, volume 0-1
function _ringBurst(freqs, duration, volume) {
  var ctx  = _ringGetCtx();
  var gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
  gain.gain.setValueAtTime(volume, ctx.currentTime + duration / 1000 - 0.05);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration / 1000);
  gain.connect(ctx.destination);
  _ring.gainNode = gain;

  freqs.forEach(function(freq) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration / 1000);
    _ring.oscillators.push(osc);
  });
}

// ── Outgoing ring (caller) — plays only after callee receives the call ──
function _ringStartOutgoing() {
  _ringStop();
  _ring.playing = true;

  function doBeep() {
    if (!_ring.playing) return;
    _ringStop();
    _ring.playing = true;
    _ringBurst([440, 480], 400, 0.18);
    _ring.timer = setTimeout(function() {
      if (!_ring.playing) return;
      _ringStop();
      _ring.playing = true;
      _ringBurst([440, 480], 400, 0.18);
      _ring.timer = setTimeout(doBeep, 2200);
    }, 600);
  }

  doBeep();
}

// ── Incoming ring (callee) — ascending two-tone ring ─────────
// Sounds like a classic phone ring
function _ringStartIncoming() {
  _ringStop();
  _ring.playing = true;

  function doRing() {
    if (!_ring.playing) return;
    _ringStop();
    _ring.playing = true;
    // Ring: 523 Hz (C5) + 659 Hz (E5) — pleasant two-tone
    _ringBurst([523, 659], 600, 0.22);
    _ring.timer = setTimeout(function() {
      if (!_ring.playing) return;
      _ringStop();
      _ring.playing = true;
      _ringBurst([523, 659], 600, 0.22);
      // Gap then repeat
      _ring.timer = setTimeout(doRing, 2000);
    }, 800);
  }

  doRing();
}


var _vc = {
  pc:            null,   // RTCPeerConnection
  localStream:   null,   // MediaStream (own camera+mic)
  callDocId:     null,   // Firestore call doc id
  role:          null,   // 'caller' | 'callee'
  micOn:         true,
  camOn:         true,
  unsubOffer:    null,
  unsubAnswer:   null,
  unsubCandCaller: null,
  unsubCandCallee: null,
  unsubIncoming: null,   // listener for incoming calls
  incomingCallId: null,
  ringtoneTimer: null,
};

// STUN servers — free Google STUN + TURN fallback via Open Relay
var _iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // open TURN relay for cross-NAT connections
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443?transport=tcp',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ── helpers ──────────────────────────────────────────────────
function _vcStatus(msg) {
  var el = document.getElementById('callStatusBar');
  if (el) el.textContent = msg;
}

function _vcShowLocalVideo(stream) {
  var vid = document.getElementById('localVideo');
  var ph  = document.getElementById('localPlaceholder');
  if (vid) { vid.srcObject = stream; vid.classList.add('active'); }
  if (ph)  ph.style.display = 'none';
}

function _vcShowRemoteVideo(stream) {
  var vid = document.getElementById('remoteVideo');
  var ph  = document.getElementById('remotePlaceholder');
  if (vid) { vid.srcObject = stream; vid.classList.add('active'); }
  if (ph)  ph.style.display = 'none';
}

function _vcHideRemoteVideo() {
  var vid = document.getElementById('remoteVideo');
  var ph  = document.getElementById('remotePlaceholder');
  if (vid) { vid.srcObject = null; vid.classList.remove('active'); }
  if (ph)  ph.style.display = '';
}

function _vcSetRemoteLabel(txt) {
  var el = document.getElementById('remoteLabel');
  if (el) el.textContent = txt;
}

// ── create RTCPeerConnection ─────────────────────────────────
function _vcCreatePC() {
  if (_vc.pc) { try { _vc.pc.close(); } catch(e){} }
  var pc = new RTCPeerConnection(_iceServers);

  // Add local tracks
  if (_vc.localStream) {
    _vc.localStream.getTracks().forEach(function(t) { pc.addTrack(t, _vc.localStream); });
  }

  // Receive remote tracks
  pc.ontrack = function(e) {
    var remoteStream = e.streams[0];
    if (remoteStream) {
      _vcShowRemoteVideo(remoteStream);
      _vcStatus('Connected ✅');
    }
  };

  // Send ICE candidates to Firestore
  pc.onicecandidate = function(e) {
    if (!e.candidate || !_vc.callDocId) return;
    var col = _vc.role === 'caller' ? 'callerCandidates' : 'calleeCandidates';
    db.collection('calls').doc(_vc.callDocId)
      .collection(col).add(e.candidate.toJSON())
      .catch(function(){});
  };

  pc.onconnectionstatechange = function() {
    var s = pc.connectionState;
    _vcStatus('Connection: ' + s);
    if (s === 'connected')     _vcStatus('Connected ✅');
    if (s === 'disconnected' || s === 'failed' || s === 'closed') {
      _vcStatus('Call ended');
      _vcHideRemoteVideo();
    }
  };

  pc.oniceconnectionstatechange = function() {
    if (pc.iceConnectionState === 'disconnected') {
      _vcStatus('Peer disconnected');
      _vcHideRemoteVideo();
    }
  };

  _vc.pc = pc;
  return pc;
}

// ── get camera + mic ─────────────────────────────────────────
async function _vcGetMedia() {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    _vc.localStream = stream;
    _vcShowLocalVideo(stream);
    return stream;
  } catch(err) {
    // Try audio only if camera denied
    try {
      var audioOnly = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      _vc.localStream = audioOnly;
      _vcStatus('Camera unavailable — audio only');
      return audioOnly;
    } catch(e) {
      _vcStatus('Could not access camera or microphone');
      return null;
    }
  }
}

// ── OPEN CALL (caller side) ──────────────────────────────────
async function openVideoCall() {
  var targetName = null;

  if (state.currentChannel && state.currentChannel.startsWith('dm-')) {
    // In a DM — extract the other user's name from the channel id
    var mySlug = state.currentUser.name.toLowerCase().replace(/[\s.]+/g, '_');
    var parts = state.currentChannel.replace('dm-', '').split('-');
    var otherSlug = parts.filter(function(p) { return p !== mySlug; }).join('-');
    var matched = _lastKnownUsers.find(function(u) {
      return u.name.toLowerCase().replace(/[\s.]+/g, '_') === otherSlug;
    });
    targetName = matched ? matched.name : otherSlug;

    // Check if the target user is online before calling
    var targetUser = _lastKnownUsers.find(function(u) { return u.name === targetName; });
    var targetStatus = targetUser ? (targetUser.status || 'offline') : 'offline';

    if (targetStatus === 'offline') {
      if (!confirm(targetName + ' is currently offline.\nCall anyway? They may not answer.')) return;
    } else if (targetStatus === 'busy') {
      if (!confirm(targetName + ' is set to Busy.\nCall anyway?')) return;
    }

    _startCall(targetName);
  } else {
    // In a channel — show a picker to choose who to call
    _showCallPickerModal();
  }
}

// Show a modal to pick who to call when not in a DM
function _showCallPickerModal() {
  var others = _lastKnownUsers.filter(function(u) {
    return u.name !== state.currentUser.name;
  });

  if (others.length === 0) {
    alert('No other users to call.');
    return;
  }

  // Sort: online first, then away/busy, then offline
  var statusOrder = { online: 0, away: 1, busy: 2, offline: 3 };
  others.sort(function(a, b) {
    var sa = statusOrder[a.status || 'offline'] || 3;
    var sb = statusOrder[b.status || 'offline'] || 3;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'callPickerModal';

  var rows = others.map(function(u) {
    var st       = u.status || 'offline';
    var isOffline = st === 'offline';
    var isBusy    = st === 'busy';
    var stColor   = statusColor(st);
    var stLabel   = st.charAt(0).toUpperCase() + st.slice(1);
    var dimStyle  = isOffline ? 'opacity:0.45;' : '';
    var titleAttr = isOffline ? ' title="' + escapeHtml(u.name) + ' is offline"'
                  : isBusy    ? ' title="' + escapeHtml(u.name) + ' is busy — call anyway?"'
                  : '';

    return '<div class="new-dm-row call-picker-row" ' +
        'onclick="_pickCallTarget(\'' + escapeHtml(u.name) + '\')" ' +
        'style="cursor:pointer;' + dimStyle + '"' + titleAttr + '>' +
      '<div class="user-avatar" style="background:' + u.color + ';width:30px;height:30px;font-size:13px;flex-shrink:0;position:relative;">' +
        u.name[0] +
        '<span style="position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:50%;background:' + stColor + ';border:1.5px solid #1a1a2e;"></span>' +
      '</div>' +
      '<span style="flex:1;font-size:13px;">' + escapeHtml(u.name) + '</span>' +
      '<span style="font-size:11px;color:' + stColor + ';font-weight:500;">' + stLabel + '</span>' +
    '</div>';
  }).join('');

  overlay.innerHTML =
    '<div class="modal-box" style="width:min(320px,calc(100vw - 24px))">' +
      '<h3>📹 Video Call</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Choose someone to call</p>' +
      '<div style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;">' +
        rows +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn cancel" onclick="document.getElementById(\'callPickerModal\').remove()">Cancel</button>' +
      '</div>' +
    '</div>';

  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function _pickCallTarget(name) {
  var user = _lastKnownUsers.find(function(u) { return u.name === name; });
  var st   = user ? (user.status || 'offline') : 'offline';

  if (st === 'offline') {
    if (!confirm(name + ' is offline.\nCall anyway? They may not answer.')) return;
  } else if (st === 'busy') {
    if (!confirm(name + ' is set to Busy.\nCall anyway?')) return;
  }

  var modal = document.getElementById('callPickerModal');
  if (modal) modal.remove();
  _startCall(name);
}

async function _startCall(targetName) {
  document.getElementById('callModal').classList.add('show');
  document.getElementById('callTitle').textContent = '📹 Video Call' + (targetName ? ' with ' + targetName : '');
  _vcSetRemoteLabel(targetName || 'Waiting...');
  _vcStatus('Starting camera...');
  _vcHideRemoteVideo();

  // Reset placeholder for local video
  var ph = document.getElementById('localPlaceholder');
  if (ph) ph.style.display = '';
  var lv = document.getElementById('localVideo');
  if (lv) { lv.classList.remove('active'); lv.srcObject = null; }

  await _vcGetMedia();
  if (!_vc.localStream) return; // permission denied

  _vc.role = 'caller';
  var pc = _vcCreatePC();

  // Create Firestore signaling doc
  var callDoc = db.collection('calls').doc();
  _vc.callDocId = callDoc.id;

  var offerDesc = await pc.createOffer();
  await pc.setLocalDescription(offerDesc);

  var callData = {
    offer: { type: offerDesc.type, sdp: offerDesc.sdp },
    caller: state.currentUser.name,
    callee: targetName || null,
    status: 'calling',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await callDoc.set(callData);

  _vcStatus('Calling' + (targetName ? ' ' + targetName : '') + '...');

  // Listen for callee ICE candidates
  var _pendingCalleeCands = [];
  _vc.unsubCandCallee = callDoc.collection('calleeCandidates').onSnapshot(function(snap) {
    snap.docChanges().forEach(async function(change) {
      if (change.type === 'added') {
        if (pc.remoteDescription) {
          var cand = new RTCIceCandidate(change.doc.data());
          await pc.addIceCandidate(cand).catch(console.error);
        } else {
          _pendingCalleeCands.push(change.doc.data());
        }
      }
    });
  });

  // Listen for answer + drain pending ICE candidates after remote description is set
  _vc.unsubAnswer = callDoc.onSnapshot(async function(snap) {
    var data = snap.data();
    if (!data) return;

    // Callee's device received the call — start ringing for the caller
    if (data.status === 'ringing' && !_ring.playing) {
      _ringStartOutgoing();
    }

    if (data.status === 'declined') {
      _vcStatus('Call declined ❌');
      _ringStop();
      return;
    }
    if (data.answer && !pc.currentRemoteDescription) {
      var answerDesc = new RTCSessionDescription(data.answer);
      await pc.setRemoteDescription(answerDesc).catch(console.error);
      _ringStop(); // callee answered — stop caller's ringtone
      _vcStatus('Connected ✅');
      _vcSetRemoteLabel(data.callee || 'Remote');
      // Drain any queued candidates
      for (var i = 0; i < _pendingCalleeCands.length; i++) {
        await pc.addIceCandidate(new RTCIceCandidate(_pendingCalleeCands[i])).catch(console.error);
      }
      _pendingCalleeCands = [];
    }
  });
}

// ── ANSWER CALL (callee side) ────────────────────────────────
async function answerCall() {
  var callId = _vc.incomingCallId;
  var callerName = document.getElementById('incomingCallerName').textContent;
  hideIncomingCallBar();

  document.getElementById('callModal').classList.add('show');
  document.getElementById('callTitle').textContent = '📹 Call with ' + callerName;
  _vcSetRemoteLabel(callerName);
  _vcStatus('Starting camera...');
  _vcHideRemoteVideo();

  var ph = document.getElementById('localPlaceholder');
  if (ph) ph.style.display = '';
  var lv = document.getElementById('localVideo');
  if (lv) { lv.classList.remove('active'); lv.srcObject = null; }

  await _vcGetMedia();
  if (!_vc.localStream) return;

  _vc.role = 'callee';
  _vc.callDocId = callId;
  var pc = _vcCreatePC();
  var callDoc = db.collection('calls').doc(callId);

  // Get offer
  var callData = (await callDoc.get()).data();
  if (!callData || !callData.offer) { _vcStatus('Call no longer available'); return; }

  await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

  var answerDesc = await pc.createAnswer();
  await pc.setLocalDescription(answerDesc);

  await callDoc.update({
    answer: { type: answerDesc.type, sdp: answerDesc.sdp },
    status: 'answered'
  });

  _vcStatus('Connecting...');

  // Listen for caller ICE candidates
  _vc.unsubCandCaller = callDoc.collection('callerCandidates').onSnapshot(function(snap) {
    snap.docChanges().forEach(async function(change) {
      if (change.type === 'added' && pc.remoteDescription) {
        var cand = new RTCIceCandidate(change.doc.data());
        await pc.addIceCandidate(cand).catch(console.error);
      }
    });
  });
}

// ── INCOMING CALL LISTENER ───────────────────────────────────
function startIncomingCallListener() {
  if (_vc.unsubIncoming) return; // already listening

  // Single-field query on 'callee' — no composite index needed.
  // Filter status client-side to keep it simple.
  _vc.unsubIncoming = db.collection('calls')
    .where('callee', '==', state.currentUser.name)
    .onSnapshot(function(snap) {
      snap.docChanges().forEach(function(change) {
        var data = change.doc.data();

        if (change.type === 'added' && data.status === 'calling') {
          // Don't pop if already in a call
          if (document.getElementById('callModal').classList.contains('show')) return;
          _vc.incomingCallId = change.doc.id;
          showIncomingCallBar(data.caller, change.doc.id);
        }

        if (change.type === 'modified') {
          if (data.status !== 'calling' && _vc.incomingCallId === change.doc.id) {
            hideIncomingCallBar();
          }
        }

        if (change.type === 'removed') {
          if (_vc.incomingCallId === change.doc.id) {
            hideIncomingCallBar();
          }
        }
      });
    }, function(err) {
      console.warn('Incoming call listener error:', err.message);
      // Fallback to polling if real-time listener fails
      _vcStartPollingForCalls();
    });
}

// Fallback polling (used if real-time listener fails)
var _vcPollTimer = null;
var _vcSeenCallIds = new Set();

function _vcStartPollingForCalls() {
  if (_vcPollTimer) return; // already polling
  console.warn('Falling back to polling for incoming calls');

  _vcPollTimer = setInterval(async function() {
    if (document.getElementById('callModal').classList.contains('show')) return;
    try {
      var snap = await db.collection('calls')
        .where('callee', '==', state.currentUser.name)
        .where('status', '==', 'calling')
        .get();

      snap.docs.forEach(function(d) {
        if (_vcSeenCallIds.has(d.id)) return;
        _vcSeenCallIds.add(d.id);
        _vc.incomingCallId = d.id;
        showIncomingCallBar(d.data().caller, d.id);
      });

      // Hide bar if call is no longer active
      if (_vc.incomingCallId) {
        var stillCalling = snap.docs.some(function(d) { return d.id === _vc.incomingCallId; });
        if (!stillCalling) hideIncomingCallBar();
      }
    } catch(e) {}
  }, 3000);
}

function showIncomingCallBar(callerName, callId) {
  _vc.incomingCallId = callId;
  document.getElementById('incomingCallerName').textContent = callerName;
  document.getElementById('incomingCallBar').style.display = 'flex';
  _ringStartIncoming(); // play incoming ringtone on callee's device
  // Tell the caller that this device received the call — so their ringtone starts
  db.collection('calls').doc(callId).update({ status: 'ringing' }).catch(function(){});
}

function hideIncomingCallBar() {
  document.getElementById('incomingCallBar').style.display = 'none';
  _vc.incomingCallId = null;
  _ringStop(); // stop incoming ringtone
}

function declineCall() {
  var callId = _vc.incomingCallId;
  hideIncomingCallBar();
  if (callId) {
    db.collection('calls').doc(callId).update({ status: 'declined' }).catch(function(){});
  }
}

// ── CLOSE CALL ───────────────────────────────────────────────
function closeCall() {
  document.getElementById('callModal').classList.remove('show');
  _ringStop(); // stop any ringtone (outgoing or incoming)

  // Stop local stream tracks
  if (_vc.localStream) {
    _vc.localStream.getTracks().forEach(function(t) { t.stop(); });
    _vc.localStream = null;
  }

  // Close peer connection
  if (_vc.pc) {
    try { _vc.pc.close(); } catch(e) {}
    _vc.pc = null;
  }

  // Unsubscribe Firestore listeners
  if (_vc.unsubAnswer)     { _vc.unsubAnswer();     _vc.unsubAnswer = null; }
  if (_vc.unsubCandCaller) { _vc.unsubCandCaller(); _vc.unsubCandCaller = null; }
  if (_vc.unsubCandCallee) { _vc.unsubCandCallee(); _vc.unsubCandCallee = null; }

  // Mark call as ended in Firestore
  if (_vc.callDocId) {
    db.collection('calls').doc(_vc.callDocId)
      .update({ status: 'ended' })
      .catch(function(){});
    _vc.callDocId = null;
  }

  _vc.role   = null;
  _vc.micOn  = true;
  _vc.camOn  = true;

  // Reset UI
  var lv = document.getElementById('localVideo');
  var rv = document.getElementById('remoteVideo');
  if (lv) { lv.srcObject = null; lv.classList.remove('active'); }
  if (rv) { rv.srcObject = null; rv.classList.remove('active'); }
  var lph = document.getElementById('localPlaceholder');
  var rph = document.getElementById('remotePlaceholder');
  if (lph) lph.style.display = '';
  if (rph) rph.style.display = '';
  var micBtn = document.getElementById('micBtn');
  var camBtn = document.getElementById('camBtn');
  if (micBtn) { micBtn.textContent = '🎤'; micBtn.classList.remove('muted'); }
  if (camBtn) { camBtn.textContent = '📷'; camBtn.classList.remove('cam-off'); }
  _vcStatus('');
}

// ── TOGGLE MIC / CAM ────────────────────────────────────────
function toggleMic() {
  var btn = document.getElementById('micBtn');
  if (!_vc.localStream) return;
  _vc.micOn = !_vc.micOn;
  _vc.localStream.getAudioTracks().forEach(function(t) { t.enabled = _vc.micOn; });
  if (btn) {
    btn.textContent = _vc.micOn ? '🎤' : '🔇';
    btn.classList.toggle('muted', !_vc.micOn);
  }
}

function toggleCam() {
  var btn = document.getElementById('camBtn');
  if (!_vc.localStream) return;
  _vc.camOn = !_vc.camOn;
  _vc.localStream.getVideoTracks().forEach(function(t) { t.enabled = _vc.camOn; });
  if (btn) {
    btn.textContent = _vc.camOn ? '📷' : '🚫';
    btn.classList.toggle('cam-off', !_vc.camOn);
  }
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
// Returns true if str contains only emoji characters (and whitespace), no regular text
function isEmojiOnly(str) {
  // Strip whitespace, then check if what remains consists entirely of emoji code points
  var stripped = str.replace(/\s/g, '');
  if (!stripped.length) return false;
  // Match emoji sequences: base emoji + optional variation/ZWJ/skin-tone modifiers
  var emojiRegex = /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*[\u{1F3FB}-\u{1F3FF}]?(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:[\u{1F3FB}-\u{1F3FF}])?)*$/u;
  // Split into grapheme-like clusters and test each
  var segments = Array.from(stripped.matchAll(/\p{Emoji_Presentation}(?:\uFE0F|\u20E3)?(?:\u200D\p{Emoji_Presentation}(?:\uFE0F|\u20E3)?)*[\u{1F3FB}-\u{1F3FF}]?|\p{Emoji}\uFE0F(?:\u200D\p{Emoji_Presentation}(?:\uFE0F|\u20E3)?)*[\u{1F3FB}-\u{1F3FF}]?/gu));
  if (!segments.length) return false;
  // Ensure the full stripped string is covered by emoji matches only
  var totalLen = segments.reduce(function(sum, m) { return sum + m[0].length; }, 0);
  return totalLen === stripped.length && segments.length <= 5;
}

function renderText(str) {
  // If the message is emoji-only, render it large with no bubble background
  if (isEmojiOnly(str)) {
    return '<span class="emoji-large">' + escapeHtml(str) + '</span>';
  }
  var escaped = escapeHtml(str);
  escaped = escaped.replace(/\n/g, '<br>');
  return linkify(escaped);
}

// Get a user's color (for seen avatars)
function getUserColor(name) {
  var u = _lastKnownUsers.find(function(u) { return u.name === name; });
  return u ? u.color : '#6264a7';
}

// Mark this channel as seen by current user
function markChannelSeen(channelId, msgs) {
  // Only mark as read when the window is actually active and visible
  // If the user has the tab open but is working in another window/tab, don't mark as read
  if (document.hidden || !document.hasFocus()) return;

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
  // _onWindowActive (registered in DOMContentLoaded) handles seen marking and full cleanup.
  // This just ensures the tab title/favicon clear immediately on focus.
  updateTabTitle();
  updateFavicon(Object.values(state.unread).some(function(n) { return n > 0; }));
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

  // DRAG-AND-DROP image onto the chat area
  var main = document.querySelector('.main');
  if (main) {
    main.addEventListener('dragover', function(e) {
      e.preventDefault();
      main.classList.add('drag-over');
    });
    main.addEventListener('dragleave', function(e) {
      if (!main.contains(e.relatedTarget)) main.classList.remove('drag-over');
    });
    main.addEventListener('drop', function(e) {
      e.preventDefault();
      main.classList.remove('drag-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      addFilesToPending(files);
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
  
  // Get text but exclude the nested quote block and any action buttons
  let text = '';
  if (bubble) {
    // Clone the bubble to manipulate it
    const clone = bubble.cloneNode(true);
    // Remove the quoted block (nested reply preview) — we only want the direct message text
    const nestedQuote = clone.querySelector('.msg-quote');
    if (nestedQuote) nestedQuote.remove();
    // Remove action buttons if any remain
    const actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    // Get text and clean up
    text = clone.innerText
      .replace(/👍|❤️|😂|🗑️|↩️|✏️/g, '') // Remove any remaining emoji icons
      .replace(/[\n\r]+/g, ' ')            // Replace newlines with spaces
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

  // ── Optimistic update — close the edit row and update the bubble immediately ──
  const editRow = document.getElementById('editrow-' + msgId);
  const group   = document.querySelector('[data-msg-id="' + msgId + '"]');

  if (group) {
    // Update the bubble text in the DOM right now
    var bubble = document.getElementById('bubble-' + msgId);
    if (bubble) {
      // Preserve the quote block if present
      var quoteEl = bubble.querySelector('.msg-quote');
      var quoteHtml = quoteEl ? quoteEl.outerHTML : '';
      bubble.innerHTML = quoteHtml + renderText(newText);
    }
    // Add (edited) tag to meta if not already there
    var meta = group.querySelector('.msg-meta');
    if (meta && !meta.querySelector('.msg-edited-tag')) {
      var tag = document.createElement('span');
      tag.className   = 'msg-edited-tag';
      tag.textContent = '(edited)';
      meta.appendChild(tag);
    }
    group.style.display = '';
  }
  if (editRow) editRow.remove();

  // ── Fire Firestore write in background — no await ─────────────────────────
  db.collection('channels').doc(state.currentChannel).collection('messages').doc(msgId).update({
    text:   newText,
    edited: true,
  }).catch(function(err) {
    console.error('Edit save failed:', err);
    // On failure the Firestore listener will re-render with the original text
  });
}

function cancelEdit(msgId) {
  // Remove edit row and restore original group
  const editRow = document.getElementById('editrow-' + msgId);
  if (editRow) editRow.remove();
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.display = '';
}

// ── NOTIFICATIONS ──────────────────────────────────────────

// Track message IDs that have already triggered a notification — prevents duplicates
// when startNotifListeners is restarted or the active-channel listener also fires.
var _notifiedMsgIds = new Set();

// Guard so we only start ONE listener — restart only when truly needed
var _notifListenerActive = false;

function startNotifListeners() {
  // Only create the listener once. Subsequent calls are no-ops.
  if (_notifListenerActive) return;
  _notifListenerActive = true;

  // Tear down any stale listeners first
  state.unsubscribeNotifs.forEach(function(unsub) { unsub(); });
  state.unsubscribeNotifs = [];

  // Build a label lookup
  var labelMap = {};
  channels.forEach(function(ch) { labelMap[ch.id] = ch.label || ('#' + ch.id); });
  _lastKnownUsers.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    labelMap[dmId] = getDmNickname(u.name);
  });

  // Only listen for messages newer than right now
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

        // Deduplicate — never fire the same message twice
        if (_notifiedMsgIds.has(m.id)) return;
        _notifiedMsgIds.add(m.id);

        // Derive channel ID from path: channels/{channelId}/messages/{msgId}
        var pathParts = doc.ref.path.split('/');
        var chId = pathParts[1];

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

        // Only show a browser notification if the window doesn't have focus
        // OR if the message is not in the currently open channel
        var isCurrentChannel = (chId === state.currentChannel);
        var hasFocus = document.hasFocus();
        if (hasFocus && isCurrentChannel) return;

        var chLabel = labelMap[chId] || chId;
        // Keep label map fresh for DMs
        if (!chLabel && chId.startsWith('dm-')) {
          _lastKnownUsers.forEach(function(u) {
            if (u.name !== state.currentUser.name) {
              var id = dmChannelId(state.currentUser.name, u.name);
              if (id === chId) chLabel = getDmNickname(u.name);
            }
          });
        }

        var cleanText = (m.text || '')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .slice(0, 100);

        showBrowserNotification(m.sender + ' · ' + (chLabel || chId), cleanText, chId);
      });
    }, function(err) {
      _notifListenerActive = false; // allow retry on next call if index missing
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
      // renotify removed — prevents repeated OS alerts for the same channel
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
