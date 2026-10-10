import fs from 'node:fs';
import type { Posture } from './companion-mode.js';

/**
 * Hosted only: the standing posture for the driver, which reads it after reconnecting (scripts/companion.mjs). A new
 * posture replaces the file whole (written beside it, then renamed); an explicit end removes it.
 */
export function writePosture(file: string, now = Date.now): (posture: Posture | null) => void {
  return (posture) => {
    if (!posture) { fs.rmSync(file, { force: true }); return; }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...posture, at: now() }) + '\n');
    fs.renameSync(temporary, file);
  };
}
