import type { Metadata } from 'next';
import Analyzer from '../analyzer';

export const metadata: Metadata = {
  title: '荧光共定位｜FluoroScope',
  description: '在浏览器本地完成双通道免疫荧光共定位分析。',
};

export default function ColocalizationPage() { return <Analyzer mode="colocalization" />; }
