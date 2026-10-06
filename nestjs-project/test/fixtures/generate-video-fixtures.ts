import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface VideoFixtures {
  dir: string;
  /** H.264/AAC MP4, 640x360, 3 seconds. */
  mp4: string;
  /** VP9/Opus WebM, 640x360, 3 seconds. */
  webm: string;
  /** MP4 container with an AAC audio stream and no video stream. */
  audioOnly: string;
  /** Random bytes with an .mp4 name — not decodable media. */
  corrupted: string;
  cleanup: () => void;
}

const ffmpeg = (args: string[]) =>
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

/**
 * Generates an H.264 MP4 of `durationSeconds` with a constant video bitrate.
 * Use a high bitrate to reach a target size for multipart uploads
 * (size ≈ bitrate × duration / 8).
 */
export function generateMp4(
  path: string,
  {
    durationSeconds = 3,
    bitrate,
  }: { durationSeconds?: number; bitrate?: string } = {},
): string {
  const rate = bitrate
    ? [
        '-b:v',
        bitrate,
        '-minrate',
        bitrate,
        '-maxrate',
        bitrate,
        '-bufsize',
        bitrate,
        // CBR with filler data so the output reaches the target size.
        '-x264-params',
        'nal-hrd=cbr',
      ]
    : [];
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=640x360:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...rate,
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    path,
  ]);
  return path;
}

/** Generates the media fixtures in a fresh temp directory (never versioned). */
export function generateVideoFixtures(): VideoFixtures {
  const dir = mkdtempSync(join(tmpdir(), 'streamtube-fixtures-'));
  const mp4 = generateMp4(join(dir, 'clip.mp4'));
  const webm = join(dir, 'clip.webm');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=640x360:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-shortest',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-c:a',
    'libopus',
    webm,
  ]);
  const audioOnly = join(dir, 'audio-only.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:a',
    'aac',
    audioOnly,
  ]);
  const corrupted = join(dir, 'corrupted.mp4');
  writeFileSync(corrupted, Buffer.from('not a video file at all'));

  return {
    dir,
    mp4,
    webm,
    audioOnly,
    corrupted,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
