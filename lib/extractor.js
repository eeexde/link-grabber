import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOOLS = [
  { exe: 'C:\\Program Files\\WinRAR\\UnRAR.exe', args: (archive, out) => ['x', '-o+', '-y', archive, out + path.sep] },
  { exe: 'C:\\Program Files\\7-Zip\\7z.exe', args: (archive, out) => ['x', '-y', `-o${out}`, archive] },
  { exe: 'C:\\Program Files (x86)\\7-Zip\\7z.exe', args: (archive, out) => ['x', '-y', `-o${out}`, archive] },
];

export function findExtractor() {
  return TOOLS.find((t) => fs.existsSync(t.exe));
}

/**
 * Decide which files in the folder are archive ENTRY POINTS, and what output
 * folder each should extract into.
 *
 * Input:  array of filenames in the download folder, e.g.
 *   ['Game.part01.rar', 'Game.part02.rar', 'Setup.zip', 'notes.txt']
 * Output: array of { file, outDir } e.g.
 *   [{ file: 'Game.part01.rar', outDir: 'Game' }, { file: 'Setup.zip', outDir: 'Setup' }]
 *
 * Multi-part sets must yield ONE entry (the first part) — extracting every
 * part individually fails or re-extracts the same data N times.
 */
export function pickArchiveEntries(files) {
  const clean = (base) => base.replace(/[\s_.-]+$/, '') || base;
  const entries = [];
  for (const file of files) {
    let m;
    if ((m = file.match(/^(.*)\.part0*1\.rar$/i))) entries.push({ file, outDir: clean(m[1]) }); // first of multi-part
    else if (/\.part\d+\.rar$/i.test(file)) continue;                                           // later parts
    else if ((m = file.match(/^(.*)\.(7z|zip)\.0*1$/i))) entries.push({ file, outDir: clean(m[1]) }); // .7z.001
    else if ((m = file.match(/^(.*)\.(rar|zip|7z)$/i))) entries.push({ file, outDir: clean(m[1]) }); // single (also .rar+.r00 sets)
  }
  return entries;
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err.trim().slice(0, 300)}`))));
    p.on('error', reject);
  });
}

export async function extractAll(folder, emit) {
  const tool = findExtractor();
  if (!tool) throw new Error('No extractor found (install WinRAR or 7-Zip)');
  const entries = pickArchiveEntries(fs.readdirSync(folder));
  if (!entries.length) emit({ type: 'extract', status: 'none', message: 'No archives found' });
  for (const { file, outDir } of entries) {
    const out = path.join(folder, outDir);
    fs.mkdirSync(out, { recursive: true });
    emit({ type: 'extract', status: 'running', file, outDir });
    try {
      await run(tool.exe, tool.args(path.join(folder, file), out));
      emit({ type: 'extract', status: 'done', file, outDir });
    } catch (e) {
      emit({ type: 'extract', status: 'error', file, message: e.message });
    }
  }
}
