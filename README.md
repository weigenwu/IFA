# FluoroScope

两个在浏览器本地运行的二维免疫荧光分析工具：**荧光共定位**与**荧光强度/线扫描**。图像不会上传到服务器，也不需要账号登录；TIFF 原始像素用于计算，画布仅用于显示。

**在线使用：<https://fluoroscope-ifa.yu2898296277.chatgpt.site>**

## 两个独立入口

- `/colocalization`：从多通道图像中任选 A/B，输出 Pearson、Manders、阈值、散点图与共定位 Mask。
- `/intensity`：输出 ROI Mean、Median、SD、RawIntDen、背景校正、CTCF、饱和比例与双通道线扫描。

## 输入适配

- 二维 OME-TIFF：读取最多 12 个通道、通道名、`SignificantBits` 与 XY 像素尺寸。
- 普通 8/16/32-bit TIFF：支持多页/多样本，不再限制为前三个通道。
- 多份同尺寸分通道 TIFF：一次选择最多 8 个文件，组合后从通道列表中选择；网页不做配准。
- PNG/JPEG 与伪彩/合并 RGB：标记为展示图，默认阻止定量；只能在明确确认风险后做探索性分析。
- Olympus `.oir`：普通浏览器不能可靠解析。网页会提示先用 Fiji / Bio-Formats 导出二维 OME-TIFF 或保持原始位深的分通道灰度 TIFF。

检测到 Z-stack 或时间序列 OME-TIFF 时，网页不会猜测 C/Z/T 顺序，而是要求先在 Fiji 选择单层或生成投影。

## 功能

- OME-TIFF、PNG、JPEG 与 8/16/32-bit TIFF
- 矩形分析 ROI、独立背景 ROI、背景第 5 百分位快捷校正
- Costes、Otsu、手动或零阈值
- Pearson（无阈值/阈值下/阈值上）、M1/M2、tM1/tM2、Manders overlap、Li ICQ
- ROI 强度：像素数、Mean、Median、sample SD、Min/Max、RawIntDen、背景均值/SD、Corrected Mean、CTCF、饱和比例
- 线扫描：每 1 px 双线性采样、指定线宽内 mean ± sample SD、可选 Gaussian 派生曲线
- 指标 CSV、线扫 CSV 与包含 SHA-256、ROI、参数、告警的 JSON

## 使用

1. 选择共定位或强度工具。
2. 上传一个二维 OME-TIFF，或同时选择多份同尺寸分通道 TIFF。
3. 映射通道 A/B；必要时画分析 ROI 与背景 ROI。
4. 共定位页选择阈值；强度页可画线扫描。运行分析并检查质控提示。
5. 导出该工具独立的指标 CSV、完整 JSON；强度页还可导出线扫 CSV。

JPEG、截图和社交平台图片经过有损或 8-bit 转换，只适合探索性分析。跨样本强度比较必须保持曝光、增益、激光功率、探测器设置及位深一致。

## 指标口径

- Pearson 使用背景校正后的有符号强度，报告线性相关性。
- M1/M2 和 tM1/tM2 使用非负强度作为权重，报告方向性的信号共现；严格比较规则为 `>`。
- Costes 自动阈值采用正交回归与阈值下 Pearson 的二分搜索。为控制浏览器耗时，超过 250,000 个 ROI 像素时均匀抽样估计阈值，最终指标仍使用全部 ROI 像素。
- `RawIntDen = Σ raw pixels`
- `Corrected Mean = MeanROI − MeanBackground`
- `CTCF = RawIntDen − N × MeanBackground`，负值不会截断。
- 线扫描的平滑曲线独立于原始曲线，导出文件同时保存 raw、背景校正及 smooth 值。

共定位不等于分子相互作用。串色、色差、通道错位、饱和、背景 offset、探测器非线性、照明梯度和 Z 投影均可能制造假结果；统计推断应以独立图像、细胞或动物为重复单位，而不是以像素为重复单位。

## 本地开发

```bash
npm install
npm run dev
npm test
npm run build
```

需要 Node.js 22.13 或更高版本。

## 验证

`tests/analysis.test.ts` 覆盖完全相关、完全反相关、无线性相关但有重叠、方向不对称 Manders、常量通道、CTCF、已知梯度线扫描、单通道伪彩识别与 12-bit 饱和判断。投稿级使用前，仍建议把同一原始 TIFF/ROI 与 Fiji Coloc 2 和 ImageJ 测量结果对照。

## 方法与参考

- [Fiji Coloc 2 文档](https://imagej.github.io/plugins/coloc-2)
- [ImageJ Analyze / Plot Profile](https://imagej.net/ij/docs/menus/analyze.html)
- [Costes et al., 2004](https://pmc.ncbi.nlm.nih.gov/articles/PMC1304300/)
- [Dunn et al., 2011：共定位实践指南](https://pmc.ncbi.nlm.nih.gov/articles/PMC3074624/)
- [GeoTIFF.js](https://github.com/geotiffjs/geotiff.js)（MIT）
- [FluoQuant](https://github.com/QiRao92/fluorescence-linescan-analyzer) 仅作工作流参考；该仓库没有许可证，本项目没有复制其源码。

本机 `All_WLab_collection.jar` 也只用于梳理常用输出字段；其专有宏和其他 GPL/未知许可插件代码均未复制。

## 许可

[MIT](LICENSE)
