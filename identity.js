/*
 * identity.js — current-user picker + persistence.
 *
 * The app has no auth yet; for activity attribution we ask each browser
 * to pick their name from the roster on first visit, then remember it.
 *
 * Storage: localStorage key `quintar_user` → JSON { name, slackUserId, slackHandle? }.
 *
 * UI: a self-contained dark modal that injects its own styles. Two modes —
 *   - required:   blocks dismissal until a name is picked (first visit)
 *   - switchable: shows a close button + Esc dismisses (pill clicked to swap)
 */

const STORAGE_KEY = 'quintar_user';

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCurrentUser(user) {
  if (!user) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    name:        user.name,
    slackUserId: user.slackUserId || null,
    slackHandle: user.slackHandle || null,
  }));
}

export function clearCurrentUser() {
  localStorage.removeItem(STORAGE_KEY);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Picker modal
 * ──────────────────────────────────────────────────────────────────────────── */

const STYLES = `
.qid-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.78);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  animation: qid-fade 180ms ease-out;
}
@keyframes qid-fade { from { opacity: 0; } to { opacity: 1; } }
.qid-modal {
  background: linear-gradient(180deg, #181818, #0e0e0e);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  padding: 28px 32px 24px;
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  font-family: 'IBM Plex Sans', -apple-system, sans-serif;
  color: #fff;
  position: relative;
}
.qid-title {
  font-family: 'Questrial', sans-serif;
  font-size: 16px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #62B3C6;
  margin: 0 0 6px;
}
.qid-sub {
  font-size: 12px;
  color: #97999B;
  margin: 0 0 22px;
  line-height: 1.5;
}
.qid-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
@media (max-width: 480px) {
  .qid-grid { grid-template-columns: 1fr; }
  .qid-modal { padding: 22px; }
}
.qid-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  cursor: pointer;
  transition: border-color 120ms, background 120ms, transform 80ms;
  text-align: left;
  font: inherit;
  color: inherit;
}
.qid-card:hover {
  border-color: rgba(98,179,198,0.6);
  background: rgba(98,179,198,0.06);
}
.qid-card:active { transform: scale(0.98); }
.qid-card.is-current {
  border-color: rgba(98,179,198,0.7);
  background: rgba(98,179,198,0.10);
}
.qid-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
  background: linear-gradient(135deg, #62B3C6, #3a7a8a);
  color: #fff;
  flex: 0 0 32px;
}
.qid-name { font-size: 13px; font-weight: 500; line-height: 1.2; }
.qid-handle { font-size: 11px; color: #97999B; margin-top: 2px; }
.qid-close {
  position: absolute; top: 14px; right: 14px;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: #97999B; font-size: 18px; cursor: pointer;
  border-radius: 4px;
}
.qid-close:hover { color: #fff; background: rgba(255,255,255,0.06); }
`;

let _stylesInjected = false;
function _ensureStyles() {
  if (_stylesInjected) return;
  const tag = document.createElement('style');
  tag.textContent = STYLES;
  document.head.appendChild(tag);
  _stylesInjected = true;
}

function _initials(name) {
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

/**
 * Show the picker. Returns a Promise that resolves to the picked user, or
 * resolves to null if dismissed in switchable mode.
 *
 * @param {Object} opts
 * @param {Array}  opts.roster   roster entries from loadRoster()
 * @param {Object} [opts.currentUser]  highlights this user as current
 * @param {boolean}[opts.required=true]  if true, modal cannot be dismissed
 */
export function showUserPicker({ roster, currentUser, required = true }) {
  _ensureStyles();

  // People only — skip group (Operations Team) and placeholder (TBD) entries.
  const people = roster.filter(r => !r.isGroup && !r.isPlaceholder);

  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'qid-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = 'qid-modal';

    const title = document.createElement('h2');
    title.className = 'qid-title';
    title.textContent = currentUser ? 'Switch user' : 'Who are you?';

    const sub = document.createElement('p');
    sub.className = 'qid-sub';
    sub.textContent = currentUser
      ? 'Pick a different name to attribute your activity to.'
      : 'Pick your name. Used for activity attribution — owner DMs in Slack still go to whoever owns the step.';

    const grid = document.createElement('div');
    grid.className = 'qid-grid';

    people.forEach(p => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'qid-card' + (currentUser && currentUser.name === p.name ? ' is-current' : '');
      const av = document.createElement('div');
      av.className = 'qid-avatar';
      av.textContent = _initials(p.name);
      const meta = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'qid-name';
      nm.textContent = p.name;
      meta.appendChild(nm);
      if (p.slackHandle) {
        const handle = document.createElement('div');
        handle.className = 'qid-handle';
        handle.textContent = p.slackHandle;
        meta.appendChild(handle);
      }
      card.appendChild(av);
      card.appendChild(meta);
      card.addEventListener('click', () => {
        setCurrentUser(p);
        cleanup();
        resolve(p);
      });
      grid.appendChild(card);
    });

    modal.appendChild(title);
    modal.appendChild(sub);
    modal.appendChild(grid);

    function cleanup() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
      if (!required && e.key === 'Escape') { cleanup(); resolve(null); }
    }

    if (!required) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'qid-close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', () => { cleanup(); resolve(null); });
      modal.appendChild(close);

      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) { cleanup(); resolve(null); }
      });
    }

    document.addEventListener('keydown', onKey);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
}

/**
 * Convenience: return the current user, prompting (and waiting) if none.
 */
export async function requireUser(roster) {
  const existing = getCurrentUser();
  if (existing) return existing;
  return showUserPicker({ roster, required: true });
}
