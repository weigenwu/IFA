import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTiffDescription } from '../lib/image.ts';

test('OME TIFF terminator padding is removed without changing metadata or hiding internal invalid XML', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><OME><Image><Pixels SizeC="3" PhysicalSizeX="0.325" PhysicalSizeXUnit="µm"><Channel Name="DAPI"/><Channel Name="FITC"/><Channel Name="CY5"/></Pixels></Image></OME>';
  assert.equal(normalizeTiffDescription(xml + '\0'), xml);
  assert.equal(normalizeTiffDescription(xml + '\0\0\0'), xml);
  assert.equal(normalizeTiffDescription(xml), xml);
  const internallyInvalid = xml.replace('DAPI', 'DA\0PI');
  assert.equal(normalizeTiffDescription(internallyInvalid + '\0'), internallyInvalid);
  assert.equal(normalizeTiffDescription('ordinary TIFF description\0'), 'ordinary TIFF description');
});
