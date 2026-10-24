import type { Metadata } from 'next';
import MigrationAnalyzer from '../migration-analyzer';

export const metadata: Metadata = {
  title: 'Transwell 穿膜细胞计数｜FluoroScope',
  description: '本地批量分析蓝紫染色的 Transwell 图像，支持计数点修正、染色覆盖率与 CSV 导出。',
};

export default function TranswellPage() { return <MigrationAnalyzer mode="transwell" />; }
