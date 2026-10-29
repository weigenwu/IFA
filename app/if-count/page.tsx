import type { Metadata } from 'next';
import IfCountAnalyzer from '../if-count-analyzer';

export const metadata: Metadata = {
  title: '切片细胞计数｜FluoroScope',
  description: '在浏览器本地圈定切片区域，统计 DAPI 细胞核、紫色阳性与绿紫双阳性细胞，并批量导出。',
};

export default function IfCountPage() { return <IfCountAnalyzer />; }
