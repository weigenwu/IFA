import type { Metadata } from 'next';
import Analyzer from '../analyzer';

export const metadata: Metadata = {
  title: '荧光强度与线扫描｜FluoroScope',
  description: '在浏览器本地完成 ROI 荧光强度、背景校正与线扫描分析。',
};

export default function IntensityPage() { return <Analyzer mode="intensity" />; }
