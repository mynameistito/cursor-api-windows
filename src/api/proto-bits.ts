/** Bitwise helpers without using JS bitwise operators (oxlint no-bitwise). */

export const toUint32 = function toUint32(value: number): number {
  const truncated = Math.trunc(value);
  if (truncated < 0) {
    return truncated + 4_294_967_296;
  }
  return truncated % 4_294_967_296;
};

export const bitAnd = function bitAnd(left: number, right: number): number {
  let a = Math.trunc(left);
  let b = Math.trunc(right);
  let result = 0;
  let place = 1;
  while (a > 0 || b > 0) {
    if (a % 2 === 1 && b % 2 === 1) {
      result += place;
    }
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    place *= 2;
  }
  return result;
};

export const bitOr = function bitOr(left: number, right: number): number {
  let a = Math.trunc(left);
  let b = Math.trunc(right);
  let result = 0;
  let place = 1;
  while (a > 0 || b > 0) {
    if (a % 2 === 1 || b % 2 === 1) {
      result += place;
    }
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    place *= 2;
  }
  return result;
};

export const bitXor = function bitXor(left: number, right: number): number {
  let a = Math.trunc(left);
  let b = Math.trunc(right);
  let result = 0;
  let place = 1;
  while (a > 0 || b > 0) {
    if (a % 2 !== b % 2) {
      result += place;
    }
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    place *= 2;
  }
  return result;
};

export const leftShift = function leftShift(
  value: number,
  bits: number
): number {
  return Math.trunc(value) * 2 ** bits;
};

export const unsignedRightShift = function unsignedRightShift(
  value: number,
  bits: number
): number {
  return Math.floor(toUint32(value) / 2 ** bits);
};

export const protoTag = function protoTag(
  fieldNumber: number,
  wireType: number
): number {
  return leftShift(fieldNumber, 3) + wireType;
};

export const protoFieldNumber = function protoFieldNumber(tag: number): number {
  return Math.floor(tag / 8);
};

export const protoWireType = function protoWireType(tag: number): number {
  return tag % 8;
};

export const connectFlagHas = function connectFlagHas(
  flags: number,
  mask: number
): boolean {
  return bitAnd(flags, mask) === mask;
};

export const low7Bits = function low7Bits(byte: number): number {
  return byte % 128;
};

export const hasHighBit = function hasHighBit(byte: number): boolean {
  return byte >= 128;
};

export const varintContribution = function varintContribution(
  byte: number,
  shift: number
): number {
  return low7Bits(byte) * 2 ** shift;
};
