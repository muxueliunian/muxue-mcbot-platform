import fs from 'node:fs';
import path from 'node:path';
import { BodyError, type Position } from './body.js';

/** A named spot the player asked to remember (home, the mine entrance), per world. */
export interface Place { name: string; dimension: string; position: Position; note?: string; savedAt: number }
/** Names that mean "home" for the bedtime nudge. */
export const HOME_NAMES = ['home', '家'];
export const placeName = (name: string) => name.trim().toLowerCase();

/**
 * Places live in a small JSON file per world under the runtime directory, so every Agent (Claude Code, Codex,
 * dsh) driving this body sees the same list; without a directory they only last for this process.
 */
export class PlaceBook {
  private places = new Map<string, Place>();
  private readonly file?: string;
  constructor(runtimeDir?: string, worldId?: string) {
    if (!runtimeDir || !worldId) return;
    this.file = path.join(runtimeDir, 'places', `${worldId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Place[];
      for (const place of saved) if (place?.name && place.position) this.places.set(placeName(place.name), place);
    } catch {}
  }
  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.places.values()], null, 2));
    fs.renameSync(temporary, this.file);
  }
  list(): Place[] { return [...this.places.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(name: string): Place | undefined { return this.places.get(placeName(name)); }
  home(): Place | undefined { for (const name of HOME_NAMES) { const place = this.get(name); if (place) return place; } return undefined; }
  set(place: Omit<Place, 'savedAt'>): Place {
    if (!/^[^\u0000-\u001f]{1,32}$/.test(place.name.trim())) throw new BodyError('INVALID_ARGUMENT', '地点名要 1～32 个字');
    if (!this.places.has(placeName(place.name)) && this.places.size >= 64) throw new BodyError('LIMIT', '最多记 64 个地点，先删掉不用的');
    const saved = { ...place, name: place.name.trim(), position: { x: Math.round(place.position.x * 10) / 10, y: Math.round(place.position.y * 10) / 10, z: Math.round(place.position.z * 10) / 10 }, savedAt: Date.now() };
    this.places.set(placeName(place.name), saved); this.save(); return saved;
  }
  remove(name: string): boolean { const removed = this.places.delete(placeName(name)); if (removed) this.save(); return removed; }
}
