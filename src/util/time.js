export function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

