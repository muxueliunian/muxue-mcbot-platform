// 地点记忆：家、矿井入口、岔路、地标、可靠通道、危险点。只记点，不做三维数据库；
// 查询时只返回附近或相关的几条，并标明记录时间（旧记录不等于现在的事实）
import type { Bot } from 'mineflayer';
import { JsonFile } from './json-file.js';
import { normalizeDimension, type Point3 } from './regions.js';

export const PLACE_KINDS = ['home', 'mine', 'junction', 'landmark', 'path', 'danger', 'other'] as const;
export type PlaceKind = typeof PLACE_KINDS[number];

export interface Place {
  name: string;
  kind: PlaceKind;
  worldId: string;
  dimension: string;
  pos: Point3;
  note: string;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

interface PlaceFile {
  version: 1;
  places: Place[];
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

export class PlaceStore {
  private readonly data: JsonFile<PlaceFile>;

  constructor(readonly file: string | null, readonly worldId: string, readonly owner: string) {
    this.data = new JsonFile<PlaceFile>(
      file,
      () => ({ version: 1, places: [] }),
      (d): d is PlaceFile => Boolean(d && (d as PlaceFile).version === 1 && Array.isArray((d as PlaceFile).places))
    );
  }

  get configured(): boolean {
    return Boolean(this.file && this.worldId);
  }

  list(dimension?: string): Place[] {
    if (!this.configured) return [];
    const dim = dimension && normalizeDimension(dimension);
    return this.data.read().places.filter((p) => p.worldId === this.worldId && p.active && (!dim || p.dimension === dim));
  }

  upsert(input: { name: string; kind: PlaceKind; dimension: string; pos: Point3; note?: string; source: string }): Place {
    if (!this.configured) throw new Error('没有配置 --world-id，不能记地点');
    if (!NAME_RE.test(input.name)) throw new Error('地点名只能用文字、数字、下划线和连字符，最长 40 个字');
    if (!input.source.trim()) throw new Error('请写明来源');
    return this.data.update((data) => {
      const now = new Date().toISOString();
      const existing = data.places.find((p) => p.worldId === this.worldId && p.name === input.name);
      const place: Place = {
        name: input.name,
        kind: input.kind,
        worldId: this.worldId,
        dimension: normalizeDimension(input.dimension),
        pos: { x: Math.floor(input.pos.x), y: Math.floor(input.pos.y), z: Math.floor(input.pos.z) },
        note: input.note ?? '',
        source: input.source,
        createdBy: existing?.createdBy ?? this.owner,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        active: true
      };
      if (existing) Object.assign(existing, place);
      else data.places.push(place);
      return place;
    });
  }

  forget(name: string, source: string): Place {
    return this.data.update((data) => {
      const p = data.places.find((x) => x.worldId === this.worldId && x.name === name && x.active);
      if (!p) throw new Error(`没有记着地点 ${name}`);
      p.active = false;
      p.updatedAt = new Date().toISOString();
      p.source = `${p.source}；忘掉：${source}`;
      return p;
    });
  }
}

let places = new PlaceStore(null, '', '');

export function configurePlaces(store: PlaceStore): void {
  places = store;
}

export function placeStore(): PlaceStore {
  return places;
}

export function nearbyPlaces(bot: Bot, radius: number, kind?: PlaceKind): { place: Place; distance: number }[] {
  const me = bot.entity.position;
  return places.list(bot.game.dimension)
    .filter((p) => !kind || p.kind === kind)
    .map((p) => ({ place: p, distance: Math.hypot(p.pos.x + 0.5 - me.x, p.pos.z + 0.5 - me.z) }))
    .filter((x) => x.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

export function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间不明';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} 天前记录`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} 小时前记录`;
  return '刚记录';
}
