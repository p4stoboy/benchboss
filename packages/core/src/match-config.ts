import {
  type GameManifest,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  type ValidationResult,
  isPlainDataRecord,
  validateMetering,
  validateSchema,
  validateTimingPolicy,
} from "@benchboss/protocol";

export interface MatchConfigAdmission {
  gameId?: string;
  manifest?: Pick<
    GameManifest,
    "id" | "revision" | "protocolVersion" | "seatCounts" | "rulesSchema"
  >;
  hasHostEventHandler?: boolean;
}

const invalid = (reason: string): ValidationResult => ({ ok: false, reason });
const named = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exactFields = (value: Record<string, unknown>, fields: string[]): boolean =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));

function isDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length + 1 &&
    keys.every((key) => {
      if (key === "length") return true;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
    })
  );
}

// Check descriptors before reading nested rules so admission never invokes accessors.
function isJsonData(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!isDataArray(value) && !isPlainDataRecord(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJsonData(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

/** Validate caller data before cloning it or invoking any game capability. */
export function validateMatchConfig(
  value: unknown,
  admission: MatchConfigAdmission = {},
): ValidationResult {
  if (
    !isPlainDataRecord(value) ||
    !exactFields(value, [
      "matchId",
      "gameId",
      "seats",
      "rules",
      "identity",
      "timing",
      "resources",
      "metering",
    ])
  )
    return invalid("invalid match config fields");
  const identity = value.identity;
  if (
    !isPlainDataRecord(identity) ||
    !exactFields(identity, ["protocolVersion", "runtimeVersion", "gameId", "revision"]) ||
    identity.protocolVersion !== PROTOCOL_VERSION ||
    identity.runtimeVersion !== RUNTIME_VERSION ||
    !named(value.gameId) ||
    identity.gameId !== value.gameId ||
    !named(identity.revision)
  )
    return invalid("unsupported match identity");
  if (!named(value.matchId)) return invalid("invalid match id");
  if (
    !isDataArray(value.seats) ||
    value.seats.length === 0 ||
    Object.values(value.seats).some(
      (seat) => typeof seat !== "string" || !/^seat:(0|[1-9][0-9]*)$/.test(seat),
    ) ||
    new Set(Object.values(value.seats)).size !== value.seats.length
  )
    return invalid("invalid match seats");
  if (!isPlainDataRecord(value.rules) || !isJsonData(value.rules))
    return invalid("invalid match rules");
  const timing = validateTimingPolicy(value.timing);
  if (!timing.ok) return timing;
  const metering = validateMetering(value.metering, value.resources);
  if (!metering.ok) return metering;
  if (
    admission.hasHostEventHandler === false &&
    (value.timing as { playerTotalMs: number | null }).playerTotalMs !== null
  )
    return invalid("player total time requires onHostEvent");
  if (admission.gameId !== undefined && admission.gameId !== value.gameId)
    return invalid("game identity mismatch");
  const manifest = admission.manifest;
  if (manifest) {
    if (manifest.id !== value.gameId || manifest.protocolVersion !== identity.protocolVersion)
      return invalid("plugin identity mismatch");
    if (manifest.revision !== identity.revision) return invalid("plugin identity mismatch");
    if (!manifest.seatCounts.includes(value.seats.length)) return invalid("invalid match seats");
    if (!validateSchema(manifest.rulesSchema, value.rules).ok)
      return invalid("invalid match rules");
  }
  return { ok: true };
}
