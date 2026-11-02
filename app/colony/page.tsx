import type { Metadata } from 'next';
import ColonyAnalyzer from '../colony-analyzer';

export const metadata: Metadata = {
  title: '平板克隆｜FluoroScope',
  description: '圈定培养孔，统计克隆数，自定义组别自动排版，并导出可用于 Prism 的逐孔数据。',
};

export default function ColonyPage() { return <ColonyAnalyzer />; }
