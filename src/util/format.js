export function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at === -1) return email.length <= 2 ? `${email[0]}…` : `${email[0]}…${email[email.length - 1]}`;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMasked = local.length <= 2 ? `${local[0]}…` : `${local[0]}…${local[local.length - 1]}`;
  return `${localMasked}@${domain}`;
}

export function maskId(id, keep = 8) {
  if (typeof id !== 'string') return null;
  const n = Math.max(4, keep);
  return id.length <= n ? id : `${id.slice(0, n)}…`;
}

export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  try {
    const json = Buffer.from(raw + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function formatDurationShort(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'n/a';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function formatRateLimit(rl) {
  if (!rl) return 'n/a';
  if (rl.allowed === false) return 'blocked';

  const parts = [];
  if (rl.primary_window) {
    const w = rl.primary_window;
    parts.push(`${w.used_percent}%/${formatDurationShort(w.reset_after_seconds ?? w.limit_window_seconds)}`);
  }
  if (rl.secondary_window) {
    const w = rl.secondary_window;
    parts.push(`${w.used_percent}%/${formatDurationShort(w.reset_after_seconds ?? w.limit_window_seconds)}`);
  }
  let out = parts.join(' + ') || 'n/a';
  if (rl.limit_reached) out += ' (LIMIT)';
  return out;
}

export function formatCredits(c) {
  if (!c) return 'n/a';
  if (c.unlimited) return 'unlimited';
  if (!c.has_credits) return 'none';
  if (typeof c.balance === 'number') return String(c.balance);
  return 'has';
}

export function sanitizeWhamUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = { ...u };
  if ('email' in out) out.email = maskEmail(out.email);
  if ('user_id' in out) out.user_id = maskId(out.user_id, 10);
  if ('account_id' in out) out.account_id = maskId(out.account_id, 8);
  return out;
}

