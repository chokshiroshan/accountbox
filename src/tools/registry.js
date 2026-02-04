import { resolveToolsForCwd, resolveToolDefinitionWithSources } from '../config/tools.js';

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return env;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) { out[k] = v; continue; }
    const s = String(v);
    // Redact values by default; callers can opt into printing raw via their own flags.
    out[k] = s ? '***' : '';
  }
  return out;
}

export function sanitizeToolDef(def) {
  if (!def || typeof def !== 'object') return def;
  const out = { ...def };
  if ('env' in out) out.env = sanitizeEnv(out.env);
  return out;
}

export function createToolRegistry({ builtins = [] } = {}) {
  const builtInMap = new Map(builtins.map(t => [t.id, t]));

  return {
    getBuiltIn(toolId) {
      return builtInMap.get(toolId) || null;
    },

    listBuiltIns() {
      return [...builtInMap.keys()].sort((a, b) => a.localeCompare(b));
    },

    async listToolIdsForCwd(cwd) {
      const { mergedTools } = await resolveToolsForCwd(cwd);
      const configured = Object.keys(mergedTools || {});
      const all = new Set([...configured, ...builtInMap.keys()]);
      return [...all].sort((a, b) => a.localeCompare(b));
    },

    async resolveConfiguredTool(toolId, cwd) {
      const { project, user, mergedTools } = await resolveToolsForCwd(cwd);
      const def = mergedTools?.[toolId] || null;
      const withSources = resolveToolDefinitionWithSources(toolId, { project, user });
      return { project, user, def, withSources };
    },
  };
}

