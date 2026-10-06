import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import { MediaProbeError, NoVideoStreamError } from './ffmpeg.errors';

export const FFMPEG_DEFAULT_TIMEOUT_MS = 120_000;
export const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_POSITION = 0.1;

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  raw: Record<string, unknown>;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}

interface RunOptions {
  timeoutMs?: number;
}

/** Timestamp of the frame used as thumbnail: 10% of the duration, or 0. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return durationSeconds * THUMBNAIL_POSITION;
}

@Injectable()
export class FfmpegService {
  /** `input` may be a local path or an HTTP(S) URL (read with Range requests). */
  async probe(input: string, options: RunOptions = {}): Promise<ProbeResult> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      options,
    );

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch {
      throw new MediaProbeError('ffprobe returned invalid JSON');
    }

    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    if (!video) throw new NoVideoStreamError();

    const duration = Number(parsed.format?.duration);
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      width: video.width ?? null,
      height: video.height ?? null,
      videoCodec: video.codec_name ?? null,
      raw: parsed as Record<string, unknown>,
    };
  }

  /** Renders one JPEG frame at `atSeconds`, scaled down to at most 1280px wide. */
  extractThumbnail(
    input: string,
    atSeconds: number,
    options: RunOptions = {},
  ): Promise<Buffer> {
    return this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      options,
    ).then((jpeg) => {
      if (jpeg.length === 0) {
        throw new MediaProbeError('ffmpeg produced no thumbnail frame');
      }
      return jpeg;
    });
  }

  private run(
    command: string,
    args: string[],
    { timeoutMs = FFMPEG_DEFAULT_TIMEOUT_MS }: RunOptions,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new MediaProbeError(`${command} failed to start: ${err.message}`),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new MediaProbeError(`${command} timed out after ${timeoutMs}ms`),
          );
          return;
        }
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(
            new MediaProbeError(
              `${command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdout));
      });
    });
  }
}
