import { randomInt } from 'crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_PATTERN = /^[0-9A-Za-z]{11}$/;

export function generatePublicId(): string {
  let id = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }
  return id;
}
