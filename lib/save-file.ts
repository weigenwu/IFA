type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    id: string;
    suggestedName: string;
    types: Array<{ accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

/** Call directly from the export click, before encoding consumes user activation. */
export async function saveFile(name: string, mime: string, makeBlob: () => Blob | Promise<Blob>): Promise<boolean> {
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
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (problem) {
      await writable.abort().catch(() => {});
      throw problem;
    }
  } else {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    try { link.click(); }
    finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
  return true;
}
