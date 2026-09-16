export function nextEnabledChannel<T extends { id: string; enabled: boolean }>(channels: readonly T[], currentId: string) {
  const enabled = channels.filter(channel => channel.enabled);
  return enabled[enabled.findIndex(channel => channel.id === currentId) + 1] ?? null;
}
