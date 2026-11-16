import { TextDecoder } from 'util';

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeStrictUtf8(value: Buffer): string {
  if (
    value.length >= 3 &&
    value[0] === 0xef &&
    value[1] === 0xbb &&
    value[2] === 0xbf
  ) {
    throw new Error('UTF-8 byte-order marks are not permitted');
  }
  return strictUtf8Decoder.decode(value);
}
