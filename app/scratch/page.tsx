import type { Metadata } from 'next';
import MigrationAnalyzer from '../migration-analyzer';

export const metadata: Metadata = {
  title: '细胞划痕｜FluoroScope',
  description: '本地批量测量细胞划痕面积、平均宽度与闭合率，支持边界修正和 CSV 导出。',
};

export default function ScratchPage() { return <MigrationAnalyzer mode="scratch" />; }
