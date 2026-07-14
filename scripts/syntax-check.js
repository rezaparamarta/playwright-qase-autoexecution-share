const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

function findJsFiles(dir) {
  const skip = new Set(['node_modules', 'auth', 'downloads', '.git']);
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const files = findJsFiles(root);
let hasError = false;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`OK  ${path.relative(root, file)}`);
  } catch (err) {
    hasError = true;
    console.error(`FAIL  ${path.relative(root, file)}`);
    console.error(err.stderr.toString());
  }
}

process.exit(hasError ? 1 : 0);
