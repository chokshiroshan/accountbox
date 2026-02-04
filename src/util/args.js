export function looksLikeOption(token) {
  return typeof token === 'string' && token.startsWith('-');
}

export function hasAny(args, tokens) {
  return tokens.some(t => args.includes(t));
}

export function readOptionValue(args, longName, fallback = null) {
  const eqPrefix = `${longName}=`;
  const direct = args.find(a => typeof a === 'string' && a.startsWith(eqPrefix));
  if (direct) return direct.slice(eqPrefix.length);
  const idx = args.indexOf(longName);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

export function readOptionNumber(args, longName, fallback) {
  const raw = readOptionValue(args, longName, null);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function disambiguateAccountArg({ account, args, knownSubcommands }) {
  let accountArg = account;
  let argsList = args || [];
  const accountIsSubcommand = Boolean(accountArg && knownSubcommands?.has(accountArg));
  const accountLooksLikeOption = looksLikeOption(accountArg);

  if (accountIsSubcommand || accountLooksLikeOption) {
    argsList = [accountArg, ...argsList];
    accountArg = undefined;
  }

  return { accountArg, argsList, accountIsSubcommand, accountLooksLikeOption };
}

export function normalizeToolId(s) {
  return String(s || '').trim();
}

