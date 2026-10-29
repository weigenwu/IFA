import type { ChannelData } from './analysis';
import type { LoadedImage } from './image';

export type IfMapping = { nucleus: string; a: string; b: string };
type ImageChannels = Pick<LoadedImage, 'channels' | 'displayOnly'>;
type Identity = { id: string; label: string; key: string | null };
export type IfChannelReference = { nucleus: Identity; a: Identity; b: Identity };
const roles = ['nucleus', 'a', 'b'] as const;

/** Only explicit channel suffixes combine files; directory names remain part of field identity. */
export function groupIfFiles(files: File[]): { name: string; files: File[] }[] {
  const groups = new Map<string, { name: string; files: File[] }>();
  const paths = new Set<string>();
  for (const file of files) {
    const path = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
    if (paths.has(path)) throw new Error(`文件路径重复：${path}。请分批导入或保留不同子文件夹。`);
    paths.add(path);
    const slash = path.lastIndexOf('/');
    const directory = path.slice(0, slash + 1);
    const filename = path.slice(slash + 1);
    const stem = filename.replace(/(?:\.ome)?\.[^.]+$/i, '');
    const match = stem.match(/^(.*)_(DAPI|AF647|GFP|ch\d+)$/i);
    const key = match ? `channels:${directory}${match[1]}` : `file:${path}`;
    const group = groups.get(key) ?? { name: match ? `${directory}${match[1]}` : path, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, files: group.files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })) }));
}

const markerPatterns = {
  nucleus: /(?:^|[^a-z0-9])(?:dapi|hoechst(?:[ -]?\d+)?)(?=$|[^a-z0-9])/i,
  a: /(?:^|[^a-z0-9])(?:af[ -]?647|alexa(?:[ -]?fluor)?[ -]?647|cy[ -]?5|647)(?=$|[^a-z0-9])/i,
  b: /(?:^|[^a-z0-9])(?:e?gfp|fitc|488)(?=$|[^a-z0-9])/i,
};

function markerRole(channel: ChannelData): keyof IfMapping | null {
  const text = `${channel.label} ${channel.id}`;
  const matches = roles.filter(role => markerPatterns[role].test(text));
  return matches.length === 1 ? matches[0] : null;
}

function identityKey(channel: ChannelData, displayOnly: boolean): string | null {
  if (displayOnly && ['red', 'green', 'blue'].includes(channel.sourceColor || '')) return `rgb:${channel.sourceColor}`;
  const role = markerRole(channel);
  if (role) return `marker:${role}`;
  // Explicit channel-number suffixes survive changing field names and file order.
  const token = channel.label.match(/_ch(\d+)(?=$|[ .·])/i);
  return token ? `channel:${Number(token[1])}` : null;
}

export function inferIfChannels(image: ImageChannels): IfMapping {
  const mapping: IfMapping = { nucleus: '', a: '', b: '' };
  const colors = { nucleus: 'blue', a: 'red', b: 'green' };
  for (const role of roles) {
    const matches = image.channels.filter(channel => image.displayOnly
      ? channel.sourceColor === colors[role]
      : markerRole(channel) === role);
    if (matches.length === 1) mapping[role] = matches[0].id;
  }
  return mapping;
}

export function resolveIfChannels(image: Pick<LoadedImage, 'channels'>, mapping: IfMapping): [ChannelData, ChannelData, ChannelData] {
  const result = roles.map(role => {
    const matches = image.channels.filter(channel => channel.id === mapping[role]);
    if (!mapping[role] || matches.length !== 1) throw new Error('请分别指定唯一的 DAPI、AF647 和 GFP 通道。');
    return matches[0];
  });
  if (new Set(result.map(channel => channel.id)).size !== 3) throw new Error('DAPI、AF647 和 GFP 必须使用三个不同通道。');
  return result as [ChannelData, ChannelData, ChannelData];
}

export function captureIfChannelReference(image: ImageChannels, mapping: IfMapping): IfChannelReference {
  const channels = resolveIfChannels(image, mapping);
  return Object.fromEntries(roles.map((role, index) => {
    const channel = channels[index];
    return [role, { id: channel.id, label: channel.label, key: identityKey(channel, image.displayOnly) }];
  })) as IfChannelReference;
}

/** Apply a confirmed mapping to another field without assuming channel/file order. */
export function mapIfChannels(image: ImageChannels, reference: IfChannelReference): IfMapping {
  const mapping = {} as IfMapping;
  for (const role of roles) {
    const selected = reference[role];
    const matches = image.channels.filter(channel => selected.key
      ? identityKey(channel, image.displayOnly) === selected.key
      : channel.id === selected.id && channel.label === selected.label);
    if (matches.length !== 1) throw new Error('通道身份与已确认图不一致或不唯一，请单独指定本图通道。');
    mapping[role] = matches[0].id;
  }
  resolveIfChannels(image, mapping);
  return mapping;
}

export function csv(rows: (string | number | boolean | null)[][]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let text = value === null ? 'NA' : String(value);
    if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(value)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
