import { thumbnailTimestamp } from './ffmpeg.service';

describe('thumbnailTimestamp', () => {
  it('should pick the frame at 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBe(12);
  });

  it.each([null, 0, -1])('should fall back to 0 when duration is %p', (d) => {
    expect(thumbnailTimestamp(d)).toBe(0);
  });
});
