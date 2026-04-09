#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.cloudflare.com/client/v4';

function printHelp() {
  console.log(`
Cloudflare API helper for TallyConnect.

Usage:
  node church-av/scripts/cloudflare-api.js <command> [options]

Commands:
  help
  login
  whoami
  list-accounts
  list-zones [zoneName]
  zone-info
  list-records
  ensure-record --type CNAME --name api --content your-app.up.railway.app [--proxied true] [--ttl 1]
  delete-record --id <recordId>

Environment:
  CLOUDFLARE_API_TOKEN   Optional if you use Wrangler login instead
  CLOUDFLARE_ACCOUNT_ID  Optional
  CLOUDFLARE_ZONE_ID     Optional
  CLOUDFLARE_ZONE_NAME   Recommended if CLOUDFLARE_ZONE_ID is not set

Optional flag:
  --env /path/to/cloudflare.env

Examples:
  node church-av/scripts/cloudflare-api.js login
  node church-av/scripts/cloudflare-api.js whoami --env church-av/scripts/cloudflare.env
  node church-av/scripts/cloudflare-api.js list-zones
  node church-av/scripts/cloudflare-api.js ensure-record --type CNAME --name api --content foo.up.railway.app --proxied true
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i++;
  }

  return { positional, flags };
}

function parseEnvFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Env file not found: ${absPath}`);
  }

  const env = {};
  const raw = fs.readFileSync(absPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readConfig(flags) {
  const envFromFile = flags.env ? parseEnvFile(flags.env) : {};
  const read = (key) => process.env[key] || envFromFile[key] || '';
  const explicitToken = read('CLOUDFLARE_API_TOKEN');
  const wranglerAuth = explicitToken ? null : tryResolveWranglerAuth();

  return {
    token: explicitToken || wranglerAuth?.token || '',
    tokenType: explicitToken ? 'api_token' : (wranglerAuth?.type || ''),
    authSource: explicitToken ? 'env' : (wranglerAuth?.source || ''),
    accountId: read('CLOUDFLARE_ACCOUNT_ID'),
    zoneId: read('CLOUDFLARE_ZONE_ID'),
    zoneName: read('CLOUDFLARE_ZONE_NAME'),
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: process.env,
  });

  if (result.error) {
    return {
      ok: false,
      stdout: result.stdout || '',
      stderr: result.stderr || result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function tryResolveWranglerAuth() {
  const attempts = [
    { command: 'wrangler', args: ['auth', 'token', '--json'], source: 'wrangler' },
    { command: 'npx', args: ['--yes', 'wrangler@latest', 'auth', 'token', '--json'], source: 'npx-wrangler' },
  ];

  for (const attempt of attempts) {
    const result = runCommand(attempt.command, attempt.args);
    if (!result.ok) continue;

    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed?.token) {
        return {
          token: parsed.token,
          type: parsed.type || 'oauth',
          source: attempt.source,
        };
      }
    } catch (_) {
      // Ignore parse failures and continue to the next auth source.
    }
  }

  return null;
}

function runWranglerJson(args) {
  const attempts = [
    { command: 'wrangler', args, source: 'wrangler' },
    { command: 'npx', args: ['--yes', 'wrangler@latest', ...args], source: 'npx-wrangler' },
  ];

  for (const attempt of attempts) {
    const result = runCommand(attempt.command, attempt.args);
    if (!result.ok) continue;

    try {
      return {
        source: attempt.source,
        data: JSON.parse(result.stdout),
      };
    } catch (_) {
      // Ignore parse failures and continue to the next auth source.
    }
  }

  return null;
}

function runWranglerLogin() {
  const attempts = [
    { command: 'wrangler', args: ['login'] },
    { command: 'npx', args: ['--yes', 'wrangler@latest', 'login'] },
  ];

  for (const attempt of attempts) {
    const result = runCommand(attempt.command, attempt.args, { stdio: 'inherit' });
    if (result.ok) return;
  }

  throw new Error('Unable to start Wrangler login. Install Wrangler or run `npx wrangler@latest login` manually.');
}

async function apiFetch(config, pathname, options = {}) {
  if (!config.token) {
    throw new Error('Missing Cloudflare auth. Set CLOUDFLARE_API_TOKEN or run `npx wrangler@latest login`.');
  }

  const response = await fetch(`${API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.success === false) {
    const errors = data?.errors?.map((e) => e.message).join('; ') || `${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare API error: ${errors}`);
  }
  return data;
}

async function resolveZone(config, positionalZoneName) {
  if (config.zoneId) return { id: config.zoneId, name: config.zoneName || positionalZoneName || null };

  const zoneName = positionalZoneName || config.zoneName;
  if (!zoneName) {
    throw new Error('Missing zone context. Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME.');
  }

  const qs = new URLSearchParams({ name: zoneName, per_page: '50' });
  if (config.accountId) qs.set('account.id', config.accountId);

  const data = await apiFetch(config, `/zones?${qs.toString()}`);
  if (!Array.isArray(data.result) || data.result.length === 0) {
    throw new Error(`Zone not found: ${zoneName}`);
  }

  const zone = data.result[0];
  return { id: zone.id, name: zone.name };
}

function normalizeRecordName(name, zoneName) {
  if (!name) throw new Error('Missing record name');
  if (name === '@') return zoneName;
  if (name.endsWith(`.${zoneName}`)) return name;
  return `${name}.${zoneName}`;
}

async function cmdWhoAmI(config) {
  if (config.authSource && config.authSource !== 'env') {
    const wranglerWhoAmI = runWranglerJson(['whoami', '--json']);
    if (wranglerWhoAmI) {
      console.log(JSON.stringify({
        authSource: wranglerWhoAmI.source,
        authType: config.tokenType || 'oauth',
        user: wranglerWhoAmI.data,
      }, null, 2));
      return;
    }
  }

  const data = await apiFetch(config, '/user/tokens/verify');
  console.log(JSON.stringify({
    authSource: config.authSource || 'env',
    authType: config.tokenType || 'api_token',
    token: data.result,
  }, null, 2));
}

async function cmdLogin() {
  runWranglerLogin();
}

async function cmdListAccounts(config) {
  const data = await apiFetch(config, '/accounts');
  const accounts = data.result.map((acct) => ({
    id: acct.id,
    name: acct.name,
    type: acct.type,
  }));
  console.log(JSON.stringify(accounts, null, 2));
}

async function cmdListZones(config, positional) {
  const zoneName = positional[1] || config.zoneName || '';
  const qs = new URLSearchParams({ per_page: '50' });
  if (zoneName) qs.set('name', zoneName);
  if (config.accountId) qs.set('account.id', config.accountId);
  const data = await apiFetch(config, `/zones?${qs.toString()}`);
  const zones = data.result.map((zone) => ({
    id: zone.id,
    name: zone.name,
    status: zone.status,
    paused: zone.paused,
    nameServers: zone.name_servers,
  }));
  console.log(JSON.stringify(zones, null, 2));
}

async function cmdZoneInfo(config, positional) {
  const zone = await resolveZone(config, positional[1]);
  const data = await apiFetch(config, `/zones/${zone.id}`);
  const result = data.result;
  console.log(JSON.stringify({
    id: result.id,
    name: result.name,
    status: result.status,
    paused: result.paused,
    type: result.type,
    nameServers: result.name_servers,
  }, null, 2));
}

async function cmdListRecords(config, positional) {
  const zone = await resolveZone(config, positional[1]);
  const data = await apiFetch(config, `/zones/${zone.id}/dns_records?per_page=100`);
  const records = data.result.map((record) => ({
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  }));
  console.log(JSON.stringify(records, null, 2));
}

async function cmdEnsureRecord(config, flags) {
  const zone = await resolveZone(config);
  const type = String(flags.type || '').toUpperCase();
  const name = normalizeRecordName(String(flags.name || ''), zone.name);
  const content = String(flags.content || '');
  const ttl = Number(flags.ttl || 1);
  const proxied = toBool(flags.proxied, true);

  if (!type || !content) {
    throw new Error('ensure-record requires --type, --name, and --content');
  }

  const listQs = new URLSearchParams({ type, name, per_page: '20' });
  const existing = await apiFetch(config, `/zones/${zone.id}/dns_records?${listQs.toString()}`);
  const record = existing.result.find((item) => item.name === name && item.type === type) || null;

  const payload = { type, name, content, ttl, proxied };
  let data;

  if (record) {
    data = await apiFetch(config, `/zones/${zone.id}/dns_records/${record.id}`, {
      method: 'PUT',
      body: payload,
    });
  } else {
    data = await apiFetch(config, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: payload,
    });
  }

  console.log(JSON.stringify({
    action: record ? 'updated' : 'created',
    zone: zone.name,
    record: {
      id: data.result.id,
      type: data.result.type,
      name: data.result.name,
      content: data.result.content,
      proxied: data.result.proxied,
      ttl: data.result.ttl,
    },
  }, null, 2));
}

async function cmdDeleteRecord(config, flags) {
  const zone = await resolveZone(config);
  const id = String(flags.id || '');
  if (!id) throw new Error('delete-record requires --id <recordId>');

  await apiFetch(config, `/zones/${zone.id}/dns_records/${id}`, {
    method: 'DELETE',
  });

  console.log(JSON.stringify({ action: 'deleted', zone: zone.name, recordId: id }, null, 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'help';

  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  const config = readConfig(flags);

  switch (command) {
    case 'login':
      await cmdLogin();
      break;
    case 'whoami':
      await cmdWhoAmI(config);
      break;
    case 'list-accounts':
      await cmdListAccounts(config);
      break;
    case 'list-zones':
      await cmdListZones(config, positional);
      break;
    case 'zone-info':
      await cmdZoneInfo(config, positional);
      break;
    case 'list-records':
      await cmdListRecords(config, positional);
      break;
    case 'ensure-record':
      await cmdEnsureRecord(config, flags);
      break;
    case 'delete-record':
      await cmdDeleteRecord(config, flags);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
