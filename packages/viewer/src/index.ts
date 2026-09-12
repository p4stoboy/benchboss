import {
  type ClockSnapshot,
  type GameResult,
  type SpectatorBlock,
  type SpectatorView,
  isResourceAmount,
  isResourceName,
  validateClockSnapshot,
} from "@benchboss/protocol";

const MAX_BLOCKS = 100;
const MAX_ITEMS = 500;

const escapeHtml = (value: string | number): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isScalar = (value: unknown): value is string | number => isText(value) || isNumber(value);
const isArrayOf = <T>(value: unknown, guard: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.length <= MAX_ITEMS && value.every(guard);

const isResult = (value: unknown): value is GameResult | null =>
  value === null ||
  (isRecord(value) &&
    isText(value.summary) &&
    isArrayOf(
      value.seats,
      (seat): seat is GameResult["seats"][number] =>
        isRecord(seat) &&
        isText(seat.seat) &&
        (seat.outcome === "win" || seat.outcome === "loss" || seat.outcome === "draw") &&
        isNumber(seat.placement) &&
        (seat.team === undefined || isText(seat.team)) &&
        isArrayOf(
          seat.metrics,
          (metric): metric is { label: string; value: number } =>
            isRecord(metric) && isText(metric.label) && isNumber(metric.value),
        ),
    ));

const isBlock = (value: unknown): value is SpectatorBlock => {
  if (!isRecord(value) || !isText(value.kind) || !isText(value.title)) return false;
  if (value.kind === "text") return isText(value.text);
  if (value.kind === "metrics")
    return isArrayOf(
      value.values,
      (entry): entry is { label: string; value: string | number } =>
        isRecord(entry) && isText(entry.label) && isScalar(entry.value),
    );
  if (value.kind === "participants")
    return isArrayOf(
      value.seats,
      (seat): seat is { seat: string; status: string } =>
        isRecord(seat) && isText(seat.seat) && isText(seat.status),
    );
  if (value.kind === "progress")
    return isNumber(value.current) && (value.total === null || isNumber(value.total));
  if (value.kind === "table" && isArrayOf(value.columns, isText)) {
    const columns = value.columns;
    return isArrayOf(
      value.rows,
      (row): row is (string | number)[] =>
        isArrayOf(row, isScalar) && row.length === columns.length,
    );
  }
  if (value.kind === "list") return isArrayOf(value.items, isText);
  return false;
};

export const isSpectatorView = (value: unknown): value is SpectatorView =>
  isRecord(value) &&
  value.version === 1 &&
  isRecord(value.progress) &&
  isText(value.progress.phase) &&
  isText(value.progress.label) &&
  isNumber(value.progress.current) &&
  (value.progress.total === null || isNumber(value.progress.total)) &&
  Array.isArray(value.blocks) &&
  value.blocks.length <= MAX_BLOCKS &&
  value.blocks.every(isBlock) &&
  isResult(value.result) &&
  (value.clocks === undefined ||
    (isRecord(value.clocks) &&
      Object.keys(value.clocks).length <= MAX_ITEMS &&
      Object.values(value.clocks).every((clock) => validateClockSnapshot(clock).ok))) &&
  (value.resources === undefined ||
    (isRecord(value.resources) &&
      Object.keys(value.resources).length <= MAX_ITEMS &&
      Object.values(value.resources).every(
        (balances) =>
          isRecord(balances) &&
          Object.keys(balances).length <= MAX_ITEMS &&
          Object.entries(balances).every(
            ([name, amount]) => isResourceName(name) && isResourceAmount(amount),
          ),
      )));

const renderBlock = (block: SpectatorBlock): string => {
  const title = `<h3 class="bb-view-title">${escapeHtml(block.title)}</h3>`;
  if (block.kind === "text")
    return `<section class="bb-view-block">${title}<p>${escapeHtml(block.text)}</p></section>`;
  if (block.kind === "metrics")
    return `<section class="bb-view-block">${title}<dl>${block.values.map(({ label, value }) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></section>`;
  if (block.kind === "participants")
    return `<section class="bb-view-block">${title}<ul>${block.seats.map(({ seat, status }) => `<li><strong>${escapeHtml(seat)}</strong> ${escapeHtml(status)}</li>`).join("")}</ul></section>`;
  if (block.kind === "progress") {
    if (block.total === null)
      return `<section class="bb-view-block">${title}<span class="bb-view-count">${escapeHtml(block.current)}</span></section>`;
    return `<section class="bb-view-block">${title}<progress value="${escapeHtml(block.current)}" max="${escapeHtml(block.total)}"></progress></section>`;
  }
  if (block.kind === "table")
    return `<section class="bb-view-block">${title}<table><thead><tr>${block.columns.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
  return `<section class="bb-view-block">${title}<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
};

const renderClock = (seat: string, clock: ClockSnapshot): string =>
  `<tr><th>${escapeHtml(seat)}</th><td>${clock.remainingMs === null ? "Unlimited" : `${escapeHtml(clock.remainingMs)} ms`}</td><td>${clock.running ? "running" : "paused"}</td><td>${clock.deadline === null ? "None" : escapeHtml(clock.deadline)}</td></tr>`;

export const renderSpectatorView = (view: SpectatorView): string => {
  if (!isSpectatorView(view)) throw new TypeError("Unsupported or malformed spectator view");
  const clocks = view.clocks
    ? `<section class="bb-view-block"><h3 class="bb-view-title">Clocks</h3><table><thead><tr><th>Seat</th><th>Remaining</th><th>Status</th><th>Deadline</th></tr></thead><tbody>${Object.entries(
        view.clocks,
      )
        .map(([seat, clock]) => renderClock(seat, clock))
        .join("")}</tbody></table></section>`
    : "";
  const resources = view.resources
    ? `<section class="bb-view-block"><h3 class="bb-view-title">Resources</h3><table><thead><tr><th>Seat</th><th>Resource</th><th>Remaining</th></tr></thead><tbody>${Object.entries(
        view.resources,
      )
        .flatMap(([seat, balances]) =>
          Object.entries(balances).map(
            ([resource, amount]) =>
              `<tr><th>${escapeHtml(seat)}</th><td>${escapeHtml(resource)}</td><td>${escapeHtml(amount)}</td></tr>`,
          ),
        )
        .join("")}</tbody></table></section>`
    : "";
  const result =
    view.result === null
      ? ""
      : `<footer class="bb-view-result"><strong>Result</strong> ${escapeHtml(view.result.summary)}</footer>`;
  return `<div class="bb-spectator-view" data-view-version="1"><header class="bb-view-header"><span>${escapeHtml(view.progress.label)}</span><span>${escapeHtml(view.progress.phase)}</span></header>${view.blocks.map(renderBlock).join("")}${clocks}${resources}${result}</div>`;
};
