type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    id: string;
    suggestedName: string;
    types: Array<{ accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

export interface PreparedDownload { name: string; url: string }

/** Call from the export click. onDownloadReady owns the URL and must revoke it when dismissed. */
export async function saveFile(name: string, mime: string, makeBlob: () => Blob | Promise<Blob>, onDownloadReady?: (download: PreparedDownload) => void): Promise<boolean> {
  const pickerWindow = window as SavePickerWindow;
  let handle: FileSystemFileHandle | undefined;
  if (typeof pickerWindow.showSaveFilePicker === 'function') {
    try {
      handle = await pickerWindow.showSaveFilePicker({
        // ponytail: native per-site folder memory; no directory-wide permission or path database.
        id: 'fluoroscope-exports',
        suggestedName: name,
        types: [{ accept: { [mime.split(';')[0]]: [`.${name.split('.').pop()}`] } }],
      });
    } catch (problem) {
      const reason = problem instanceof Error ? problem.name : '';
      if (reason === 'AbortError') return false;
      // Embedded/restricted browsers can expose the API without allowing its use.
      if (reason !== 'SecurityError' && reason !== 'NotSupportedError') throw problem;
    }
  }

  const blob = await makeBlob();
  if (!blob.size) throw new Error('导出内容为空，请重试。');
  if (handle) {
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (problem) {
      if (writable) await writable.abort().catch(() => {});
      const reason = problem instanceof Error ? problem.name : '';
      // A picker can work while file writing is unavailable (e.g. embedded browsers).
      // Do not retry cancellations, security-scan failures, disk errors or file locks.
      if (!['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(reason)) throw problem;
    }
  }

  const url = URL.createObjectURL(blob);
  const downloadName = handle?.name || name;
  // Keep the exact encoded bytes available for a real user click if automatic download is blocked.
  onDownloadReady?.({ name: downloadName, url });
  const link = document.createElement('a');
  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  try { link.click(); }
  catch (problem) { if (!onDownloadReady) throw problem; }
  finally {
    link.remove();
    if (!onDownloadReady) setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}
