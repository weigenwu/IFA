export default function Home() {
  return (
    <main className="app-shell portal-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="FluoroScope 首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>FluoroScope</span></a>
        <nav aria-label="分析工具"><a href="./colocalization/">荧光共定位</a><a href="./intensity/">荧光强度</a></nav>
        <span className="privacy-badge"><i /> 公开使用 · 无需登录</span>
      </header>

      <section className="portal-intro">
        <p className="eyebrow">IMMUNOFLUORESCENCE</p>
        <h1>免疫荧光分析</h1>
        <p className="lede">直接打开 OIR / TIFF，本地处理，无需登录。</p>
      </section>

      <section className="tool-portal" aria-label="选择分析工具">
        <a className="tool-card coloc-tool" href="./colocalization/">
          <span className="tool-index">01 · COLOCALIZATION</span>
          <div className="tool-glyph" aria-hidden="true"><i /><i /><b /></div>
          <h2>荧光共定位</h2>
          <p>双通道、Pearson、Manders、Mask。</p>
          <strong>打开 <span>→</span></strong>
        </a>

        <a className="tool-card intensity-tool" href="./intensity/">
          <span className="tool-index">02 · INTENSITY & LINE SCAN</span>
          <div className="line-glyph" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <h2>荧光强度</h2>
          <p>多通道伪彩、背景、ROI 强度与裁图。</p>
          <strong>打开 <span>→</span></strong>
        </a>
      </section>

      <footer><span>FluoroScope</span><a href="https://github.com/weigenwu/IFA" target="_blank" rel="noreferrer">GitHub ↗</a></footer>
    </main>
  );
}
