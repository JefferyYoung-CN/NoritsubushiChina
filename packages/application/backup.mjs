import { canonical, day, fields, independent, parseJson, requireValue, sha256 } from './validation.mjs';
import { decodeFacts } from './records.mjs';

export const BACKUP_VERSION = 'phase1.user-backup.v4';
export const REPLACEMENT_WARNING = '导入备份将清空目前设备上保存的全部记录';
// v4 只放宽进阶记录的值范围，没有新增字段；v1–v3 仍按旧记录规则读取。
// 基础区间跨记录重叠在读取与导入时容忍（见 records.decodeFacts），不因版本拒绝。
const READABLE_VERSIONS = [BACKUP_VERSION, 'phase1.user-backup.v3', 'phase1.user-backup.v2', 'phase1.user-backup.v1'];
const tickets = new WeakMap();

export async function encodeBackup(facts, exportedOn) {
  const payload = { formatVersion: BACKUP_VERSION, exportedOn: day(exportedOn, 'backup.exportedOn'), facts: decodeFacts(facts) };
  const result = canonical({ ...payload, sha256: await sha256(canonical(payload)) });
  requireValue(new TextEncoder().encode(result).length <= 5 * 1024 * 1024, 'E_FORMAT', 'backup', 'Backup exceeds 5 MiB limit');
  return result;
}

export async function decodeBackup(input) {
  const backup = parseJson(input, 'backup');
  // 版本判断先于字段、摘要与记录校验：未知版本即使其余内容也坏，也只报版本不支持。
  requireValue(READABLE_VERSIONS.includes(backup?.formatVersion), 'E_SCHEMA', 'backup.formatVersion', 'Unsupported backup version');
  fields(backup, ['formatVersion', 'exportedOn', 'facts', 'sha256'], [], 'backup');
  day(backup.exportedOn, 'backup.exportedOn');
  const { sha256: digest, ...payload } = backup;
  requireValue(digest === await sha256(canonical(payload)), 'E_CHECKSUM', 'backup.sha256', 'Backup digest differs');
  if (['phase1.user-backup.v1', 'phase1.user-backup.v2'].includes(backup.formatVersion)) {
    requireValue(['basic', 'advanced'].every(layer => Array.isArray(backup.facts?.[layer]) &&
      backup.facts[layer].every(row => row && !Object.hasOwn(row, 'vehicleDetails'))),
    'E_FORMAT', 'backup.facts', 'Structured vehicle details require backup v3');
  }
  if (backup.formatVersion === 'phase1.user-backup.v1') {
    requireValue(['basic', 'advanced'].every(layer => Array.isArray(backup.facts?.[layer]) &&
      backup.facts[layer].every(row => row && !Object.hasOwn(row, 'physicalLineId'))),
    'E_FORMAT', 'backup.facts', 'Physical line records require backup v2');
  }
  const facts = decodeFacts(backup.facts);
  if (backup.formatVersion !== BACKUP_VERSION) {
    // v1–v3 是整圈/续圈规则发布前的口径：进阶记录必须起点≠终点且 sectionIds 不重复。
    requireValue(facts.advanced.every(row => row.fromStationId !== row.toStationId &&
      new Set(row.sectionIds).size === row.sectionIds.length),
    'E_FORMAT', 'backup.facts.advanced', 'Same-station or repeated-section advanced records require backup v4');
  }
  return facts;
}

export async function prepareImport(port, input) {
  // Capture before asynchronous validation so changes while parsing cannot be
  // silently replaced after the user has reviewed a stale record count.
  const state = port.read();
  const facts = await decodeBackup(input);
  const preview = independent({ warning: REPLACEMENT_WARNING, existingRecords: state.facts.basic.length + state.facts.advanced.length,
    incomingRecords: facts.basic.length + facts.advanced.length, expectedRevision: state.revision });
  tickets.set(preview, { port, facts, revision: state.revision });
  return preview;
}

export async function finishImport(port, preview, confirmed, options = {}) {
  const ticket = tickets.get(preview);
  requireValue(ticket?.port === port && typeof confirmed === 'boolean', 'E_IMPORT', 'preview', 'Import requires a current scoped preview and explicit decision');
  tickets.delete(preview);
  if (!confirmed) return { status: 'cancelled', state: port.read() };
  return { status: 'imported', state: await port.replace(ticket.revision, ticket.facts, { ...options, forceRecalculate: true }) };
}
