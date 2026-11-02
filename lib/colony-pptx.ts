export interface ColonyPptxInput {
  title: string;
  groups: { name: string; images: { name: string; dataUrl: string }[] }[];
  canvasColor: string;
  /** Line width in the montage's 320 px well-size coordinate system; zero hides it. */
  lineWidth: number;
  notes?: string;
}

/** Native text and line objects plus individually editable, already-cropped PNGs. */
export async function colonyPptx({ title, groups, canvasColor, lineWidth, notes }: ColonyPptxInput): Promise<ArrayBuffer> {
  if (!groups.length || groups.some(group => !group.name.trim() || !group.images.length)) throw new Error('PPT 排版需要组名及每组至少一张图片。');
  if (!/^#[0-9a-f]{6}$/i.test(canvasColor)) throw new Error('PPT 背景颜色需使用 #RRGGBB 格式。');
  if (!Number.isFinite(lineWidth) || lineWidth < 0 || lineWidth > 12) throw new Error('横线粗细需为 0–12 px。');
  if (groups.some(group => group.images.some(image => !/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(image.dataUrl)))) throw new Error('PPT 孔图需要 PNG data URL。');

  const size = 320, gap = 38, top = title ? 110 : 65;
  const width = groups.length * (size + gap) + gap;
  const height = top + Math.max(...groups.map(group => group.images.length)) * (size + gap);
  const inch = Math.min(1 / 96, 50 / Math.max(width, height));
  const color = canvasColor.slice(1).toUpperCase();
  const rgb = color.match(/../g)!.map(value => parseInt(value, 16));
  const ink = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 < 128 ? 'FFFFFF' : '111111';
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'COLONY', width: width * inch, height: height * inch });
  pptx.layout = 'COLONY';
  pptx.author = 'FluoroScope'; pptx.title = title || '平板克隆';
  pptx.subject = 'Editable colony formation layout';
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' };
  const slide = pptx.addSlide(); slide.background = { color };
  if (notes) slide.addNotes(notes);
  const text = (value: string, x: number, baseline: number, w: number, fontSize: number, name: string) => {
    slide.addText(value, { x: x * inch, y: (baseline - fontSize) * inch, w: w * inch, h: fontSize * 1.2 * inch,
      fontFace: 'Arial', fontSize: fontSize * inch * 72, bold: true, color: ink,
      align: 'center', valign: 'top', margin: 0, breakLine: false, wrap: false, fit: 'shrink',
      paraSpaceAfter: 0, paraSpaceBefore: 0, isTextBox: true, objectName: name });
  };
  if (title) {
    text(title, gap, 38, width - gap * 2, 32, 'Title');
    if (lineWidth > 0) slide.addShape(pptx.ShapeType.line, { x: gap * inch, y: 52 * inch,
      w: (width - gap * 2) * inch, h: 0, line: { color: '000000', width: lineWidth * inch * 72 }, objectName: 'Title line' });
  }
  groups.forEach((group, col) => {
    const x = gap + col * (size + gap);
    text(group.name, x, top - 18, size, 26, `Group ${col + 1}`);
    group.images.forEach((image, row) => slide.addImage({ data: image.dataUrl,
      x: x * inch, y: (top + row * (size + gap)) * inch, w: size * inch, h: size * inch,
      altText: image.name, objectName: image.name }));
  });
  const output = await pptx.write({ outputType: 'arraybuffer', compression: true });
  if (!(output instanceof ArrayBuffer)) throw new Error('PPT 文件生成失败。');
  return output;
}
