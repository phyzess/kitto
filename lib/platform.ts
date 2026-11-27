export type PlatformDirectory = 'macos' | 'linux';

export function platformOverlay(platform: string = process.platform): PlatformDirectory | null {
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  if (platform === 'linux') return 'linux';
  return null;
}
