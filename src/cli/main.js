import { Command } from 'commander';
import process from 'node:process';

import { ACCOUNTBOX_VERSION } from '../core/env.js';
import { openSandboxedBrowser } from '../browser.js';
import { resolveUserToolsTomlPath, readUserToolsConfig } from '../config/userTools.js';
import { findGitRoot } from '../config/git.js';
import { readProjectConfig, resolveAccountOrThrow, setProjectDefault } from '../config/project.js';
import { resolveToolDefinitionWithSources, resolveToolsForCwd } from '../config/tools.js';
import { disambiguateAccountArg, normalizeToolId } from '../util/args.js';
import { sanitizeToolDef, createToolRegistry } from '../tools/registry.js';
import { validateToolDef } from '../tools/validate.js';
import { runNativeTool } from '../tools/runners/native.js';
import { runContainerTool } from '../tools/runners/container.js';
import { createCodexTool, CODEX_HELPER_SUBCOMMANDS } from '../tools/builtins/codex.js';
import { createClaudeTool, CLAUDE_KNOWN_SUBCOMMANDS } from '../tools/builtins/claude.js';
import { getDoctorInfo, printDoctorInfo } from './doctor.js';
import { cmdInstall } from './install.js';

function toolKeyForDefaults(toolId) {
  if (toolId === 'codex') return 'codex_account';
  if (toolId === 'claude') return 'claude_account';
  return `${toolId}_account`;
}

function describeBuiltInTool(tool) {
  const caps = [];
  for (const k of ['run', 'login', 'logout', 'status', 'whoami', 'limits', 'app', 'rebuild', 'list', 'snapshots', 'save', 'switch', 'use']) {
    if (typeof tool[k] === 'function') caps.push(k);
  }
  return { id: tool.id, kind: 'built-in', capabilities: caps };
}

async function dispatchCodex({ codexTool, accountArg, argsList, accountIsSubcommand, projectData, cwd }) {
  const resolved = accountArg
    ? resolveAccountOrThrow(accountArg, 'codex_account', projectData)
    : accountIsSubcommand
      ? (projectData?.codex_account || 'default')
      : resolveAccountOrThrow(undefined, 'codex_account', projectData);

  const cmd = argsList[0];
  if (cmd === 'app') {
    const target = accountIsSubcommand ? (argsList[1] || resolved) : resolved;
    await codexTool.app({ account: target, args: argsList.slice(1), cwd });
    return;
  }
  if (cmd === 'login') {
    await codexTool.login({ account: resolved, args: argsList.slice(1), cwd });
    return;
  }
  if (cmd === 'logout') {
    await codexTool.logout({ account: resolved, cwd });
    return;
  }
  if (cmd === 'status') {
    await codexTool.status({ account: resolved, cwd });
    return;
  }
  if (cmd === 'whoami') {
    await codexTool.whoami({ account: resolved, cwd });
    return;
  }
  if (cmd === 'limits') {
    const allAccounts = Boolean(accountIsSubcommand);
    await codexTool.limits({ account: resolved, args: argsList.slice(1), cwd, allAccounts });
    return;
  }
  if (cmd === 'rebuild') {
    await codexTool.rebuild();
    return;
  }
  if (cmd === 'list') {
    await codexTool.list();
    return;
  }
  if (cmd === 'snapshots') {
    await codexTool.snapshots();
    return;
  }
  if (cmd === 'save') {
    await codexTool.save({ account: resolved, args: argsList, cwd });
    return;
  }
  if (cmd === 'switch') {
    await codexTool.switch({ account: resolved, args: argsList, cwd, defaultAccount: projectData?.codex_account || 'default' });
    return;
  }
  if (cmd === 'use') {
    const toAccount = argsList[1];
    if (!toAccount) throw new Error('Usage: accountbox codex use <account> (writes .accountbox.toml in current repo)');
    const f = await setProjectDefault('codex', toAccount, cwd);
    console.log(`Updated ${f} (codex_account = "${toAccount}")`);
    return;
  }

  await codexTool.run({ account: resolved, args: argsList, cwd });
}

async function dispatchClaude({ claudeTool, accountArg, argsList, accountIsSubcommand, accountLooksLikeOption, projectData, cwd }) {
  const resolved = accountArg
    ? resolveAccountOrThrow(accountArg, 'claude_account', projectData)
    : (accountIsSubcommand || accountLooksLikeOption)
      ? (projectData?.claude_account || 'default')
      : resolveAccountOrThrow(undefined, 'claude_account', projectData);

  await claudeTool.run({ account: resolved, args: argsList, cwd });
}

async function dispatchConfiguredTool({ toolId, accountArg, argsList, cwd }) {
  const proj = await readProjectConfig(cwd);
  const user = await readUserToolsConfig();
  const tools = {
    ...(user.data?.tools || {}),
    ...(proj.data?.tools || {}),
  };
  const def = tools?.[toolId];
  if (!def) {
    const p = await resolveUserToolsTomlPath();
    throw new Error(`Unknown tool '${toolId}'. Define it in ${p} under [tools.${toolId}] (or set ACCOUNTBOX_TOOLS_TOML), or in .accountbox.toml under [tools.${toolId}].`);
  }

  const defaultsKey = toolKeyForDefaults(toolId);
  const resolved = resolveAccountOrThrow(accountArg, defaultsKey, proj.data);

  const mode = def.mode || 'native';
  if (mode === 'native') {
    const command = def.command;
    if (!command) throw new Error(`Tool '${toolId}' is native but missing 'command' in config.`);
    const isolate = def.isolate !== false;
    const extraEnv = def.env || {};
    await runNativeTool({ toolId, account: resolved, command, args: argsList, cwd, isolate, extraEnv });
    return;
  }

  if (mode === 'container') {
    const image = def.image;
    if (!image) throw new Error(`Tool '${toolId}' is container but missing 'image' in config.`);
    const workdir = def.workdir || '/work';
    const configMountPath = def.configMountPath;
    await runContainerTool({ toolId, account: resolved, image, args: argsList, cwd, workdir, configMountPath });
    return;
  }

  throw new Error(`Tool '${toolId}' has unsupported mode '${mode}'. Use 'native' or 'container'.`);
}

export async function main(argv = process.argv) {
  const codexTool = createCodexTool();
  const claudeTool = createClaudeTool();
  const registry = createToolRegistry({ builtins: [codexTool, claudeTool] });

  const program = new Command();
  program
    .name('accountbox')
    .description('Per-account wrappers for Codex + Claude Code, with per-project defaults and extensible tool runners')
    .version(ACCOUNTBOX_VERSION)
    .option('--serious', 'Disable playful installer output')
    .option('--quiet', 'Reduce non-essential output');

  program.enablePositionalOptions();

  const toolsCmd = program
    .command('tools')
    .description('Inspect and validate tool/plugin configuration');

  program
    .command('codex')
    .allowUnknownOption(true)
    .argument('[account]')
    .argument('[args...]')
    .description('Run Codex in a container with per-account isolation (helpers: app/login/logout/status/whoami/limits/rebuild/list/snapshots/save/switch/use)')
    .action(async (account, args) => {
      const cwd = process.cwd();
      const { data } = await readProjectConfig(cwd);

      const { accountArg, argsList, accountIsSubcommand } = disambiguateAccountArg({
        account,
        args,
        knownSubcommands: CODEX_HELPER_SUBCOMMANDS,
      });

      await dispatchCodex({ codexTool, accountArg, argsList, accountIsSubcommand, projectData: data, cwd });
    });

  program
    .command('claude')
    .allowUnknownOption(true)
    .argument('[account]')
    .argument('[args...]')
    .description('Run Claude Code natively with per-account XDG isolation')
    .action(async (account, args) => {
      const cwd = process.cwd();
      const { data } = await readProjectConfig(cwd);

      const { accountArg, argsList, accountIsSubcommand, accountLooksLikeOption } = disambiguateAccountArg({
        account,
        args,
        knownSubcommands: CLAUDE_KNOWN_SUBCOMMANDS,
      });

      await dispatchClaude({ claudeTool, accountArg, argsList, accountIsSubcommand, accountLooksLikeOption, projectData: data, cwd });
    });

  program
    .command('run')
    .allowUnknownOption(true)
    .argument('<tool>')
    .argument('[account]')
    .argument('[args...]')
    .description('Run an arbitrary tool from config (extensible)')
    .action(async (tool, account, args) => {
      const cwd = process.cwd();
      const toolId = normalizeToolId(tool);

      const builtIn = registry.getBuiltIn(toolId);
      if (builtIn?.id === 'codex') {
        const { data } = await readProjectConfig(cwd);
        const { accountArg, argsList, accountIsSubcommand } = disambiguateAccountArg({ account, args, knownSubcommands: CODEX_HELPER_SUBCOMMANDS });
        await dispatchCodex({ codexTool, accountArg, argsList, accountIsSubcommand, projectData: data, cwd });
        return;
      }
      if (builtIn?.id === 'claude') {
        const { data } = await readProjectConfig(cwd);
        const { accountArg, argsList, accountIsSubcommand, accountLooksLikeOption } = disambiguateAccountArg({ account, args, knownSubcommands: CLAUDE_KNOWN_SUBCOMMANDS });
        await dispatchClaude({ claudeTool, accountArg, argsList, accountIsSubcommand, accountLooksLikeOption, projectData: data, cwd });
        return;
      }

      const { accountArg, argsList } = disambiguateAccountArg({ account, args, knownSubcommands: null });
      await dispatchConfiguredTool({ toolId, accountArg, argsList, cwd });
    });

  toolsCmd
    .command('list')
    .description('List available tools (built-ins + configured)')
    .action(async () => {
      const cwd = process.cwd();
      const { mergedTools } = await resolveToolsForCwd(cwd);
      const ids = await registry.listToolIdsForCwd(cwd);
      if (!ids.length) {
        console.log('No tools found.');
        return;
      }
      for (const id of ids) {
        const builtIn = registry.getBuiltIn(id);
        if (builtIn) {
          console.log(`${id}\tbuilt-in`);
          continue;
        }
        const def = mergedTools?.[id] || {};
        console.log(`${id}\t${def.mode || 'native'}`);
      }
    });

  toolsCmd
    .command('show')
    .argument('<toolId>')
    .option('--json', 'Print machine-readable JSON')
    .option('--raw', 'Do not redact env values')
    .description('Show a resolved tool definition')
    .action(async (toolId, opts) => {
      const cwd = process.cwd();
      const id = normalizeToolId(toolId);
      const builtIn = registry.getBuiltIn(id);
      if (builtIn) {
        const desc = describeBuiltInTool(builtIn);
        if (opts.json) {
          console.log(JSON.stringify(desc, null, 2));
          return;
        }
        console.log(`Tool: ${desc.id} (built-in)`);
        console.log(`Capabilities: ${desc.capabilities.join(', ') || 'n/a'}`);
        return;
      }

      const { project, user, mergedTools } = await resolveToolsForCwd(cwd);
      const resolved = resolveToolDefinitionWithSources(id, { project, user });
      if (!resolved.merged) {
        throw new Error(`Unknown tool '${id}'. Define it in ${await resolveUserToolsTomlPath()} under [tools.${id}] or in .accountbox.toml under [tools.${id}].`);
      }
      const def = mergedTools?.[id] || resolved.merged;
      const out = opts.raw ? def : sanitizeToolDef(def);
      const payload = {
        id,
        kind: 'configured',
        merged: out,
        sources: {
          user: resolved.sources.user ? { file: resolved.sources.user.file, def: opts.raw ? resolved.sources.user.def : sanitizeToolDef(resolved.sources.user.def) } : null,
          project: resolved.sources.project ? { file: resolved.sources.project.file, def: opts.raw ? resolved.sources.project.def : sanitizeToolDef(resolved.sources.project.def) } : null,
        },
      };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Tool: ${id} (configured)`);
      if (payload.sources.user?.file) console.log(`User: ${payload.sources.user.file}`);
      if (payload.sources.project?.file) console.log(`Project: ${payload.sources.project.file}`);
      console.log(JSON.stringify(payload.merged, null, 2));
    });

  toolsCmd
    .command('validate')
    .description('Validate tool config schema (built-ins always OK)')
    .action(async () => {
      const cwd = process.cwd();
      const { mergedTools } = await resolveToolsForCwd(cwd);
      const configuredIds = Object.keys(mergedTools || {}).sort((a, b) => a.localeCompare(b));
      if (!configuredIds.length) {
        console.log('No configured tools found.');
        return;
      }
      let ok = true;
      for (const id of configuredIds) {
        const r = validateToolDef(id, mergedTools[id]);
        if (r.errors.length) ok = false;
        for (const e of r.errors) console.error(`${id}: error: ${e}`);
        for (const w of r.warnings) console.error(`${id}: warning: ${w}`);
      }
      if (!ok) process.exitCode = 1;
    });

  program
    .command('resolve')
    .argument('<toolId>')
    .option('--cwd <path>', 'Resolve as if running from this directory')
    .option('--json', 'Print machine-readable JSON')
    .description('Resolve the effective account label for a tool in a directory')
    .action(async (toolId, opts) => {
      const cwd = opts.cwd || process.cwd();
      const id = normalizeToolId(toolId);
      const builtIn = registry.getBuiltIn(id);
      const { project, mergedTools } = await resolveToolsForCwd(cwd);

      if (!builtIn && !mergedTools?.[id]) {
        throw new Error(`Unknown tool '${id}'. (built-ins: ${registry.listBuiltIns().join(', ') || 'none'})`);
      }

      const key = toolKeyForDefaults(id);
      const account = project.data?.[key] || null;
      if (!account) {
        const msg = `No default account configured for '${id}' (${key}). Set it in .accountbox.toml.`;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, toolId: id, cwd, accountKey: key, error: msg, projectConfig: project.file }, null, 2));
          process.exitCode = 1;
          return;
        }
        throw new Error(msg);
      }

      if (opts.json) {
        const gitRoot = await findGitRoot(cwd);
        console.log(JSON.stringify({ ok: true, toolId: id, cwd, gitRoot, projectConfig: project.file, accountKey: key, account }, null, 2));
        return;
      }
      console.log(account);
    });

  program
    .command('set')
    .argument('<tool>', 'codex|claude|<toolId>')
    .argument('<account>')
    .description('Set per-project default account in .accountbox.toml (writes at repo root)')
    .action(async (tool, account) => {
      const f = await setProjectDefault(tool, account, process.cwd());
      console.log(`Updated ${f}`);
    });

  program
    .command('browser')
    .argument('<account>')
    .argument('<url>')
    .description('Open a URL in a sandboxed browser profile for an account (Chrome if available)')
    .action(async (account, url) => {
      await openSandboxedBrowser(account, url);
    });

  program
    .command('doctor')
    .option('--json', 'Print machine-readable JSON')
    .description('Show runtime status and key paths')
    .action(async (opts) => {
      const info = await getDoctorInfo({ cwd: process.cwd() });
      if (opts.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      printDoctorInfo(info);
    });

  program
    .command('install')
    .alias('i')
    .description('Interactive installer for Codex + Claude')
    .action(async () => {
      const opts = program.opts();
      await cmdInstall({ serious: Boolean(opts.serious), quiet: Boolean(opts.quiet), codexTool });
    });

  await program.parseAsync(argv);
}
