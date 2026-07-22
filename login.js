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
