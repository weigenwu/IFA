# FluoroScope

两个在浏览器本地运行的免疫荧光分析工具：**荧光共定位**与**荧光强度/线扫描**。Olympus FV3000 OIR 和 TIFF 图像都不会上传到服务器，也不需要账号登录；原始像素用于计算，画布仅用于显示。

**公开入口（无需登录）：<https://weigenwu.github.io/IFA/>**

备用入口：<https://fluoroscope-ifa.yu2898296277.chatgpt.site>

## 两个独立入口

- `/colocalization`：从多通道图像中任选 A/B，输出 Pearson、Manders、阈值、散点图与共定位 Mask。
- `/intensity`：确认 1–8 个通道，设置 Olympus 伪彩、ImageJ 风格显示范围和背景杂色抑制，框选可缩放正方形 ROI，输出强度指标、双通道线扫描及带比例尺的裁切图。

## 输入适配

- Olympus FV3000 `.oir`：直接在浏览器本地读取 8/16-bit 原始通道、有效位深、通道顺序、通道名、Olympus LUT 与像素尺寸，无需 ImageJ。Z-stack 自动逐通道生成最大强度投影（MIP）并写入质控记录。
- 二维 OME-TIFF：读取最多 12 个通道、通道名、`SignificantBits` 与 XY 像素尺寸。
- 普通 8/16/32-bit TIFF：支持多页/多样本，不再限制为前三个通道。
- 多份同尺寸分通道 TIFF：一次选择最多 8 个文件，组合后从通道列表中选择；网页不做配准。
- PNG/JPEG 与伪彩/合并 RGB：标记为展示图，默认阻止定量；只能在明确确认风险后做探索性分析。
- 通道伪彩可在绿色、红色、蓝色、青色、洋红、黄色、橙色、紫色和白色/灰度之间切换；OIR 优先采用文件中保存的 Olympus LUT。每个通道可选原始范围、自动增强、ImageJ 0.35% 饱和近似或手动 Min/Max。可用无细胞暗区的背景 ROI 按“均值 + 2 SD”抑制显示杂色；这些显示设置均不改变原始像素或计算结果。TD 透射光默认不参与强度分析，但可手动选入。

OIR 直接读取当前限定为单文件、未压缩的 FV3000 数据，单文件不超过 512 MB，并且同目录不能存在同名 `_00001`、`_00002` 等伴随文件。网页会用采集轴元数据核对 Z 层；若计划层数多于完整层数，会在页面和导出结果中明确警告中断采集或缺少伴随文件。时间序列、光谱扫描、mosaic、压缩像素或未知布局会停止，后续可接入独立 Bio-Formats 服务作为兼容兜底。检测到 Z-stack 或时间序列 OME-TIFF 时，网页仍不会猜测 C/Z/T 顺序。

## 功能

- Olympus FV3000 OIR、OME-TIFF、PNG、JPEG 与 8/16/32-bit TIFF
- 共定位矩形 ROI；强度页可缩放、可移动或固定边长的正方形 ROI；独立背景 ROI与第 5 百分位快捷校正
- Costes、Otsu、手动或零阈值
- Pearson（无阈值/阈值下/阈值上）、M1/M2、tM1/tM2、Manders overlap、Li ICQ
- ROI 强度：像素数、Mean、Median、sample SD、Min/Max、RawIntDen、背景均值/SD、Corrected Mean、CTCF、饱和比例
- 线扫描：每 1 px 双线性采样、指定线宽内 mean ± sample SD、可选 Gaussian 派生曲线
- 指标 CSV、线扫 CSV、完整 JSON，以及原始 ROI 尺寸的 PNG/JPG/8-bit RGB 伪彩 TIFF 裁切图

## 使用

1. 选择共定位或强度工具。
2. 直接上传一个 `.oir`、二维 OME-TIFF，或同时选择多份同尺寸分通道 TIFF。
3. 核对自动读取的名称与 Olympus 伪彩并点击“确认通道”；随后选择 A/B 或勾选强度通道。需要时用直方图、ImageJ、自动或手动 Min/Max 调整显示。
4. 强度页可拖动四角缩放正方形、在框内拖动位置，也可直接输入实际边长（µm、mm、cm 或 px）；有标定的 OIR 默认显示 µm。可用“实际 : 排版 = 1 : N”换算排版参考尺寸，不改变 ROI、定量或导出像素；勾选固定后只移动。显示去杂色只影响预览和图片导出，定量扣背景仍单独设置。
5. 运行分析并检查质控；导出 CSV/JSON，或直接导出当前裁剪区的 PNG、JPG、TIFF。

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
npm run build:pages
```

需要 Node.js 22.13 或更高版本。

## 验证

`tests/analysis.test.ts` 覆盖分析指标与 OIR 读取；`tests/roi-export.test.ts` 覆盖精确 ROI 尺寸、显示黑场、比例尺和可回读的 8-bit RGB 伪彩 TIFF。

本项目附带的 51 个 FV3000 OIR（48 个二维、3 个 8 层 Z-stack；512×512 或 1024×1024，5 通道，12-bit）均已与 Bio-Formats 8.1.1 逐文件核对 X/Y/C/Z/T、有效位深和每个输出通道的 SHA-256；不一致数为 0。投稿级使用前，仍建议用代表图像和固定 ROI 与 Fiji Coloc 2 / ImageJ 测量结果交叉核对。

## 方法与参考

- [Fiji Coloc 2 文档](https://imagej.github.io/plugins/coloc-2)
- [ImageJ Analyze / Plot Profile](https://imagej.net/ij/docs/menus/analyze.html)
- [Costes et al., 2004](https://pmc.ncbi.nlm.nih.gov/articles/PMC1304300/)
- [Dunn et al., 2011：共定位实践指南](https://pmc.ncbi.nlm.nih.gov/articles/PMC3074624/)
- [GeoTIFF.js](https://github.com/geotiffjs/geotiff.js)（MIT）
- [oirfile](https://github.com/cgohlke/oirfile)（BSD-3-Clause）：OIR 块布局与术语参考；本项目为 TypeScript 浏览器实现。
- [Bio-Formats Olympus OIR](https://bio-formats.readthedocs.io/en/latest/formats/olympus-oir.html)：真实文件像素与维度对照验证。
- [FluoQuant](https://github.com/QiRao92/fluorescence-linescan-analyzer) 仅作工作流参考；该仓库没有许可证，本项目没有复制其源码。

本机 `All_WLab_collection.jar` 也只用于梳理常用输出字段；其专有宏和其他 GPL/未知许可插件代码均未复制。

## 许可

[MIT](LICENSE)。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
