import type { Metadata } from 'next';
import EduAnalyzer from '../edu-analyzer';

export const metadata: Metadata = {
  title: 'EdU 分析与去杂色｜FluoroScope',
  description: '浏览器本地批量导入荧光图像，预览背景与碎点清理，检查核分割并统计 EdU 阳性比例。',
};

export default function EduPage() { return <EduAnalyzer />; }
