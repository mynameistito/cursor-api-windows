/** Bitwise helpers without using JavaScript bitwise operators. */

/**
 * Convert a number to an unsigned 32-bit integer.
 * @param value - The number to convert.
 * @returns The converted unsigned integer.
 */
export const toUint32 = function toUint32(value: number): number {
  const truncated = Math.trunc(value);
  if (truncated < 0) {
    return truncated + 4_294_967_296;
  }
  return truncated % 4_294_967_296;
};

const bitAnd = function bitAnd(left: number, right: number): number {
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

/**
 * Calculate the bitwise exclusive OR of two numbers.
 * @param left - The first operand.
 * @param right - The second operand.
 * @returns The exclusive OR of the operands.
 */
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

const leftShift = function leftShift(value: number, bits: number): number {
  return Math.trunc(value) * 2 ** bits;
};

/**
 * Encode a protobuf field number and wire type as a tag.
 * @param fieldNumber - The protobuf field number.
 * @param wireType - The protobuf wire type.
 * @returns The encoded tag.
 */
export const protoTag = function protoTag(
  fieldNumber: number,
  wireType: number
): number {
  return leftShift(fieldNumber, 3) + wireType;
};

/**
 * Extract a protobuf field number from its tag.
 * @param tag - The encoded protobuf tag.
 * @returns The field number.
 */
export const protoFieldNumber = function protoFieldNumber(tag: number): number {
  return Math.floor(tag / 8);
};

/**
 * Extract the wire type from a protobuf tag.
 * @param tag - The encoded protobuf tag.
 * @returns The wire type.
 */
export const protoWireType = function protoWireType(tag: number): number {
  return tag % 8;
};

/**
 * Check whether all bits in a mask are set in a flag value.
 * @param flags - The flag value to inspect.
 * @param mask - The bits that must be set.
 * @returns Whether every bit in the mask is set.
 */
export const connectFlagHas = function connectFlagHas(
  flags: number,
  mask: number
): boolean {
  return bitAnd(flags, mask) === mask;
};

/**
 * Return the lowest seven bits of a byte.
 * @param byte - The byte to inspect.
 * @returns Its lowest seven bits.
 */
export const low7Bits = function low7Bits(byte: number): number {
  return byte % 128;
};

/**
 * Check whether a byte has its high bit set.
 * @param byte - The byte to inspect.
 * @returns Whether the high bit is set.
 */
export const hasHighBit = function hasHighBit(byte: number): boolean {
  return byte >= 128;
};

/**
 * Calculate the contribution of a byte at a varint bit offset.
 * @param byte - The encoded byte.
 * @param shift - The bit offset for this contribution.
 * @returns The decoded numeric contribution.
 */
export const varintContribution = function varintContribution(
  byte: number,
  shift: number
): number {
  return low7Bits(byte) * 2 ** shift;
};
