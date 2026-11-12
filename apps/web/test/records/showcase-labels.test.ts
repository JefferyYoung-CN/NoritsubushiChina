/**
 * 展示数据集上的站名消歧断言（端到端：真实展示数据 + 真实标签实现）。
 *
 * 展示数据里刻意放了三组重名车站，分别只能靠城市、运营方、线路集合拆开；
 * 另有一组「2022 年改名之前才同名」的历史站名。`labels.test.ts` 用构造数据覆盖
 * 算法本身，这里保证算法与展示数据接得上：数据被改劣时标签会退回裸站名，测试先红。
 */
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { decodeReducedEnvelope } from '../../../../packages/application/reduced-input.mjs';
import { sha256 } from '../../../../packages/application/validation.mjs';
import { buildStationLabels } from '../../src/records/labels';

/** vitest 以 apps/web 为工作目录运行，仓库根在两级之上。 */
const repositoryRoot = resolve(process.cwd(), '../..');

async function showcaseNetwork(): Promise<TransitNetwork> {
  const text = await readFile(resolve(repositoryRoot, 'demo-showcase/envelopes/reduced-envelope.json'), 'utf8');
  const { network } = await decodeReducedEnvelope(text, await sha256(text));
  return network as TransitNetwork;
}

describe('展示数据的同名车站', () => {
  test('三组重名车站分别按城市、运营方、线路集合拆开', async () => {
    const labels = buildStationLabels(await showcaseNetwork());
    expect(labels.get('show-s32')?.label).toBe('北岸（示例城）');
    expect(labels.get('show-s59')?.label).toBe('北岸（邻江城）');
    expect(labels.get('show-s14')?.label).toBe('北岭（示例轨道交通）');
    expect(labels.get('show-s57')?.label).toBe('北岭（示例城际铁路）');
    expect(labels.get('show-s07')?.label).toBe('松林（一号线）');
    expect(labels.get('show-s36')?.label).toBe('松林（环线）');
    for (const id of ['show-s32', 'show-s59', 'show-s14', 'show-s57', 'show-s07', 'show-s36']) {
      expect(labels.get(id)?.disambiguated).toBe(true);
    }
  });

  test('改名之前的日期会同名，改名之后恢复裸站名', async () => {
    const network = await showcaseNetwork();
    const past = buildStationLabels(network, '2022-03-01');
    expect(past.get('show-s03')?.label).toBe('石桥（一号线）');
    expect(past.get('show-s21')?.label).toBe('石桥（二号线）');
    const now = buildStationLabels(network, '2024-06-01');
    expect(now.get('show-s03')?.label).toBe('石桥');
    expect(now.get('show-s21')?.label).toBe('沙坪');
  });
});
