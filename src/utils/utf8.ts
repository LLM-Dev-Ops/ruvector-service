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

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
