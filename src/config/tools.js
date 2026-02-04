import { readProjectConfig } from './project.js';
import { readUserToolsConfig } from './userTools.js';

export function mergeTools(projectData, userData) {
  // User tools provide defaults; project tools can override.
  return {
    ...(userData?.tools || {}),
    ...(projectData?.tools || {}),
  };
}

export async function resolveToolsForCwd(cwd) {
  const project = await readProjectConfig(cwd);
  const user = await readUserToolsConfig();
  const merged = mergeTools(project.data, user.data);
  return { project, user, mergedTools: merged };
}

export function resolveToolDefinitionWithSources(toolId, { project, user }) {
  const userDef = user?.data?.tools?.[toolId] || null;
  const projectDef = project?.data?.tools?.[toolId] || null;
  const mergedDef = {
    ...(userDef || {}),
    ...(projectDef || {}),
  };

  const hasAny = Object.keys(mergedDef).length > 0;
  return {
    toolId,
    merged: hasAny ? mergedDef : null,
    sources: {
      user: userDef ? { file: user.file, def: userDef } : null,
      project: projectDef ? { file: project.file, def: projectDef } : null,
    },
  };
}

