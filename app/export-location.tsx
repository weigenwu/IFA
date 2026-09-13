'use client';

import { useEffect, useRef, useState } from 'react';

const FOLDER_KEY = 'fluoroscope.export-folder-hint';

export default function ExportLocation() {
  const [folder, setFolder] = useState('');
  const [needsFallback, setNeedsFallback] = useState(false);
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNeedsFallback(typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker !== 'function');
    try { setFolder(localStorage.getItem(FOLDER_KEY) ?? ''); }
    catch { setNotice('当前环境无法记住路径，仍可复制使用。'); }
  }, []);

  const rememberFolder = (value: string) => {
    setFolder(value);
    try {
      if (value.trim()) localStorage.setItem(FOLDER_KEY, value);
      else localStorage.removeItem(FOLDER_KEY);
      setNotice('');
    } catch { setNotice('当前环境无法记住路径，仍可复制使用。'); }
  };

  const copyFolder = async () => {
    try {
      await navigator.clipboard.writeText(folder.trim());
      setNotice('已复制，导出时粘贴到保存窗口的地址栏。');
    } catch {
      input.current?.focus();
      input.current?.select();
      setNotice('已选中路径，请按 Ctrl+C 复制。');
    }
  };

  return (
    <details className="export-location" open={needsFallback}>
      <summary>保存位置 · {needsFallback ? '记住 / 复制路径' : '自动记忆 / 备用路径'}</summary>
      <p>{needsFallback ? '当前浏览器未提供自动记忆接口。填一次路径，以后复制粘贴到保存窗口。' : '支持时沿用上次保存文件夹；微信内受限时，可用下方备用路径。'}</p>
      <div className="export-folder-controls">
        <input ref={input} aria-label="备用保存文件夹路径" placeholder={'文件夹路径，例如 D:\\实验图片'} value={folder} onChange={event => rememberFolder(event.target.value)} autoComplete="off" spellCheck={false} />
        <button type="button" disabled={!folder.trim()} onClick={() => { void copyFolder(); }}>复制路径</button>
      </div>
      <p role="status">{notice || '路径仅保存在当前微信 / 浏览器，不会自动同步保存弹窗的位置。'}</p>
    </details>
  );
}
