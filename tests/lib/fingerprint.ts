/**
 * 测试用的指纹(和 scripts/fingerprint.ts 同一套算法,数值可直接对比 docs/baseline-fingerprint.json):
 * 类型化数组逐字节,数按 64 位原样(0.1 + 0.2 和 0.30000000000000004 不是一个指纹),对象按键名排序,
 * Map / Set 按遍历顺序。取 SHA-1 前 16 位十六进制。
 *
 * 用法:确定性回归里对同一份输入跑两遍,逐字段比 hash —— 失败信息里是"哪几个字段变了",而不是一个巨大的对象 diff。
 */
import { createHash } from 'node:crypto';

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

/** 一个值的指纹:同样的值(逐字节)永远是同一个字符串 */
export function hashOf(v: unknown): string {
  const h = createHash('sha1');
  const feed = (x: unknown): void => {
    if (x === null || x === undefined) return void h.update(`~${x}`);
    if (ArrayBuffer.isView(x)) {
      h.update(`<${x.constructor.name}:${x.byteLength}>`);
      return void h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    }
    if (Array.isArray(x)) {
      h.update(`[${x.length}`);
      x.forEach(feed);
      return void h.update(']');
    }
    if (x instanceof Map) {
      h.update(`{map${x.size}`);
      for (const [k, val] of x) {
        feed(k);
        feed(val);
      }
      return void h.update('}');
    }
    if (x instanceof Set) {
      h.update(`{set${x.size}`);
      for (const val of x) feed(val);
      return void h.update('}');
    }
    if (typeof x === 'object') {
      for (const k of Object.keys(x as object).sort()) {
        h.update(`.${k}`);
        feed((x as Record<string, unknown>)[k]);
      }
      return;
    }
    if (typeof x === 'number') {
      f64[0] = x;
      h.update('n');
      return void h.update(f64b);
    }
    h.update(`${typeof x}:${String(x)}`);
  };
  feed(v);
  return h.digest('hex').slice(0, 16);
}

/** 一个对象的每个字段各算一个指纹,名字前缀统一(`world.` / `civ.` …);键名排序 */
export function fieldsOf(prefix: string, obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[`${prefix}${k}`] = hashOf((obj as Record<string, unknown>)[k]);
  return out;
}

/** 两份"字段 → 指纹"里不一致的字段名(有序;空数组 = 完全一致) */
export function changedFields(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
