import type { Metadata } from 'next';
import './globals.css';

const publicBase = 'https://fluoroscope-ifa.yu2898296277.chatgpt.site/';
const socialImage = `${publicBase}og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(publicBase),
  title: 'FluoroScope｜免疫荧光共定位与强度分析',
  description: '直接读取 Olympus FV3000 OIR 或 TIFF，在浏览器本地完成免疫荧光共定位、ROI 强度与线扫描分析。',
  openGraph: {
    title: 'FluoroScope｜免疫荧光共定位与强度分析',
    description: '无需 ImageJ，直接读取 Olympus FV3000 OIR 或 TIFF，在浏览器本地完成共定位、强度与线扫描分析。',
    locale: 'zh_CN',
    type: 'website',
    images: [{ url: socialImage, width: 1792, height: 910, alt: 'FluoroScope 免疫荧光分析工具' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FluoroScope｜免疫荧光共定位与强度分析',
    description: '无需 ImageJ，直接读取 Olympus FV3000 OIR 或 TIFF，在浏览器本地完成共定位、强度与线扫描分析。',
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
