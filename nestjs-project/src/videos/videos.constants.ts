export const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const;

export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const originalKey = (videoId: string): string =>
  `videos/${videoId}/original`;
