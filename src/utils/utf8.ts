import { TextDecoder } from 'util';

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeStrictUtf8(value: Buffer): string {
  return strictUtf8Decoder.decode(value);
}
