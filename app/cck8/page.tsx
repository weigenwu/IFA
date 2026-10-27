import type { Metadata } from 'next';
import Cck8Analyzer from '../cck8-analyzer';

export const metadata: Metadata = {
  title: 'CCK-8 分析｜FluoroScope',
  description: '在浏览器本地整理 CCK-8 吸光度数据，进行空白校正、对照归一化与结果导出。',
};

export default function Cck8Page() { return <Cck8Analyzer />; }
