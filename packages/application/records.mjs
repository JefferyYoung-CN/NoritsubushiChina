import { array, day, fields, independent, requireValue, text, unique } from './validation.mjs';
import { isDateView } from './date-view.mjs';

export function decodeRecord(value, path = 'record', layer = null) {
  const advanced = layer === 'advanced';
  fields(value, ['id', 'occurredOn', 'networkSnapshotId', 'fromStationId', 'toStationId', 'serviceLineIds', 'sectionIds', 'note', 'vehicle'], ['physicalLineId', 'vehicleDetails'], path);
  const record = { id: text(value.id, `${path}.id`), occurredOn: day(value.occurredOn, `${path}.occurredOn`, '1997-01-01'),
    networkSnapshotId: text(value.networkSnapshotId, `${path}.networkSnapshotId`),
    fromStationId: text(value.fromStationId, `${path}.fromStationId`), toStationId: text(value.toStationId, `${path}.toStationId`),
    serviceLineIds: array(value.serviceLineIds, `${path}.serviceLineIds`, 100).map(id => text(id, `${path}.serviceLineIds`)),
    sectionIds: array(value.sectionIds, `${path}.sectionIds`, 10000).map(id => text(id, `${path}.sectionIds`)),
    note: text(value.note, `${path}.note`, 2000, true), vehicle: text(value.vehicle, `${path}.vehicle`, 500, true) };
  if ('physicalLineId' in value) record.physicalLineId = text(value.physicalLineId, `${path}.physicalLineId`);
  if ('vehicleDetails' in value) {
    fields(value.vehicleDetails, ['model', 'number', 'formation'], [], `${path}.vehicleDetails`);
    record.vehicleDetails = Object.fromEntries(['model', 'number', 'formation'].map(key =>
      [key, text(value.vehicleDetails[key], `${path}.vehicleDetails.${key}`, 100, true)]));
  }
  // 记录层只判结构、不判拓扑：进阶记录允许同站起终点（整圈）与重复区间（续圈），
  // 实际走法由日期视图按已存有序区间重放核验；基础记录是物理线路，单条记录内区间仍须唯一
  // （基础记录之间的重叠由保存时的扣除拆分避免，读取时容忍）。
  requireValue((record.fromStationId !== record.toStationId || record.physicalLineId || advanced) &&
    record.sectionIds.length > 0 &&
    (record.physicalLineId ? record.serviceLineIds.length === 0 : record.serviceLineIds.length > 0),
    'E_FORMAT', path, 'Record requires a complete physical path or distinct service endpoints');
  if (!advanced) unique(record.sectionIds, id => id, `${path}.sectionIds`);
  return independent(record);
}

export function decodeFacts(value) {
  fields(value, ['basic', 'advanced'], [], 'facts');
  const facts = Object.fromEntries(['basic', 'advanced'].map(layer => [layer,
    array(value[layer], `facts.${layer}`, 10000).map((row, index) => decodeRecord(row, `facts.${layer}[${index}]`, layer))]));
  requireValue(facts.advanced.every(row => !row.physicalLineId), 'E_FORMAT', 'facts.advanced', 'Advanced records require service paths');
  unique([...facts.basic, ...facts.advanced], row => row.id, 'facts.id');
  // 基础记录之间不再要求物理区间唯一：保存由 add 按未记录部分拆分保证（决策 #42），
  // 读取与备份导入则容忍历史数据或手工文件里的跨记录重叠，统计仍按区间去重。
  return independent(facts);
}

/**
 * 把一次基础录入按「本档案已有基础记录覆盖的区间」折算成未记录的连续段（决策 #42）。
 * 只读 basicRecords 的 sectionIds，忽略其余字段与来源：读取容忍的跨记录重叠在这里收敛为
 * 保存不再产生重叠。沿 view.normalSections 从 view.fromStationId 走站链，取未覆盖段的最大连续
 * 切片；切片两端站即新记录的起终点，整圈等首尾同站由调用方按物理线路规则判断。
 * 站链不自洽（相邻区间没有公共端点或原地折返）说明视图不可用，按 E_PATH 拒绝。
 */
export function planBasicSplit(view, basicRecords) {
  requireValue(view && typeof view === 'object' && typeof view.fromStationId === 'string' &&
    Array.isArray(view.normalSections), 'E_PATH', 'view', 'A station chain view is required');
  array(basicRecords, 'basicRecords', 10000);
  const covered = new Set();
  for (const record of basicRecords) {
    for (const sectionId of record?.sectionIds ?? []) covered.add(sectionId);
  }
  const stations = [view.fromStationId];
  for (const [index, section] of view.normalSections.entries()) {
    const cursor = stations[index];
    const next = section?.fromStationId === cursor ? section?.toStationId
      : section?.toStationId === cursor ? section?.fromStationId : null;
    requireValue(typeof next === 'string' && next !== cursor, 'E_PATH', `view.normalSections[${index}]`,
      'Sections must form one continuous station chain');
    stations.push(next);
  }
  const runs = [];
  for (let start = 0; start < view.normalSections.length;) {
    if (covered.has(view.normalSections[start].id)) { start += 1; continue; }
    let end = start;
    while (end + 1 < view.normalSections.length && !covered.has(view.normalSections[end + 1].id)) end += 1;
    runs.push({ fromStationId: stations[start], toStationId: stations[end + 1],
      sectionIds: view.normalSections.slice(start, end + 1).map(row => row.id) });
    start = end + 1;
  }
  const total = view.normalSections.length;
  return independent({ total, covered: total - runs.reduce((sum, run) => sum + run.sectionIds.length, 0), runs });
}

export function createRecordApplication(port) {
  return Object.freeze({
    read: () => port.read(),
    async add(view, command) {
      fields(command, ['id', 'layer'], ['note', 'vehicle'], 'command');
      requireValue(['basic', 'advanced'].includes(command.layer), 'E_FORMAT', 'command.layer', 'Unknown record layer');
      requireValue(isDateView(view) && !view.empty && view.routeAvailable &&
        (!view.physicalLineId || command.layer === 'basic') &&
        [view.fromStationId, view.toStationId].every(id => view.stations.some(row => row.id === id && row.passengerAvailable)),
      'E_PATH', 'view', 'Record requires a validated available passenger route');
      const state = port.read();
      // 只有基础层做扣除（决策 #42）；进阶记录可以重复覆盖同一区间，用空已记录集把整段合成一条。
      const split = planBasicSplit(view, command.layer === 'basic' ? state.facts.basic : []);
      const serviceLineIds = view.physicalLineId ? [] : [view.serviceLineId];
      const records = split.runs.map((run, index) => {
        const id = index === 0 ? command.id : `${command.id}-${index + 1}`;
        return decodeRecord({ id, occurredOn: view.onDate, networkSnapshotId: view.snapshotId,
          fromStationId: run.fromStationId, toStationId: run.toStationId, serviceLineIds: [...serviceLineIds],
          ...(view.physicalLineId ? { physicalLineId: view.physicalLineId } : {}),
          sectionIds: [...run.sectionIds], note: command.note ?? '',
          vehicle: command.vehicle ?? '' }, 'record', command.layer);
      });
      const plan = independent({ total: split.total, covered: split.covered,
        runs: split.runs.map((run, index) => ({ id: records[index].id, ...run })) });
      // 全部连续段一次原子提交；完全覆盖时不写库，revision 与事实保持不变。
      if (records.length === 0) return { state: port.read(), plan };
      return { state: await port.replace(state.revision, { ...state.facts,
        [command.layer]: [...state.facts[command.layer], ...records] }), plan };
    },
    async addAdvanced(input) {
      // 链式进阶记录已由会话层组装（读取可用径路、注入 id 与快照）；此处只做事实校验，
      // 绝不接受调用方自报 layer，也不接受 lengthMetres 等视图字段进入事实层。
      const record = decodeRecord(input, 'record', 'advanced');
      requireValue(!record.physicalLineId, 'E_FORMAT', 'record', 'Advanced records require service paths');
      const state = port.read();
      requireValue(![...state.facts.basic, ...state.facts.advanced].some(row => row.id === record.id),
        'E_DUPLICATE', 'record.id', 'Record id already exists');
      return port.replace(state.revision, { ...state.facts, advanced: [...state.facts.advanced, record] });
    },
    async remove(layer, id) {
      requireValue(['basic', 'advanced'].includes(layer), 'E_FORMAT', 'layer', 'Unknown record layer');
      const state = port.read();
      requireValue(state.facts[layer].some(row => row.id === id), 'E_REFERENCE', 'id', 'Unknown record');
      return port.replace(state.revision, { ...state.facts, [layer]: state.facts[layer].filter(row => row.id !== id) });
    },
    async editMetadata(layer, id, patch) {
      fields(patch, [], ['note', 'vehicle', 'vehicleDetails'], 'metadata');
      requireValue(['basic', 'advanced'].includes(layer), 'E_FORMAT', 'layer', 'Unknown record layer');
      requireValue(layer === 'advanced' || !Object.hasOwn(patch, 'vehicleDetails'),
        'E_FORMAT', 'metadata.vehicleDetails', 'Vehicle details are advanced metadata');
      const state = port.read();
      requireValue(state.facts[layer].some(row => row.id === id), 'E_REFERENCE', 'id', 'Unknown record');
      return port.replace(state.revision, { ...state.facts,
        [layer]: state.facts[layer].map(row => row.id === id ? { ...row, ...patch } : row) });
    }
  });
}
