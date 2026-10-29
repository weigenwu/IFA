export default function Home() {
  return (
    <main className="app-shell portal-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="FluoroScope 首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>FluoroScope</span></a>
        <nav aria-label="分析工具"><a href="./colocalization/">荧光共定位</a><a href="./intensity/">荧光强度</a><a href="./edu/">EdU</a><a href="./scratch/">细胞划痕</a><a href="./transwell/">Transwell</a><a href="./cck8/">CCK-8</a><a href="./if-count/">切片计数</a></nav>
        <span className="privacy-badge"><i /> 公开使用 · 无需登录</span>
      </header>

      <section className="portal-intro">
        <p className="eyebrow">CELL ASSAYS · LOCAL ANALYSIS</p>
        <h1>细胞实验分析</h1>
        <p className="lede">荧光、EdU、划痕、Transwell、CCK-8 与切片计数。本地处理，无需登录。</p>
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
        <a className="tool-card intensity-tool" href="./edu/">
          <span className="tool-index">03 · EdU & BACKGROUND</span>
          <h2>EdU 分析与去杂色</h2>
          <p>文件夹导入、碎点清理、核分割与阳性率。</p>
          <strong>打开 <span>→</span></strong>
        </a>
        <a className="tool-card coloc-tool" href="./scratch/">
          <span className="tool-index">04 · SCRATCH ASSAY</span>
          <h2>细胞划痕</h2>
          <p>面积、宽度、闭合率；批量计算与边界修正。</p>
          <strong>打开 <span>→</span></strong>
        </a>
        <a className="tool-card intensity-tool" href="./transwell/">
          <span className="tool-index">05 · TRANSWELL</span>
          <h2>穿膜细胞计数</h2>
          <p>计数估计、染色覆盖率；批量计算与人工校正。</p>
          <strong>打开 <span>→</span></strong>
        </a>
        <a className="tool-card coloc-tool" href="./cck8/">
          <span className="tool-index">06 · CCK-8 ASSAY</span>
          <h2>CCK-8 分析</h2>
          <p>吸光度导入、空白校正、对照归一化与结果导出。</p>
          <strong>打开 <span>→</span></strong>
        </a>
        <a className="tool-card intensity-tool" href="./if-count/">
          <span className="tool-index">07 · IF CELL COUNT</span>
          <h2>切片细胞计数</h2>
          <p>圈定区域、紫色阳性与绿紫双阳性计数、批量导出。</p>
          <strong>打开 <span>→</span></strong>
        </a>
      </section>

      <footer><span>FluoroScope</span><a href="https://github.com/weigenwu/IFA" target="_blank" rel="noreferrer">GitHub ↗</a></footer>
    </main>
  );
}
