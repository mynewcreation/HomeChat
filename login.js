// ── COLOR GENERATOR ──
function getColor(name) {
  const palette = ['#0e7c63','#8e44ad','#e67e22','#2980b9','#c0392b','#16a085','#d35400','#8e44ad'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

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

  errEl.textContent = 'Signing in...';
  try {
    const snap = await db.collection('users')
      .where('nameLower', '==', name.toLowerCase())
      .limit(1).get();

    if (snap.empty) { errEl.textContent = 'User not found.'; return; }

    const doc  = snap.docs[0];
    const user = doc.data();

    if (user.password !== pass) { errEl.textContent = 'Wrong password.'; return; }

    await doc.ref.update({
      status:   'online',
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(function() {});

    sessionStorage.setItem('teamsUser', JSON.stringify({
      id: doc.id, name: user.name, color: user.color, status: 'online',
    }));
    window.location.href = 'teams.html';

  } catch (err) {
    console.error('Login error:', err);
    if (err.code === 'permission-denied') {
      errEl.textContent = '⚠️ Database permission denied. Please update Firestore security rules.';
      return;
    }
    errEl.textContent = 'Error: ' + err.message;
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

  errEl.textContent = 'Creating account...';

  try {
    const existing = await db.collection('users')
      .where('nameLower', '==', name.toLowerCase()).limit(1).get();
    if (!existing.empty) { errEl.textContent = 'Username already taken.'; return; }

    const color = getColor(name);
    const ref   = await db.collection('users').add({
      name, nameLower: name.toLowerCase(),
      password: pass, color, status: 'online',
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    });

    sessionStorage.setItem('teamsUser', JSON.stringify({
      id: ref.id, name, color, status: 'online',
    }));
    window.location.href = 'teams.html';

  } catch (err) {
    errEl.textContent = 'Error: ' + err.message;
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  // Nothing to initialize on load
});
