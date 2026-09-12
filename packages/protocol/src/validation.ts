import { CAPABILITY_FEATURES } from "./contracts";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const valid: ValidationResult = { ok: true };
const invalid = (reason: string): ValidationResult => ({ ok: false, reason });
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isDuration = (value: unknown): value is number =>
  isAmount(value) && Number.isSafeInteger(value) && value > 0;
const isNullableAmount = (value: unknown): boolean => value === null || isAmount(value);
const isSafeKey = (key: string): boolean =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";

export function isResourceName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value) && isSafeKey(value);
}

export function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
  });
}

const isRecord = isPlainDataRecord;

export function isResourceAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasFields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((key) => own(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isName);
}

function isBalances(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, amount]) => isResourceName(name) && isResourceAmount(amount),
    )
  );
}

export function validateTimingPolicy(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !hasFields(value, ["playerTotalMs", "decisionLimitMs", "phaseLimits", "clockVisibility"])
  )
    return invalid("invalid timing policy fields");
  for (const key of ["playerTotalMs", "decisionLimitMs"]) {
    if (value[key] !== null && !isDuration(value[key]))
      return invalid(`${key} must be null or a positive safe-integer duration`);
  }
  if (value.clockVisibility !== "private" && value.clockVisibility !== "public")
    return invalid("invalid clock visibility");
  if (!isRecord(value.phaseLimits)) return invalid("invalid phase limits");
  for (const [phase, policy] of Object.entries(value.phaseLimits)) {
    if (
      !isName(phase) ||
      !isSafeKey(phase) ||
      !isRecord(policy) ||
      !hasFields(policy, ["durationMs", "close"]) ||
      !isDuration(policy.durationMs) ||
      (policy.close !== "deadline" && policy.close !== "ready_or_deadline")
    )
      return invalid("invalid phase limit");
  }
  return valid;
}

export function validateResources(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("resources must be a record");
  for (const [name, resource] of Object.entries(value)) {
    if (!isResourceName(name)) return invalid("invalid resource name");
    if (!isRecord(resource) || !hasFields(resource, ["amount", "reset", "visibility"]))
      return invalid(`invalid resource definition: ${name}`);
    if (!isResourceAmount(resource.amount)) return invalid(`invalid resource amount: ${name}`);
    if (resource.reset !== "match" && resource.reset !== "phase" && resource.reset !== "decision")
      return invalid(`invalid resource reset: ${name}`);
    if (resource.visibility !== "private" && resource.visibility !== "public")
      return invalid(`invalid resource visibility: ${name}`);
  }
  return valid;
}

export function validateMetering(value: unknown, resources: unknown): ValidationResult {
  const definitions = validateResources(resources);
  if (!definitions.ok) return definitions;
  if (
    !isRecord(resources) ||
    !isRecord(value) ||
    !hasFields(value, [], ["action", "invalidAction"])
  )
    return invalid("invalid metering fields");
  for (const reference of Object.values(value)) {
    if (
      !isRecord(reference) ||
      !hasFields(reference, ["resource", "cost"]) ||
      !isResourceName(reference.resource) ||
      !own(resources, reference.resource) ||
      !isResourceAmount(reference.cost)
    )
      return invalid("metering requires a declared resource and a nonnegative safe-integer cost");
  }
  return valid;
}

export function validateParticipation(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("invalid participation");
  if ((value.status === "acting" || value.status === "waiting") && hasFields(value, ["status"]))
    return valid;
  if (value.status === "finished" && hasFields(value, ["status", "reason"]) && isName(value.reason))
    return valid;
  return invalid("invalid participation status or fields");
}

export function validateClockSnapshot(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "sampledAt",
      "remainingMs",
      "running",
      "deadline",
      "phaseId",
      "phaseDeadline",
    ]) ||
    !isAmount(value.sampledAt) ||
    !isNullableAmount(value.remainingMs) ||
    typeof value.running !== "boolean" ||
    !isNullableAmount(value.deadline) ||
    !isName(value.phaseId) ||
    !isNullableAmount(value.phaseDeadline)
  )
    return invalid("invalid clock snapshot");
  return valid;
}

export function validateHostEvent(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !hasFields(value, ["kind", "seats", "phaseId", "at"]) ||
    typeof value.kind !== "string" ||
    ![
      "decision_expired",
      "player_time_exhausted",
      "phase_expired",
      "invalid_retries_exhausted",
    ].includes(value.kind) ||
    !isStringArray(value.seats) ||
    !isName(value.phaseId) ||
    !isAmount(value.at)
  )
    return invalid("invalid host event");
  if (value.seats.some((seat, index, seats) => seats.indexOf(seat) !== index))
    return invalid("duplicate host event seat");
  return valid;
}

export function validateObservation(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "protocolVersion",
      "matchId",
      "phase",
      "phaseId",
      "seat",
      "publicState",
      "privateState",
      "legalTools",
      "decisionId",
      "actionOffers",
      "resources",
      "participation",
      "clock",
    ])
  )
    return invalid("invalid observation fields");
  if (
    value.protocolVersion !== 1 ||
    ![value.matchId, value.phase, value.phaseId, value.seat, value.decisionId].every(isName) ||
    !isRecord(value.publicState) ||
    !isRecord(value.privateState) ||
    !isStringArray(value.legalTools) ||
    !isBalances(value.resources)
  )
    return invalid("invalid observation identity or accounting");
  if (
    !validateParticipation(value.participation).ok ||
    !validateClockSnapshot(value.clock).ok ||
    !isRecord(value.clock) ||
    value.clock.phaseId !== value.phaseId
  )
    return invalid("invalid observation participation or clock");
  if (
    !Array.isArray(value.actionOffers) ||
    !value.actionOffers.every(
      (offer: unknown) =>
        isRecord(offer) &&
        hasFields(offer, ["tool", "phase", "description", "jsonSchema"]) &&
        isName(offer.tool) &&
        isName(offer.phase) &&
        typeof offer.description === "string" &&
        isRecord(offer.jsonSchema),
    )
  )
    return invalid("invalid action offers");
  return valid;
}

export function validateNextEnvelope(value: unknown): ValidationResult {
  if (!isRecord(value) || value.protocolVersion !== 1)
    return invalid("unsupported next envelope version");
  const base = ["protocolVersion", "kind"];
  if (value.kind === "idle") return hasFields(value, base) ? valid : invalid("invalid idle fields");
  if (!isName(value.matchId)) return invalid("missing match identity");
  if (value.kind === "match_over") {
    return hasFields(value, [...base, "matchId", "result"]) &&
      isRecord(value.result) &&
      Object.entries(value.result).every(
        ([seat, score]) =>
          isName(seat) && isSafeKey(seat) && typeof score === "number" && Number.isFinite(score),
      )
      ? valid
      : invalid("invalid match result");
  }
  if (value.kind === "match_aborted")
    return hasFields(value, [...base, "matchId", "reason"]) && isName(value.reason)
      ? valid
      : invalid("invalid match abortion");
  if (value.kind === "seat_finished")
    return hasFields(value, [...base, "matchId", "seat", "reason"]) &&
      isName(value.seat) &&
      isName(value.reason)
      ? valid
      : invalid("invalid seat completion");
  if (value.kind !== "turn" && value.kind !== "waiting")
    return invalid("unknown next envelope kind");
  if (
    !hasFields(value, [...base, "matchId", "seat", "observation", "deadline"]) ||
    !isName(value.seat) ||
    !isNullableAmount(value.deadline)
  )
    return invalid("invalid assignment fields");
  const observation = validateObservation(value.observation);
  if (!observation.ok) return observation;
  if (
    !isRecord(value.observation) ||
    value.observation.matchId !== value.matchId ||
    value.observation.seat !== value.seat ||
    !isRecord(value.observation.participation) ||
    value.observation.participation.status !== (value.kind === "turn" ? "acting" : "waiting")
  )
    return invalid("inconsistent assignment identity or participation");
  return valid;
}

export function validateSubmitEnvelope(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !hasFields(value, ["protocolVersion", "ok", "reason"], ["observation", "result"]) ||
    typeof value.ok !== "boolean" ||
    typeof value.reason !== "string"
  )
    return invalid("invalid submit response");
  if (own(value, "observation") && !validateObservation(value.observation).ok)
    return invalid("invalid submit observation");
  if (own(value, "result") && !isRecord(value.result)) return invalid("invalid submit result");
  return valid;
}

export function validateCapabilities(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !hasFields(value, ["protocolVersion", "supportedProtocolVersions", "features"]) ||
    value.protocolVersion !== 1 ||
    !Array.isArray(value.supportedProtocolVersions) ||
    value.supportedProtocolVersions.length !== 1 ||
    value.supportedProtocolVersions[0] !== 1 ||
    value.supportedProtocolVersions.some(
      (version, index, versions) => versions.indexOf(version) !== index,
    )
  )
    return invalid("unsupported capabilities version");
  if (
    !isStringArray(value.features) ||
    !value.features.every((feature) => CAPABILITY_FEATURES.some((known) => known === feature)) ||
    value.features.some((feature, index, features) => features.indexOf(feature) !== index)
  )
    return invalid("unsupported capabilities feature");
  return valid;
}
