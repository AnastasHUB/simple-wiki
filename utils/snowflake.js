const CUSTOM_EPOCH = BigInt(1704067200000); // 2024-01-01T00:00:00Z
let lastTimestamp = BigInt(0);
let sequence = BigInt(0);
const MAX_SEQUENCE = BigInt(4095); // 12 bits

export function generateSnowflake() {
  let timestamp = BigInt(Date.now());
  if (timestamp === lastTimestamp) {
    sequence = (sequence + BigInt(1)) & MAX_SEQUENCE;
    if (sequence === BigInt(0)) {
      // wait for next millisecond
      while (timestamp <= lastTimestamp) {
        timestamp = BigInt(Date.now());
      }
    }
  } else {
    sequence = BigInt(0);
  }
  lastTimestamp = timestamp;
  const timeComponent = (timestamp - CUSTOM_EPOCH) << BigInt(22);
  const randomBits = BigInt(Math.floor(Math.random() * 1024)); // 10 bits of randomness
  const snowflake = timeComponent | (randomBits << BigInt(12)) | sequence;
  return snowflake.toString();
}

export function parseSnowflake(value) {
  try {
    const snowflake = BigInt(value);
    const timestamp = Number((snowflake >> BigInt(22)) + CUSTOM_EPOCH);
    return new Date(timestamp);
  } catch (_err) {
    return null;
  }
}
