/**
 * 旧版网站(ui/oldSite.ts):哪一版的世界到哪个旧网站看原样、旧网站怎么回最新版、构建时带的版本号和日期怎么读
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/gen/world';
import { NEWER_NOTE, decodeShare, encodeShare, versionNote } from '../src/gen/savefile';
import { FIRST_OLD_SITE, OLD_NEWER_NOTE, latestUrl, oldSiteFor, oldSiteNote, oldSiteVersion, plainSave, untilText } from '../src/ui/oldSite';

describe('旧版网站', () => {
  it('第几版的世界到哪个旧网站看原样:第 9 版起、比现在旧的才有;旧网站自己不再往下指', () => {
    const page = 'https://atlas.gerdor.top/?seed=7&w=wabc1234567#x';
    expect(oldSiteFor(9, page, null, 10)?.href).toBe('https://atlas.gerdor.top/v9/');
    expect(oldSiteFor(9, page, null, 12)?.href).toBe('https://atlas.gerdor.top/v9/');
    expect(oldSiteFor(11, page, null, 12)?.href).toBe('https://atlas.gerdor.top/v11/');
    // 更早的没留旧网站;就是现在这一版、比现在新、认不出的版本号:没有
    expect(oldSiteFor(FIRST_OLD_SITE - 1, page, null, 10)).toBeNull();
    expect(oldSiteFor(10, page, null, 10)).toBeNull();
    expect(oldSiteFor(11, page, null, 10)).toBeNull();
    expect(oldSiteFor(9.5, page, null, 10)).toBeNull();
    expect(oldSiteFor(Number.NaN, page, null, 10)).toBeNull();
    // 网站放在子目录下也对
    expect(oldSiteFor(9, 'https://example.org/atlas/index.html?seed=1', null, 10)?.href).toBe('https://example.org/atlas/v9/');
    // 这一页就是旧网站:没有更旧的可指
    expect(oldSiteFor(9, 'https://atlas.gerdor.top/v10/', 10, 11)).toBeNull();
  });

  it('旧网站回最新版:上一层目录;最新版自己就是这一页所在的目录', () => {
    expect(latestUrl('https://atlas.gerdor.top/v9/?seed=7#share=abc', 9).href).toBe('https://atlas.gerdor.top/');
    expect(latestUrl('https://atlas.gerdor.top/v9/index.html', 9).href).toBe('https://atlas.gerdor.top/');
    expect(latestUrl('https://atlas.gerdor.top/?seed=7', null).href).toBe('https://atlas.gerdor.top/');
  });

  it('构建时带的版本号、新版上线那天:格式不对就当没给', () => {
    expect(oldSiteVersion('9')).toBe(9);
    expect(oldSiteVersion('12')).toBe(12);
    for (const v of [undefined, '', '0', '09', '9a', 'v9', ' 9', true, 9]) expect(oldSiteVersion(v)).toBeNull();
    expect(untilText('2026-10-11')).toBe('10 月 11 日');
    expect(untilText('2027-01-05')).toBe('1 月 5 日');
    for (const v of [undefined, '', '2026-13-01', '2026-10-00', '10-11', '2026/10/11', 20261011]) expect(untilText(v)).toBe('');
  });

  it('旧网站上"来自更新的版本"不说刷新页面;别的句子、最新版上原样', () => {
    expect(oldSiteNote(NEWER_NOTE, 9)).toBe(OLD_NEWER_NOTE);
    expect(oldSiteNote(NEWER_NOTE, null)).toBe(NEWER_NOTE);
    const old = versionNote(1, false)!;
    expect(oldSiteNote(old, 9)).toBe(old);
  });

  it('只带种子的旧网址当成那一版没改过的存档:分享链接解开还是那一版、那组参数,不核对地形', async () => {
    const params = { ...DEFAULT_PARAMS, seed: 7, plates: 12 };
    const save = plainSave(params, 9);
    expect(save).toMatchObject({ generator: 9, seed: 7, params, check: '', edits: { names: {}, interventions: [], terrain: [] } });
    expect(save.title).toBeUndefined();
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok && r.save).toMatchObject({ generator: 9, seed: 7, params, check: '' });
  });
});
