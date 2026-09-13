import assert from 'node:assert/strict';
import test from 'node:test';
import { saveFile, type PreparedDownload } from '../lib/save-file.ts';

test('exports share native folder memory, preserve bytes, and handle cancellation/failures/fallback', async t => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events: string[] = [];
  const source = new Blob([new Uint8Array([0, 255, 10, 128])]);
  let written: Blob | undefined;
  const handle = { createWritable: async () => {
    events.push('create');
    return {
      write: async (blob: Blob) => { written = blob; events.push('write'); },
      close: async () => { events.push('close'); },
      abort: async () => { events.push('abort'); },
    };
  } };
  type Options = { id: string; suggestedName: string; types: Array<{ accept: Record<string, string[]> }> };
  const pickerOptions: Options[] = [];
  const fakeWindow: { showSaveFilePicker?: (options: Options) => Promise<typeof handle> } = {
    showSaveFilePicker: async options => { pickerOptions.push(options); events.push('pick'); return handle; },
  };
  const link = { href: '', download: '', click: () => events.push('download'), remove: () => events.push('remove') };
  const deferred: Array<() => void> = [];
  let downloadBlob: Blob | MediaSource | undefined;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => link, body: { appendChild: () => events.push('append') },
  } });
  t.mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => { downloadBlob = blob; return 'blob:export'; });
  t.mock.method(URL, 'revokeObjectURL', () => { events.push('revoke'); });
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => {
    deferred.push(callback);
  }) as unknown as typeof setTimeout);
  const makeBlob = async () => { events.push('encode'); return source; };

  try {
    for (const [extension, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['tif', 'image/tiff'], ['zip', 'application/zip'], ['csv', 'text/csv;charset=utf-8'], ['json', 'application/json']]) {
      events.length = 0;
      assert.equal(await saveFile(`裁剪.${extension}`, mime, makeBlob), true);
      assert.deepEqual(events, ['pick', 'encode', 'create', 'write', 'close']);
      assert.deepEqual(new Uint8Array(await written!.arrayBuffer()), new Uint8Array(await source.arrayBuffer()));
      assert.equal(pickerOptions.at(-1)!.suggestedName, `裁剪.${extension}`);
      assert.deepEqual(pickerOptions.at(-1)!.types, [{ accept: { [mime.split(';')[0]]: [`.${extension}`] } }]);
    }
    assert.deepEqual([...new Set(pickerOptions.map(options => options.id))], ['fluoroscope-exports']);

    events.length = 0;
    await assert.rejects(saveFile('bad.png', 'image/png', () => { throw new Error('encoding failed'); }), /encoding failed/);
    assert.deepEqual(events, ['pick']); // Never open/truncate a writable before encoding succeeds.
    await assert.rejects(saveFile('empty.png', 'image/png', () => new Blob()), /导出内容为空/);

    fakeWindow.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    events.length = 0;
    assert.equal(await saveFile('cancel.png', 'image/png', makeBlob), false);
    assert.equal(events.length, 0); // Cancel must not generate data or silently download elsewhere.

    fakeWindow.showSaveFilePicker = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    await assert.rejects(saveFile('denied.png', 'image/png', makeBlob), { name: 'NotAllowedError' });
    assert.equal(events.length, 0);

    fakeWindow.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async () => { throw new Error('disk full'); },
      close: async () => { events.push('close'); },
      abort: async () => { events.push('abort'); },
    }) });
    await assert.rejects(saveFile('failed.tif', 'image/tiff', makeBlob), /disk full/);
    assert.deepEqual(events, ['encode', 'abort']);

    // Regression: the picker succeeds, but createWritable (or write/close) is refused.
    // Reuse the already encoded bytes and preserve a user-clickable download, without an expiry timer.
    for (const phase of ['create', 'write', 'close']) {
      for (const reason of ['NotAllowedError', 'SecurityError', 'NotSupportedError']) {
        fakeWindow.showSaveFilePicker = async () => ({ name: '用户重命名.tif', createWritable: async () => {
          events.push('create');
          if (phase === 'create') throw new DOMException('Unavailable', reason);
          return {
            write: async () => { events.push('write'); if (phase === 'write') throw new DOMException('Unavailable', reason); },
            close: async () => { events.push('close'); if (phase === 'close') throw new DOMException('Unavailable', reason); },
            abort: async () => { events.push('abort'); },
          };
        } });
        events.length = 0;
        let ready: PreparedDownload | undefined;
        assert.equal(await saveFile('original.tif', 'image/tiff', makeBlob, file => { ready = file; events.push('ready'); }), true);
        assert.deepEqual(ready, { name: '用户重命名.tif', url: 'blob:export' });
        assert.equal(downloadBlob, source);
        assert.equal(events.filter(event => event === 'encode').length, 1);
        assert.equal(events.includes('abort'), phase !== 'create');
        assert.deepEqual(events.slice(-4), ['ready', 'append', 'download', 'remove']);
        assert.equal(link.download, '用户重命名.tif');
        assert.equal(deferred.length, 0);
      }
    }

    fakeWindow.showSaveFilePicker = async () => ({ createWritable: async () => { throw new DOMException('Scan failed', 'AbortError'); } });
    events.length = 0;
    await assert.rejects(saveFile('scan.tif', 'image/tiff', makeBlob), { name: 'AbortError' });
    assert.deepEqual(events, ['encode']); // A security scan failure must not trigger an alternate save.

    fakeWindow.showSaveFilePicker = undefined;
    const autoClick = link.click;
    link.click = () => { throw new Error('Automatic downloads blocked'); };
    let clickReady: PreparedDownload | undefined;
    assert.equal(await saveFile('manual.png', 'image/png', makeBlob, file => { clickReady = file; }), true);
    assert.deepEqual(clickReady, { name: 'manual.png', url: 'blob:export' });
    assert.equal(deferred.length, 0);
    link.click = autoClick;

    for (const reason of [null, 'SecurityError', 'NotSupportedError']) {
      fakeWindow.showSaveFilePicker = reason ? async () => { throw new DOMException('Unavailable', reason); } : undefined;
      events.length = 0;
      assert.equal(await saveFile('fallback.zip', 'application/zip', makeBlob), true);
      assert.deepEqual(events, ['encode', 'append', 'download', 'remove']);
      assert.equal(link.download, 'fallback.zip');
      deferred.shift()!();
      assert.equal(events.at(-1), 'revoke');
    }
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
