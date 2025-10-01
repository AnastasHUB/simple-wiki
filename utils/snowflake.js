const CUSTOM_EPOCH = BigInt(1704067200000); // 2024-01-01T00:00:00Z
const SNOWFLAKE_TIME_SHIFT = BigInt(22);
const RANDOM_BIT_LENGTH = 10;
const SEQUENCE_BIT_LENGTH = 12;
const TIME_BIT_LENGTH = 64 - RANDOM_BIT_LENGTH - SEQUENCE_BIT_LENGTH;
const RANDOM_SHIFT = BigInt(SEQUENCE_BIT_LENGTH);
const RANDOM_MASK = (BigInt(1) << BigInt(RANDOM_BIT_LENGTH)) - BigInt(1);
const SEQUENCE_MASK = (BigInt(1) << BigInt(SEQUENCE_BIT_LENGTH)) - BigInt(1);

let lastTimestamp = BigInt(0);
let sequence = BigInt(0);
const MAX_SEQUENCE = SEQUENCE_MASK;

export const SNOWFLAKE_EPOCH_MS = Number(CUSTOM_EPOCH);
export const SNOWFLAKE_STRUCTURE = Object.freeze({
  totalBits: 64,
  timeBits: TIME_BIT_LENGTH,
  randomBits: RANDOM_BIT_LENGTH,
  sequenceBits: SEQUENCE_BIT_LENGTH,
});

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
  const timeComponent = (timestamp - CUSTOM_EPOCH) << SNOWFLAKE_TIME_SHIFT;
  const randomBits = BigInt(Math.floor(Math.random() * 1024)); // 10 bits of randomness
  const snowflake = timeComponent | (randomBits << RANDOM_SHIFT) | sequence;
  return snowflake.toString();
}

function toPaddedBinary(value, bitLength) {
  const binary = BigInt(value).toString(2);
  return binary.padStart(bitLength, "0");
}

export function decomposeSnowflake(value, { now = Date.now() } = {}) {
  try {
    const snowflake = BigInt(value);
    const timeComponent = snowflake >> SNOWFLAKE_TIME_SHIFT;
    const timestampMs = Number(timeComponent + CUSTOM_EPOCH);
    const createdAt = new Date(timestampMs);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    const randomComponent = Number((snowflake >> RANDOM_SHIFT) & RANDOM_MASK);
    const sequenceComponent = Number(snowflake & SEQUENCE_MASK);
    return {
      value: snowflake.toString(),
      hex: snowflake.toString(16),
      binary: snowflake
        .toString(2)
        .padStart(SNOWFLAKE_STRUCTURE.totalBits, "0"),
      epochMs: SNOWFLAKE_EPOCH_MS,
      timestamp: {
        milliseconds: timestampMs,
        iso: createdAt.toISOString(),
        sinceEpochMs: Number(timeComponent),
        binary: toPaddedBinary(timeComponent, TIME_BIT_LENGTH),
      },
      random: {
        value: randomComponent,
        bits: RANDOM_BIT_LENGTH,
        binary: toPaddedBinary(randomComponent, RANDOM_BIT_LENGTH),
      },
      sequence: {
        value: sequenceComponent,
        bits: SEQUENCE_BIT_LENGTH,
        binary: toPaddedBinary(sequenceComponent, SEQUENCE_BIT_LENGTH),
      },
      ageMs: now - timestampMs,
    };
  } catch (_err) {
    return null;
  }
}

export function parseSnowflake(value) {
  const parts = decomposeSnowflake(value);
  if (!parts) {
    return null;
  }
  return new Date(parts.timestamp.milliseconds);
}
