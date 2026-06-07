export function decodeUtf8Prefix(buffer, byteLength) {
  let end = Math.max(0, Math.min(byteLength, buffer.byteLength));
  if (end <= 0) {
    return "";
  }
  let sequenceStart = end - 1;
  while (sequenceStart >= 0 && (buffer[sequenceStart] & 0b1100_0000) === 0b1000_0000) {
    sequenceStart -= 1;
  }
  if (sequenceStart >= 0) {
    const expectedLength = utf8SequenceLength(buffer[sequenceStart]);
    if (expectedLength > 1 && end - sequenceStart < expectedLength) {
      end = sequenceStart;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}

function utf8SequenceLength(byte) {
  if ((byte & 0b1000_0000) === 0) {
    return 1;
  }
  if ((byte & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((byte & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((byte & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}
