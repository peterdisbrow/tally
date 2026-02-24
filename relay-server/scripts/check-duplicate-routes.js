#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROUTE_REGEX = /app\.(get|post|put|delete|patch|options|head)\(\s*(['"`])([^'"`]+)\2/g;

function indexToLine(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function checkFile(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const src = fs.readFileSync(fullPath, 'utf8');
  const matches = [];
  let match;
  while ((match = ROUTE_REGEX.exec(src))) {
    const method = match[1].toUpperCase();
    const route = match[3];
    const line = indexToLine(src, match.index);
    matches.push({ method, route, line, fullPath });
  }
  return matches;
}

function main() {
  const files = process.argv.slice(2);
  const targets = files.length ? files : ['server.js'];
  const allMatches = targets.flatMap((target) => checkFile(target));
  const byRoute = new Map();
  for (const entry of allMatches) {
    const key = `${entry.method} ${entry.route}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(entry);
  }

  const duplicates = [...byRoute.entries()].filter(([, entries]) => entries.length > 1);
  if (!duplicates.length) {
    console.log(`OK ${targets.length} file(s): no duplicate app.<method>(route) declarations`);
    process.exit(0);
  }

  console.error(`DUPLICATES found across ${targets.length} file(s):`);
  for (const [key, entries] of duplicates.sort((a, b) => a[0].localeCompare(b[0]))) {
    const locs = entries
      .map((entry) => `${path.relative(process.cwd(), entry.fullPath)}:${entry.line}`)
      .join(', ');
    console.error(`  ${key} -> ${locs}`);
  }
  process.exit(1);
}

main();
