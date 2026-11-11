import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelData } from '../lib/analysis.ts';
import {
  analyzeCicPair, cicProjectJson, cicRecordsCsv, cicSummaryCsv, parseCicProjectJson,
  summarizeCicExperiments, upsertCicRecord, validateCicPolygon, type CicMetadata, type CicPolygon,
} from '../lib/cic-intensity.ts';

const rect = (x: number,y: number,r: number,b: number): CicPolygon => [{x,y},{x:r,y},{x:r,y:b},{x,y:b}];
function makeInput() {
  const width = 10, height = 8;
  const data = new Uint16Array(width*height).fill(10);
  for (const [x,y,v] of [[2,2,65535],[3,2,20],[2,3,22],[3,3,24],[8,0,1],[9,0,3]]) data[y*width+x]=v;
  const channel: ChannelData = {id:'c1',label:'PIEZO1',data,bitDepth:16,integer:true,maxValue:65535};
  const metadata: CicMetadata = {imageHash:'abc',fileName:'f.tif',channelId:'c1',channelLabel:'PIEZO1',marker:'PIEZO1',
    experimentId:'exp1',fieldId:'f1',pairId:'1',innerLabel:'shHER2',outerLabel:'WT'};
  const rois = {inner:rect(2,2,4,4),outer:rect(0,0,6,6),background:rect(8,0,10,1),
    innerExclusions:[rect(2,2,3,3)],outerExclusions:[rect(1,1,5,5),rect(5,0,6,1)]};
  return {width,height,channel,metadata,rois};
}
test('nested cells: subtract the complete inner from the host and preserve compartment-specific exclusions', () => {
  const input = makeInput();
  const original = input.channel.data.slice();
  const result = analyzeCicPair(input);
  assert.equal(result.background.mean,2);
  assert.equal(result.background.sd,Math.sqrt(2));
  assert.equal(result.inner.pixels,3);
  assert.equal(result.inner.mean,22);
  assert.equal(result.inner.sd,2);
  assert.equal(result.inner.correctedMean,20);
  assert.equal(result.inner.ctcf,60);
  assert.equal(result.outer.pixels,19);
  assert.equal(result.outer.correctedMean,8);
  assert.equal(result.outer.ctcf,152);
  assert.equal(result.difference,12);
  assert.equal(result.ratio,2.5);
  assert.deepEqual(input.channel.data,original);
  input.rois.innerExclusions = [];
  input.rois.outerExclusions = [];
  const unmasked = analyzeCicPair(input);
  assert.equal(unmasked.inner.saturationPct,25);
  assert.equal(unmasked.outer.saturationPct,0);
  assert.equal(unmasked.outer.pixels,32);
  assert.equal(unmasked.outer.correctedMean,8);
});
test('negative and zero corrected intensities remain numeric, and unknown or undefined ratios remain empty', () => {
  const input = makeInput();
  input.channel = {...input.channel,integer:false,data:new Float32Array(80).fill(10)};
  input.channel.data[8] = 15; input.channel.data[9] = 15;
  let r = analyzeCicPair(input);
  assert.equal(r.inner.correctedMean,-5);
  assert.equal(r.inner.ctcf,-15);
  assert.equal(r.ratio,null);
  assert.equal(r.inner.saturationPct,null);
  input.channel.data[8] = 10; input.channel.data[9] = 10;
  r = analyzeCicPair(input);
  assert.equal(r.outer.correctedMean,0);
  assert.equal(r.ratio,null);
  input.channel.data[23] = NaN;
  assert.throws(() => analyzeCicPair(input),/非有限/);
});
test('fractional ROI membership uses original pixel centers', () => {
  const input = makeInput();
  input.rois.inner = rect(2.55,2.1,3.65,3.45);
  input.rois.innerExclusions = [];
  const r = analyzeCicPair(input);
  assert.equal(r.inner.pixels,1);
  assert.equal(r.inner.mean,20);
});
test('reject background overlap, self-crossings, empty masks, out-of-image and concave-host escape', () => {
  const input = makeInput();
  assert.throws(() => analyzeCicPair({...input,rois:{...input.rois,background:rect(5,5,8,8)}}),/背景/);
  assert.throws(() => validateCicPolygon([{x:1,y:1},{x:4,y:4},{x:1,y:4},{x:4,y:1}],10,8),/自交/);
  assert.throws(() => validateCicPolygon(rect(-1,0,2,2),10,8),/越界/);
  assert.throws(() => analyzeCicPair({...input,rois:{...input.rois,innerExclusions:[input.rois.inner]}}),/没有可用像素/);
  assert.throws(() => analyzeCicPair({...input,rois:{...input.rois,innerExclusions:[rect(2.01,2.01,2.05,2.05)]}}),/像素中心/);
  const concave = [[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]].map(([x,y])=>({x,y}));
  assert.throws(() => analyzeCicPair({...input,rois:{...input.rois,outer:concave,inner:rect(1,1,5,4),innerExclusions:[],outerExclusions:[]}}),/完全位于/);
});
test('keep paired rows and independent-experiment summaries separate; safely quote metadata for CSV', () => {
  const input = makeInput(), first = analyzeCicPair(input);
  const change = (meta: Partial<CicMetadata>) => analyzeCicPair({...input,metadata:{...input.metadata,...meta}});
  const second = change({fieldId:'f2',imageHash:'b',pairId:'2'}), other = change({experimentId:'exp2',imageHash:'c'});
  const differentMarker = change({marker:'CAV1',imageHash:'d'}), rename = change({fileName:'=CMD("file")'});
  const rows = upsertCicRecord([first,second,other,differentMarker],rename);
  assert.equal(rows.length,4);
  const summary = summarizeCicExperiments(rows);
  assert.equal(summary.length,3);
  assert.deepEqual([summary[0].pairCount,summary[0].fieldCount,summary[0].innerMean,summary[0].outerMean,summary[0].difference],[2,2,20,8,12]);
  assert.match(cicRecordsCsv(rows),/"'=CMD\(""file""\)"/);
  assert.match(cicSummaryCsv(summary),/"pairCount","fieldCount"/);
});
test('summarize matched TIFF fields as one experiment when displayed channel names are field-specific', () => {
  const input = makeInput();
  const fields = ['field1','field2'].map(fieldId => {
    const fileName = fieldId + '_PIEZO1.tif';
    return analyzeCicPair({...input, metadata: {...input.metadata, fieldId, fileName, imageHash:fieldId, channelLabel:fileName}});
  });
  const summary = summarizeCicExperiments(fields);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].fieldCount, 2);
  assert.equal(summary[0].pairCount, 2);
  assert.equal(summary[0].channelLabel, 'PIEZO1');
  for (const r of fields) assert.ok(cicRecordsCsv(fields).includes(r.metadata.channelLabel));
});
test('project JSON round-trips ROI and provenance and rejects malformed or inconsistent results', () => {
  const input = makeInput();
  input.metadata.provenance={sourceFiles:['f.tif'],format:'TIFF',pageCount:1,displayOnly:false,warnings:[],bitDepth:16,maxValue:65535,pixelSizeUm:null};
  const first = analyzeCicPair(input), saved = cicProjectJson([first]);
  assert.deepEqual(parseCicProjectJson(saved),[first]);
  assert.ok(!saved.includes('"data"'));
  const obj = JSON.parse(saved);
  obj.records[0].outer.ctcf++;
  assert.throws(() => parseCicProjectJson(JSON.stringify(obj)),/不一致/);
  obj.records[0].outer.ctcf = null;
  assert.throws(() => parseCicProjectJson(JSON.stringify(obj)),/无效/);
  assert.throws(() => parseCicProjectJson('{"records":[]}'),/项目/);
});
