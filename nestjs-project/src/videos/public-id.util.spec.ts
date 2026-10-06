import {
  generatePublicId,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PATTERN,
} from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 base62 characters', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(PUBLIC_ID_PATTERN);
  });

  it('should return distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, generatePublicId));

    expect(ids.size).toBe(1000);
  });
});
