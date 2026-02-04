export function isErrno(e, code) {
  return Boolean(e && typeof e === 'object' && 'code' in e && e.code === code);
}

