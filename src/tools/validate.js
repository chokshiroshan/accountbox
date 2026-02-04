export function validateToolDef(toolId, def) {
  const errors = [];
  const warnings = [];

  if (!def || typeof def !== 'object') {
    errors.push('tool definition must be an object');
    return { toolId, errors, warnings };
  }

  const mode = def.mode || 'native';
  if (!['native', 'container'].includes(mode)) {
    errors.push(`unsupported mode '${mode}' (use 'native' or 'container')`);
  }

  if (mode === 'native') {
    if (!def.command || typeof def.command !== 'string') {
      errors.push("mode=native requires 'command' (string)");
    }
    if ('isolate' in def && typeof def.isolate !== 'boolean') {
      errors.push("'isolate' must be boolean when provided");
    }
  }

  if (mode === 'container') {
    if (!def.image || typeof def.image !== 'string') {
      errors.push("mode=container requires 'image' (string)");
    }
    if ('workdir' in def && typeof def.workdir !== 'string') {
      errors.push("'workdir' must be string when provided");
    }
    if ('configMountPath' in def && typeof def.configMountPath !== 'string') {
      errors.push("'configMountPath' must be string when provided");
    }
  }

  if ('env' in def) {
    if (!def.env || typeof def.env !== 'object' || Array.isArray(def.env)) {
      errors.push("'env' must be an object when provided");
    } else {
      for (const [k, v] of Object.entries(def.env)) {
        if (typeof v !== 'string') warnings.push(`env.${k} is not a string; it will be stringified by the shell environment`);
      }
    }
  }

  return { toolId, errors, warnings };
}

