/** The media was read, but it has no video stream (e.g. audio-only file). */
export class NoVideoStreamError extends Error {
  constructor() {
    super('Media has no video stream');
    this.name = 'NoVideoStreamError';
  }
}

/** ffprobe/ffmpeg failed: non-zero exit, unreadable output or timeout. */
export class MediaProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProbeError';
  }
}
