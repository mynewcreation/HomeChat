// ── COLOR GENERATOR ──
function getColor(name) {
  const palette = ['#0e7c63','#8e44ad','#e67e22','#2980b9','#c0392b','#16a085','#d35400','#8e44ad'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

// ── NETWORK CHECK ──
function isOnline() { return navigator.onLine; }

// ── TABS ──
function showTab(tab) {
  document.getElementById('loginTab').classList.toggle('active', tab === 'login');
  document.getElementById('registerTab').classList.toggle('active', tab === 'register');
  document.getElementById('loginForm').style.display    = tab === 'login'    ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('loginError').textContent     = '';
  document.getElementById('registerError').textContent  = '';
}

// ── LOGIN ──
async function handleLogin(e) {
  e.preventDefault();
  const name  = document.getElementById('loginUsername').value.trim();
  const pass  = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');

  if (!name || !pass) { errEl.textContent = 'Please enter username and password.'; return; }

  // ── OFFLINE LOGIN ──────────────────────────────────────
  if (!isOnline()) {
    const cached = OfflineStore.getCachedUser(name.toLowerCase());
    if (!cached) {
      errEl.textContent = '📡 Offline — this account has never signed in on this device.';
      return;
    }
    if (cached.password !== pass) {
      errEl.textContent = 'Wrong password.';
      return;
    }
    sessionStorage.setItem('teamsUser', JSON.stringify({
      id: cached.id, name: cached.name, color: cached.color,
      status: 'offline', isOfflineSession: true,
    }));
    window.location.href = 'teams.html';
    return;
  }

  // ── ONLINE LOGIN ───────────────────────────────────────
  errEl.textContent = 'Signing in...';
  try {
    const snap = await db.collection('users')
      .where('nameLower', '==', name.toLowerCase())
      .limit(1).get();

    if (snap.empty) { errEl.textContent = 'User not found.'; return; }

    const doc  = snap.docs[0];
    const user = doc.data();

    if (user.password !== pass) { errEl.textContent = 'Wrong password.'; return; }

    // Cache user locally for future offline logins
    OfflineStore.upsertCachedUser({
      id: doc.id, name: user.name, nameLower: user.nameLower,
      password: pass, color: user.color, status: 'online',
    });

    await doc.ref.update({ status: 'online' }).catch(function() {});

    sessionStorage.setItem('teamsUser', JSON.stringify({
      id: doc.id, name: user.name, color: user.color, status: 'online',
    }));
    window.location.href = 'teams.html';

  } catch (err) {
    console.error('Login error:', err);
    // Firestore permission error — rules may have expired
    if (err.code === 'permission-denied') {
      errEl.textContent = '⚠️ Database permission denied. Please update Firestore security rules to allow read/write.';
      return;
    }
    // Try offline fallback
    const cached = OfflineStore.getCachedUser(name.toLowerCase());
    if (cached && cached.password === pass) {
      sessionStorage.setItem('teamsUser', JSON.stringify({
        id: cached.id, name: cached.name, color: cached.color,
        status: 'offline', isOfflineSession: true,
      }));
      window.location.href = 'teams.html';
    } else {
      errEl.textContent = 'Error: ' + err.message;
    }
  }
}

// ── REGISTER ──
async function handleRegister(e) {
  e.preventDefault();
  const name    = document.getElementById('regUsername').value.trim();
  const pass    = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regConfirm').value;
  const errEl   = document.getElementById('registerError');

  if (pass !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
  if (pass.length < 4)  { errEl.textContent = 'Password must be at least 4 characters.'; return; }

  if (!isOnline()) {
    errEl.textContent = '📡 Registration requires an internet connection.';
    return;
  }

  errEl.textContent = 'Creating account...';

  try {
    const existing = await db.collection('users')
      .where('nameLower', '==', name.toLowerCase()).limit(1).get();
    if (!existing.empty) { errEl.textContent = 'Username already taken.'; return; }

    const color = getColor(name);
    const ref   = await db.collection('users').add({
      name, nameLower: name.toLowerCase(),
      password: pass, color, status: 'online',
    });

    // Cache for offline use
    OfflineStore.upsertCachedUser({
      id: ref.id, name, nameLower: name.toLowerCase(),
      password: pass, color, status: 'online',
    });

    sessionStorage.setItem('teamsUser', JSON.stringify({
      id: ref.id, name, color, status: 'online',
    }));
    window.location.href = 'teams.html';

  } catch (err) {
    errEl.textContent = 'Error: ' + err.message;
  }
}

// ── NETWORK STATUS INDICATOR ──
function updateNetworkBadge() {
  const badge = document.getElementById('networkBadge');
  if (!badge) return;
  if (isOnline()) {
    badge.textContent  = '🟢 Online';
    badge.className    = 'network-badge online';
  } else {
    badge.textContent  = '🔴 Offline mode';
    badge.className    = 'network-badge offline';
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  updateNetworkBadge();
  window.addEventListener('online',  updateNetworkBadge);
  window.addEventListener('offline', updateNetworkBadge);

  // Seed default users if collection is empty (online only)
  if (isOnline()) {
    db.collection('users').limit(1).get().then(snap => {
      if (snap.empty) {
        const defaults = [
          { name: 'Mark',    password: 'mark123',  color: '#0e7c63' },
          { name: 'Ces',     password: 'ces123',   color: '#8e44ad' },
          { name: 'Admin',   password: 'admin123', color: '#e67e22' },
          { name: 'Mark T.', password: 'markt123', color: '#2980b9' },
        ];
        defaults.forEach(u => {
          db.collection('users').add({
            ...u, nameLower: u.name.toLowerCase(), status: 'offline',
          }).then(ref => {
            OfflineStore.upsertCachedUser({ id: ref.id, ...u, nameLower: u.name.toLowerCase() });
          });
        });
      } else {
        // Cache all existing users for offline login
        db.collection('users').get().then(all => {
          all.docs.forEach(d => OfflineStore.upsertCachedUser({ id: d.id, ...d.data() }));
        });
      }
    }).catch(() => {});
  }
});
