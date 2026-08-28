/* eslint-disable @next/next/no-html-link-for-pages */

export default function Home() {
  return (
    <main className="app-shell portal-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FluoroScope 首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>FluoroScope</span></a>
        <nav aria-label="分析工具"><a href="/colocalization">荧光共定位</a><a href="/intensity">荧光强度</a></nav>
        <span className="privacy-badge"><i /> 公开使用 · 无需登录</span>
      </header>

      <section className="portal-intro">
        <p className="eyebrow">IMMUNOFLUORESCENCE ANALYSIS</p>
        <h1>两个问题，<br />两套独立分析。</h1>
        <p className="lede">共用同一套原始像素读取、ROI 与质控规则；结果和导出互不混杂。图像只在当前浏览器中处理。</p>
      </section>

      <section className="tool-portal" aria-label="选择分析工具">
        <a className="tool-card coloc-tool" href="/colocalization">
          <span className="tool-index">01 · COLOCALIZATION</span>
          <div className="tool-glyph" aria-hidden="true"><i /><i /><b /></div>
          <h2>荧光共定位</h2>
          <p>任选两个原始通道，分析 Pearson、Manders、阈值后共现、双阳性面积与散点图。</p>
          <ul><li>双通道选择</li><li>Costes / Otsu / 手动阈值</li><li>共定位 Mask 与质控</li></ul>
          <strong>进入共定位分析 <span>→</span></strong>
        </a>

        <a className="tool-card intensity-tool" href="/intensity">
          <span className="tool-index">02 · INTENSITY & LINE SCAN</span>
          <div className="line-glyph" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <h2>荧光强度</h2>
          <p>逐通道测量 ROI 强度、背景校正、CTCF 与饱和率，并沿任意画线生成双通道曲线。</p>
          <ul><li>分析 ROI 与背景 ROI</li><li>Mean / RawIntDen / CTCF</li><li>线扫描及 CSV 导出</li></ul>
          <strong>进入强度分析 <span>→</span></strong>
        </a>
      </section>

      <section className="format-strip">
        <div><b>推荐输入</b><span>二维 OME-TIFF · 16-bit 灰度 TIFF · 多份同尺寸分通道 TIFF</span></div>
        <div><b>Olympus OIR</b><span>先用 Fiji / Bio-Formats 无损导出；网页会给出转换提示</span></div>
        <div><b>定量安全</b><span>自动识别伪彩、合并 RGB、有效位深与饱和风险</span></div>
      </section>

      <footer><span>FluoroScope · browser-local fluorescence analysis</span><a href="https://github.com/weigenwu/IFA" target="_blank" rel="noreferrer">GitHub ↗</a></footer>
    </main>
  );
}
