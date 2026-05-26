#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const version = process.env.CFST_VERSION || 'v2.3.5';
const asset = selectAsset();
const downloadUrl = `https://github.com/XIU2/CloudflareSpeedTest/releases/download/${version}/${asset}`;
const vendorDir = path.join(projectRoot, 'vendor', 'cfst');
const downloadDir = path.join(vendorDir, 'downloads');
const extractDir = path.join(vendorDir, 'current');
const archivePath = path.join(downloadDir, asset);

fs.mkdirSync(downloadDir, { recursive: true });
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });

console.log(`Downloading ${downloadUrl}`);
const response = await fetch(downloadUrl);
if (!response.ok) {
  throw new Error(`Download failed: HTTP ${response.status}`);
}
fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

if (asset.endsWith('.tar.gz')) {
  run('tar', ['-xzf', archivePath, '-C', extractDir]);
} else if (asset.endsWith('.zip')) {
  extractZip(archivePath, extractDir);
} else {
  throw new Error(`Unsupported archive: ${asset}`);
}

const binaryName = process.platform === 'win32' ? 'cfst.exe' : 'cfst';
const binaryPath = findFile(extractDir, binaryName);
if (!binaryPath) {
  throw new Error(`Cannot find ${binaryName} in ${asset}`);
}
if (binaryPath !== path.join(extractDir, binaryName)) {
  fs.renameSync(binaryPath, path.join(extractDir, binaryName));
}
if (process.platform !== 'win32') fs.chmodSync(path.join(extractDir, binaryName), 0o755);

fs.writeFileSync(path.join(extractDir, 'manifest.json'), JSON.stringify({ version, asset, downloadUrl }, null, 2));
run(path.join(extractDir, binaryName), ['-h'], { allowFailure: true });
console.log(`CloudflareSpeedTest installed to ${path.join(extractDir, binaryName)}`);

function selectAsset() {
  const platform = process.env.CFST_PLATFORM || process.platform;
  const arch = process.env.CFST_ARCH || process.arch;
  const armVariant = process.env.CFST_ARM_VARIANT || 'armv7';

  if (platform === 'linux') {
    if (arch === 'x64') return 'cfst_linux_amd64.tar.gz';
    if (arch === 'ia32') return 'cfst_linux_386.tar.gz';
    if (arch === 'arm64') return 'cfst_linux_arm64.tar.gz';
    if (arch === 'arm') return `cfst_linux_${armVariant}.tar.gz`;
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'cfst_darwin_amd64.zip';
    if (arch === 'arm64') return 'cfst_darwin_arm64.zip';
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'cfst_windows_amd64.zip';
    if (arch === 'ia32') return 'cfst_windows_386.zip';
    if (arch === 'arm64') return 'cfst_windows_arm64.zip';
  }
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function extractZip(archive, destination) {
  if (process.platform === 'win32') {
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${escapePowerShellPath(archive)}' -DestinationPath '${escapePowerShellPath(destination)}' -Force`
    ]);
    return;
  }
  run('unzip', ['-o', archive, '-d', destination]);
}

function escapePowerShellPath(value) {
  return String(value).replace(/'/g, "''");
}

function findFile(dir, fileName) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      const nested = findFile(itemPath, fileName);
      if (nested) return nested;
    } else if (item.name === fileName || item.name.toLowerCase() === fileName.toLowerCase()) {
      return itemPath;
    }
  }
  return null;
}
