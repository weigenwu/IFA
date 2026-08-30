export interface ExportArchiveEntry {
  name: string;
  data: ArrayBuffer | Uint8Array;
}

export function safeFilePart(value: string, fallback = 'image') {
  let safe = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80);
  if (!safe) safe = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

export async function createStoredZip(entries: ExportArchiveEntry[]) {
  if (!entries.length) throw new Error('ZIP 中至少需要一个文件。');
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (!entry.name || files[entry.name]) throw new Error(`ZIP 文件名为空或重复：${entry.name || '(空)'}`);
    files[entry.name] = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
  }
  const { zipSync } = await import('fflate');
  const zipped = zipSync(files, { level: 0 });
  return new Uint8Array(zipped).buffer;
}
