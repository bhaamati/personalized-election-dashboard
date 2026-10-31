/**
 * Google sign-in + cloud syncing for the existing GitHub Pages dashboard.
 * This file is an ES module. It does not change how civicAPI is queried.
 *
 * Guest mode: existing localStorage key, unchanged.
 * Signed-in mode: users/{Firebase UID}.followedRaces in Cloud Firestore.
 * Each add/remove is an atomic array transform, not a whole-list overwrite.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import {
  getFirestore, doc, getDocFromServer, onSnapshot,
  setDoc, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const dashboard = window.electionDashboard;
const titleElement = document.getElementById('account-title');
const copyElement = document.getElementById('account-copy');
const messageElement = document.getElementById('account-message');
const loginButton = document.getElementById('google-login');
const logoutButton = document.getElementById('google-logout');
const retryButton = document.getElementById('google-retry');
const importBanner = document.getElementById('guest-import-banner');
const importDescription = document.getElementById('guest-import-description');
const importYes = document.getElementById('guest-import-yes');
const importNo = document.getElementById('guest-import-no');

// Preserve previously saved lists (up to the old 500-entry safeguard), but
// only allow up to 50 race selections for new Google-account additions.
// Guest localStorage is never subject to this limit.
const MAX_STORED = 500;
const GOOGLE_ACCOUNT_RACE_LIMIT = 50;
let auth;
let db;
let user = null;
let userDocument = null;
let accountMode = 'guest'; // guest | loading | user | error
let accountGeneration = 0;
let unsubscribe = null;
let cloudIds = [];
let changesPending = new Map();
let nextChangeVersion = 0;
let skippedImportThisSession = false;
let accountError = '';

/** Limit document data to a list of short race IDs. */
function cleanIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(id =>
    typeof id === 'string' && id.length > 0 && id.length <= 120))]
    .slice(0, MAX_STORED);
}

function isConfigured(config) {
  return !!config &&
    ['apiKey', 'authDomain', 'projectId', 'appId'].every(key =>
      typeof config[key] === 'string' &&
      config[key].length > 0 && !config[key].includes('PASTE_'));
}

function setAccountMode(next) {
  accountMode = next;
  document.body.classList.toggle('account-loading',
    next === 'loading' || next === 'error');
}

function setMessage(title, description) {
  // Guests see no account-status label; keep messages when something needs
  // attention (for example, a login failure or a failed cloud save).
  titleElement.textContent = title;
  messageElement.textContent = description;
  titleElement.hidden = !title;
  messageElement.hidden = !description;
  copyElement.hidden = !title && !description;
}

function displayGuest() {
  setAccountMode('guest');
  user = null;
  userDocument = null;
  cloudIds = [];
  changesPending.clear();
  setMessage('', '');
  loginButton.hidden = false;
  logoutButton.hidden = true;
  retryButton.hidden = true;
  importBanner.hidden = true;
  dashboard.applyRaces(dashboard.guestRaces());
  dashboard.refreshAccountUI();
}

function displayAccount() {
  if (accountMode === 'loading') {
    setMessage('Loading Google account…', 'Retrieving your saved election races.');
  } else if (accountMode === 'error') {
    setMessage('Cloud sync unavailable', accountError || 'Try again or sign out.');
  } else if (user) {
    const identity = user.email || user.displayName || 'Google account';
    let description = 'Saved races are synced across devices.';
    if (!navigator.onLine) {
      description = 'Offline. Reconnect before changing followed races.';
    } else if (changesPending.size) {
      description = `Syncing ${changesPending.size} change${changesPending.size === 1 ? '' : 's'}…`;
    }
    setMessage(identity, description);
  }
  loginButton.hidden = true;
  logoutButton.hidden = !user;
  retryButton.hidden = accountMode !== 'error';
}

/** Firestore may emit an older snapshot while this device has pending edits. */
function visibleCloudIds() {
  const ids = new Set(cloudIds);
  for (const [id, pending] of changesPending) {
    if (pending.add) ids.add(id);
    else ids.delete(id);
  }
  return [...ids];
}

function applyCloudRaces() {
  dashboard.applyRaces(visibleCloudIds());
}

function updateImportOffer() {
  if (accountMode !== 'user' || !user || skippedImportThisSession) {
    importBanner.hidden = true;
    return;
  }
  const cloudSet = new Set(visibleCloudIds());
  const available = Math.max(0, GOOGLE_ACCOUNT_RACE_LIMIT - cloudSet.size);
  const missing = cleanIds(dashboard.guestRaces()).filter(id => !cloudSet.has(id));
  if (!missing.length || !available) {
    importBanner.hidden = true;
    return;
  }
  const count = Math.min(missing.length, available);
  importDescription.textContent = missing.length > available
    ? `Your Google account has room for ${count} more race${count === 1 ? '' : 's'}. You can import the first ${count} of your ${missing.length} guest races; the rest will stay saved on this device.`
    : `${count} race${count === 1 ? '' : 's'} saved on this device can be added to your Google account. Your current cloud selections will be kept.`;
  importBanner.hidden = false;
}

/** The only place the main app writes account selections to Firestore. */
async function saveCloudChange(action, raceId) {
  if (accountMode !== 'user' || !userDocument || !user ||
      !['add', 'remove'].includes(action)) return;
  const thisAccount = accountGeneration;
  const add = action === 'add';
  const version = ++nextChangeVersion;
  changesPending.set(raceId, { add, version });
  displayAccount();
  const total = visibleCloudIds().length;
  // Existing Google accounts above the limit can still REMOVE races.
  if (add && total > GOOGLE_ACCOUNT_RACE_LIMIT) {
    changesPending.delete(raceId);
    applyCloudRaces();
    accountError = `Google accounts can save up to ${GOOGLE_ACCOUNT_RACE_LIMIT} races. Remove one before adding another.`;
    setMessage(user.email || 'Google account', accountError);
    return;
  }

  try {
    // arrayUnion/arrayRemove avoid overwriting selections made on other devices.
    await setDoc(userDocument, {
      followedRaces: add ? arrayUnion(raceId) : arrayRemove(raceId),
    }, { merge: true });
    if (thisAccount !== accountGeneration) return;
    if (changesPending.get(raceId)?.version === version) {
      changesPending.delete(raceId);
    }
    applyCloudRaces();
    displayAccount();
    updateImportOffer();
  } catch (error) {
    if (thisAccount !== accountGeneration) return;
    console.error('Could not sync followed race:', error);
    if (changesPending.get(raceId)?.version === version) {
      changesPending.delete(raceId);
      // Revert only the failed optimistic change, not other pending changes.
      applyCloudRaces();
    }
    displayAccount();
    setMessage(user.email || 'Google account',
      'A change could not be saved. Please try again when connected.');
  }
}

// Keep this adapter small: the existing app owns the UI and civicAPI logic.
window.electionCloud = {
  raceLimit: GOOGLE_ACCOUNT_RACE_LIMIT,
  isSignedIn() { return accountMode === 'user'; },
  accountKey() { return user ? user.uid : 'guest'; },
  canEdit() {
    if (accountMode === 'loading' || accountMode === 'error') return false;
    if (accountMode === 'user' && !navigator.onLine) {
      displayAccount();
      return false;
    }
    return true;
  },
  saveChange: saveCloudChange,
};

/** Load one account; never reuse another account's cloud list or listener. */
async function openAccount(nextUser) {
  const generation = ++accountGeneration;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  changesPending.clear();
  skippedImportThisSession = false;
  accountError = '';

  if (!nextUser) {
    displayGuest();
    return;
  }

  user = nextUser;
  userDocument = doc(db, 'users', nextUser.uid);
  setAccountMode('loading');
  importBanner.hidden = true;
  displayAccount();
  // Hide the previous account's races before loading the next one.
  dashboard.applyRaces([]);

  try {
    const first = await getDocFromServer(userDocument);
    if (generation !== accountGeneration) return;
    cloudIds = cleanIds(first.exists() ? first.data().followedRaces : []);
    setAccountMode('user');
    applyCloudRaces();
    dashboard.refreshAccountUI();
    displayAccount();
    updateImportOffer();

    // Realtime updates: a race followed on another device appears here.
    unsubscribe = onSnapshot(userDocument, { includeMetadataChanges: true },
      snapshot => {
        if (generation !== accountGeneration) return;
        cloudIds = cleanIds(snapshot.exists() ? snapshot.data().followedRaces : []);
        applyCloudRaces();
        displayAccount();
        updateImportOffer();
      },
      error => {
        if (generation !== accountGeneration) return;
        console.error('Cloud listener stopped:', error);
        accountError = 'Could not listen for updates. Retry sync to reconnect.';
        setAccountMode('error');
        displayAccount();
        importBanner.hidden = true;
      });
  } catch (error) {
    if (generation !== accountGeneration) return;
    console.error('Could not load Google account:', error);
    accountError = 'Could not load saved races. Check your internet connection, then retry.';
    setAccountMode('error');
    displayAccount();
    importBanner.hidden = true;
  }
}

loginButton.addEventListener('click', async () => {
  if (!auth) return;
  loginButton.disabled = true;
  try {
    // The click itself triggers the popup; do not await anything before it.
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    console.error('Google sign-in failed:', error);
    const code = error?.code || 'unknown';
    setMessage('', `Google sign-in failed (${code}). You can try again.`);
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  if (!auth) return;
  logoutButton.disabled = true;
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Sign-out failed:', error);
    setMessage(user?.email || 'Google account', 'Could not sign out. Please try again.');
  } finally {
    logoutButton.disabled = false;
  }
});

retryButton.addEventListener('click', () => {
  if (auth?.currentUser) openAccount(auth.currentUser);
});

importNo.addEventListener('click', () => {
  skippedImportThisSession = true;
  importBanner.hidden = true;
});

importYes.addEventListener('click', async () => {
  if (accountMode !== 'user' || !userDocument) return;
  const generation = accountGeneration;
  const existing = new Set(visibleCloudIds());
  const available = Math.max(0, GOOGLE_ACCOUNT_RACE_LIMIT - existing.size);
  const missing = cleanIds(dashboard.guestRaces())
    .filter(id => !existing.has(id)).slice(0, available);
  if (!missing.length) {
    importBanner.hidden = true;
    return;
  }
  importYes.disabled = true;
  importNo.disabled = true;
  setMessage(user.email || 'Google account', 'Importing saved races…');
  try {
    // One atomic union adds guest races without replacing the cloud list.
    await setDoc(userDocument, { followedRaces: arrayUnion(...missing) }, { merge: true });
    if (generation !== accountGeneration) return;
    skippedImportThisSession = true;
    importBanner.hidden = true;
    displayAccount();
  } catch (error) {
    if (generation !== accountGeneration) return;
    console.error('Could not import guest races:', error);
    setMessage(user.email || 'Google account',
      'Guest races could not be imported. Your local list is unchanged.');
  } finally {
    importYes.disabled = false;
    importNo.disabled = false;
  }
});

window.addEventListener('online', () => { if (user) displayAccount(); });
window.addEventListener('offline', () => { if (user) displayAccount(); });

// Firebase is optional; visitors can still use the guest dashboard when
// configuration is missing or the SDK cannot initialize. Never hide sign-in
// silently: the visible button explains the setup issue if clicked.
if (!isConfigured(firebaseConfig)) {
  loginButton.hidden = false;
  console.warn('Firebase configuration missing. Update firebase-config.js on GitHub Pages.');
} else {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    window.electionAuthReady = true;
    setAccountMode('loading');
    displayAccount();
    // Browser storage may be unavailable in a private/restricted session.
    // Try local persistence, but still allow authentication if it is blocked.
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (error) {
      console.warn('Persistent Firebase Auth storage unavailable:', error);
    }
    onAuthStateChanged(auth, openAccount, error => {
      console.error('Firebase authentication initialization failed:', error);
      setAccountMode('error');
      accountError = 'Google sign-in could not be initialized. Reload to try again.';
      displayAccount();
    });
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    window.electionAuthReady = false;
    setAccountMode('guest');
    loginButton.hidden = false;
  }
}
