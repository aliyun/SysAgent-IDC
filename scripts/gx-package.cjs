'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.6.5-2';
const FILENAME = `gx_${VERSION}_amd64.deb`;
const SHA256 = 'a471bf61863c61744b102ba19a8620feea68d9aeaab8591c9d056f3cbe5b1902';

function verifyGxPackage(directory) {
  for (const name of ['', 'manifest.json', FILENAME]) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (stat.isSymbolicLink() || (name ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      throw new Error('Unsafe GX package input');
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== '1.0' || manifest.platform !== 'linux' || manifest.arch !== 'x64' ||
      manifest.package !== 'gx' || manifest.version !== VERSION || manifest.filename !== FILENAME ||
      manifest.sha256 !== SHA256) throw new Error('Invalid GX 0.6.5-2 manifest');
  const binary = path.join(directory, FILENAME);
  const data = fs.readFileSync(binary);
  if (!data.subarray(0, 8).equals(Buffer.from('!<arch>\n')) ||
      crypto.createHash('sha256').update(data).digest('hex') !== SHA256) {
    throw new Error('GX 0.6.5-2 package checksum mismatch');
  }
  return { binary, manifest };
}

module.exports = { verifyGxPackage };
