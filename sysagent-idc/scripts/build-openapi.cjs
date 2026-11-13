'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function directoryWithoutLinks(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe output directory: ${current}`);
  }
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected regular file, not a symlink: ${file}`);
}

async function buildOpenApi() {
  directoryWithoutLinks(ROOT);
  const service = path.join(ROOT, 'openapi-service.ts');
  const contract = path.join(ROOT, 'openapi-contract.json');
  for (const file of [service, contract]) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${path.basename(file)}; finish the OpenAPI service/contract before building`);
    regularFile(file);
  }
  const electron = path.join(ROOT, 'electron');
  directoryWithoutLinks(electron); // Check the parent before creating generated/.
  const generated = path.join(electron, 'generated');
  if (!fs.existsSync(generated)) fs.mkdirSync(generated, { mode: 0o755 });
  directoryWithoutLinks(generated);
  const outfile = path.join(generated, 'openapi.cjs');
  try { regularFile(outfile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // JSON is embedded as JS, not copied as a runtime filesystem dependency.
  const result = await require('esbuild').build({
    absWorkingDir: ROOT,
    entryPoints: [service],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    loader: { '.json': 'json' },
    metafile: true,
    write: false,
    sourcemap: false,
    logLevel: 'silent',
  });
  if (!Object.keys(result.metafile.inputs).some(input => path.resolve(ROOT, input) === contract)) {
    throw new Error('openapi-service.ts must import openapi-contract.json so the contract is bundled into JS');
  }
  if (result.outputFiles.length !== 1 || result.outputFiles[0].path !== outfile) {
    throw new Error('Expected one self-contained OpenAPI CommonJS output');
  }
  directoryWithoutLinks(generated);
  const temporary = path.join(generated, `.openapi-${crypto.randomUUID()}.cjs`);
  try {
    fs.writeFileSync(temporary, result.outputFiles[0].contents, { flag: 'wx', mode: 0o644 });
    // lstat also catches a dangling symlink; never overwrite one.
    try { regularFile(outfile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directoryWithoutLinks(generated);
    fs.renameSync(temporary, outfile);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  process.stdout.write('Built electron/generated/openapi.cjs (Node 20 CommonJS, contract embedded)\n');
}

module.exports = { buildOpenApi };
if (require.main === module) {
  buildOpenApi().catch(error => {
    process.stderr.write(`build:openapi: ${error.message}\n`);
    process.exitCode = 1;
  });
}
