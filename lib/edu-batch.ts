import type { LoadedImage } from './image';
import type { EduParameters } from './edu';

export type ChannelReference = { channels: Array<{ id: string; label: string }>; nucleus: number; edu: number; confirmed: boolean };
export function resolveBatchChannels(image: Pick<LoadedImage, 'channels'>, reference: ChannelReference): [number, number] {
  const find = (color: string) => image.channels.flatMap((channel, index) => channel.id === color || channel.sourceColor === color ? [index] : []);
  const blue = find('blue'), red = find('red');
  if (blue.length === 1 && red.length === 1 && blue[0] !== red[0]) return [blue[0], red[0]];
  if (blue.length || red.length) throw new Error('蓝/红来源不唯一，请单图指定通道。');
  if (!reference.confirmed) throw new Error('灰度通道尚未确认对应关系，请先在通道设置确认。');
  const same = image.channels.length === reference.channels.length && image.channels.every((channel, index) => channel.id === reference.channels[index].id && channel.label === reference.channels[index].label);
  if (!same || reference.nucleus === reference.edu || !image.channels[reference.nucleus] || !image.channels[reference.edu]) throw new Error('灰度通道标识或标签与已确认图不同，请单图指定。');
  return [reference.nucleus, reference.edu];
}
export function nativeEduParameters(image: Pick<LoadedImage, 'channels'>, indices: [number, number], parameters: EduParameters): EduParameters {
  return { ...parameters, nucleusThreshold: parameters.nucleusThreshold / 255 * image.channels[indices[0]].maxValue, eduThreshold: parameters.eduThreshold / 255 * image.channels[indices[1]].maxValue };
}
export function batchRecordAction(existing: { signature: string; reviewed: boolean; revisions: Record<number, unknown> } | undefined, signature: string): 'compute' | 'reuse' | 'protect' {
  if (!existing) return 'compute';
  if (existing.signature === signature) return 'reuse';
  return existing.reviewed || Object.keys(existing.revisions).length > 0 ? 'protect' : 'compute';
}
