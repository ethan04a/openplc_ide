type SerializedMap = { __openplcType: 'Map'; entries: [unknown, unknown][] }
type SerializedUint8Array = { __openplcType: 'Uint8Array'; data: number[] }

export function serializeForTransport(value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __openplcType: 'Map',
      entries: Array.from(value.entries()).map(([key, entryValue]) => [
        serializeForTransport(key),
        serializeForTransport(entryValue),
      ]),
    } satisfies SerializedMap
  }

  if (value instanceof Uint8Array) {
    return { __openplcType: 'Uint8Array', data: Array.from(value) } satisfies SerializedUint8Array
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeForTransport(item))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, serializeForTransport(entryValue)]),
    )
  }

  return value
}

export function deserializeFromTransport(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeFromTransport(item))
  }

  const record = value as Record<string, unknown>

  if (record.__openplcType === 'Map' && Array.isArray(record.entries)) {
    return new Map(
      (record.entries as [unknown, unknown][]).map(([key, entryValue]) => [
        deserializeFromTransport(key),
        deserializeFromTransport(entryValue),
      ]),
    )
  }

  if (record.__openplcType === 'Uint8Array' && Array.isArray(record.data)) {
    return Uint8Array.from(record.data as number[])
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entryValue]) => [key, deserializeFromTransport(entryValue)]),
  )
}
