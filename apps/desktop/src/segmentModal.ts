/**
 * One segment, in full, with a way through to the ones either side of it.
 *
 * The timeline and the details table both hand this the list a segment sits in — a play
 * session in one case, the current sort and filter in the other — so "next" always means
 * the next one in whatever the reader was already looking at.
 */

import { achievementIds, achievementLine } from "./achievements";
import type { AchievementBook } from "./achievements";
import { equipsetDetail, equipsetSlotLine, equipsetTitle } from "./equipsets";
import { highlights } from "./sessions";
import { ago, clock, dayLabel, duration, escapeHtml, plural, signed } from "./format";
import { eventsOf } from "./types";
import type {
  AccountCurrency, AccountFaction, AccountHoldings, AchievementEvent, EventListKey, EventOf,
  ReputationGain, Segment,
} from "./types";
import { activityChip, classDot, className, highlightList, locationType } from "./ui";

const wowhead = (kind: string, id: number, text: string): string =>
  `<a href="https://www.wowhead.com/${kind}=${encodeURIComponent(id)}"
    target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;

const at = (event: { at?: number | null }): string =>
  (event.at ? `<span class="muted">${escapeHtml(clock(event.at))}</span>` : "");

interface Section {
  title: string;
  /** The section's list drawn off a segment, or nothing at all when it has none. */
  render: (segment: Segment) => string;
}

/**
 * Every list a section can be built from. Activities are the exception: they are the one
 * thing on a segment the user writes rather than the game, they are drawn as chips at the
 * top rather than as a list, and they carry no time of their own to print.
 */
type SectionKey = Exclude<EventListKey, "activities">;

interface SectionSpec<K extends SectionKey> {
  key: K;
  title: string;
  line: (event: EventOf<K>) => string;
}

/** Ties a section's heading to the list it reads and the way one of its events is written. */
function section<K extends SectionKey>(spec: SectionSpec<K>): Section {
  return {
    title: spec.title,
    render: (segment) => {
      const events = eventsOf(segment, spec.key);
      if (!events.length) return "";
      return `<section class="detail-section">
        <h3>${escapeHtml(spec.title)}</h3>
        <ul>${events.map((event) => `<li>${spec.line(event)} ${at(event)}</li>`).join("")}</ul>
      </section>`;
    },
  };
}

/**
 * The achievements, drawn from what the game says about them rather than only from what the
 * segment recorded.
 *
 * This is the one section whose contents are not in the segment. A row starts as the name
 * the addon caught — which is what the app showed before the game's tables were being read
 * at all — and fills in as the lookup comes back: what had to be done, what it granted,
 * where it sits, what it was worth, and the picture the game shows beside it.
 */
function achievements(book: AchievementBook): Section {
  return {
    title: "Achievements",
    render: (segment) => {
      const events = eventsOf(segment, "achievements");
      if (!events.length) return "";
      return `<section class="detail-section">
        <h3>Achievements</h3>
        <ul class="earned">${events.map((event) => earned(event, book)).join("")}</ul>
      </section>`;
    },
  };
}

function earned(event: AchievementEvent, book: AchievementBook): string {
  const line = achievementLine(event, book.detail(event.id));
  const icon = book.icon(event.id);
  const facts = [line.category, line.worth, line.side && `${line.side} only`, line.first]
    .filter(Boolean)
    .map((fact) => `<span class="chip">${escapeHtml(fact)}</span>`);
  // The icon is decorative: the row names the achievement beside it, and a picture that
  // announced itself as well would have a screen reader read every row twice. The frame is
  // drawn whether or not there is anything in it yet, so the column never goes ragged.
  return `<li class="earned-item">
    <span class="earned-icon">${icon ? `<img src="${icon}" alt="">` : ""}</span>
    <div>
      <p class="earned-name">🏆 ${wowhead("achievement", event.id, line.title)} ${at(event)}</p>
      ${line.description ? `<p class="earned-what">${escapeHtml(line.description)}</p>` : ""}
      ${line.reward ? `<p class="earned-reward">${escapeHtml(line.reward)}</p>` : ""}
      <p class="earned-facts">${facts.join("")}</p>
    </div>
  </li>`;
}

/**
 * What happened to the character's equipment sets, slot by slot.
 *
 * This is the one section whose rows are lists of their own: a change is a set and the slots
 * it moved, and the slots are the part somebody opens the modal for. The summary line above
 * them says what the chip said; the rows underneath say which items, which is what the chip
 * could not.
 *
 * A slot with nothing on one side is drawn as an em dash rather than left blank, so a slot
 * that was cleared and a slot that was filled read as the two different things they are.
 */
function equipsets(): Section {
  return {
    title: "Equipment sets",
    render: (segment) => {
      const changes = eventsOf(segment, "equipsetChanges");
      if (!changes.length) return "";
      return `<section class="detail-section">
        <h3>Equipment sets</h3>
        <ul class="equipsets">${changes.map((change) => `<li class="equipset">
          <p class="equipset-name">🎽 ${escapeHtml(equipsetTitle(change))}
            <span class="muted">${escapeHtml(equipsetDetail(change))}</span> ${at(change)}</p>
          ${(change.items || []).length === 0 ? "" : `<ul class="equipset-slots">${
            (change.items || []).map((item) => {
              const line = equipsetSlotLine(item);
              return `<li>
                <span class="equipset-slot">${escapeHtml(line.slot)}</span>
                <span class="equipset-was">${line.previousItemId == null
                  ? '<span class="muted">—</span>'
                  : wowhead("item", line.previousItemId, line.before)}</span>
                <span class="equipset-now">${line.itemId == null
                  ? '<span class="muted">—</span>'
                  : wowhead("item", line.itemId, line.after)}</span>
              </li>`;
            }).join("")
          }</ul>`}
        </li>`).join("")}</ul>
      </section>`;
    },
  };
}

/**
 * Where a reputation gain left the character, as a bar under the faction it belongs to.
 *
 * The pair of numbers is a position inside one level rather than a faction's whole
 * reputation — the addon has already decided which of the client's reputation systems
 * answers for this faction and reduced its answer to that shape — so the bar is always read
 * the same way whether the level is Honored, Renown 12 or a friendship rank.
 *
 * A gain the client could not place gets nothing at all: an account-wide line read on a
 * character that has never met the faction has no standing to draw, and an empty track
 * would claim they were at the bottom of one.
 *
 * A standing whose level has no length to it — the client named the level and said nothing
 * about how long it is — gets its name and no bar, for the same reason. A bar drawn at zero
 * is announced as zero per cent, which is a claim about where the character stands, and the
 * one thing known here is that nobody knows.
 */
function standingBar(event: ReputationGain): string {
  const max = Math.max(event.max || 0, 0);
  const current = Math.min(Math.max(event.current || 0, 0), max);
  if (!event.standing && max === 0) return "";
  const bar = max === 0 ? "" : `<progress class="rep-bar" value="${current}" max="${max}"
      aria-label="${escapeHtml(`${event.standing || "Standing"} with ${event.faction}`)}"></progress>`;
  const numbers = max > 0 ? `${current.toLocaleString()} / ${max.toLocaleString()}` : "";
  const caption = [event.standing, numbers].filter(Boolean).join(" ");
  return `<p class="rep-standing">
    ${bar}
    <span class="muted">${escapeHtml(caption)}</span>
  </p>`;
}

/**
 * The reputation gains, each with the standing it left behind.
 *
 * A section of its own rather than a one-line formatter, because the bar is a block under
 * the gain rather than something that fits on the end of it.
 */
/**
 * What some other character has already done with the faction, when one has done more.
 *
 * The question this answers is whether grinding the faction on this character is worth
 * anything, so it only speaks when the answer is "somebody else has already got further".
 * The account best is computed across every character including this one, so a best belonging
 * to the segment's own character means nobody is ahead and there is nothing to say.
 *
 * The age travels with it because none of this is live: it is what that character was holding
 * when it was last played, and a standing read months ago is a weaker claim than a name alone
 * would suggest.
 */
function accountStanding(faction: AccountFaction | undefined, character: string): string {
  const best = faction?.best;
  if (!best || best.character === character || !best.standing) return "";
  const when = best.at ? ` · read ${ago(best.at)}` : "";
  return `<p class="rep-account muted">
    ${escapeHtml(best.character)} is further along: ${escapeHtml(best.standing)}${escapeHtml(when)}
  </p>`;
}

function reputation(holdings?: AccountHoldings): Section {
  return {
    title: "Reputation",
    render: (segment) => {
      const gains = eventsOf(segment, "reputation");
      if (!gains.length) return "";
      const byFaction = new Map((holdings?.factions || []).map((entry) => [entry.faction, entry]));
      return `<section class="detail-section">
        <h3>Reputation</h3>
        <ul>${gains.map((gain) => `<li>
          🎖️ ${escapeHtml(gain.faction)} <span class="muted">${escapeHtml(signed(gain.amount))}</span> ${at(gain)}
          ${standingBar(gain)}
          ${accountStanding(byFaction.get(gain.faction), segment.character)}
        </li>`).join("")}</ul>
      </section>`;
    },
  };
}

/**
 * What the whole account holds of a currency this segment earned.
 *
 * Only when somebody else holds some too: on an account of one, or a currency only this
 * character has ever picked up, the account total is the number already on the line and
 * saying it twice adds nothing.
 *
 * The eldest reading in the sum is the one named, because it is the weakest claim in it — a
 * total built partly from numbers a month old should not read as though it were all current.
 */
function accountTotal(held: AccountCurrency | undefined): string {
  if (!held || held.characters.length < 2) return "";
  const eldest = held.oldest ? `, eldest read ${ago(held.oldest)}` : "";
  return ` <span class="account-total">· ${held.total.toLocaleString()} across ` +
    `${escapeHtml(plural(held.characters.length, "character"))}${escapeHtml(eldest)}</span>`;
}

/**
 * Every list of events a segment can carry, and how each one reads in full. The table
 * columns abbreviate; this is the place that does not, because it is where someone comes
 * when the abbreviation was not enough.
 */
const sections = (book: AchievementBook, holdings?: AccountHoldings): Section[] => [
  section({
    key: "encounters",
    title: "Encounters",
    line: (event) => `${escapeHtml(event.name || `Encounter ${event.id}`)} ` +
      `<span class="${event.success ? "ok" : "loss"}">${event.success ? "killed" : "wipe"}</span>` +
      (event.groupSize ? ` <span class="muted">${escapeHtml(plural(event.groupSize, "player"))}</span>` : ""),
  }),
  achievements(book),
  section({ key: "levelUps", title: "Level ups", line: (event) => `⬆️ Level ${escapeHtml(event.level)}` }),
  section({ key: "mounts", title: "Mounts", line: (event) => `🐎 ${escapeHtml(event.name || `Mount ${event.id}`)}` }),
  section({ key: "pets", title: "Pets", line: (event) => `🐾 ${escapeHtml(event.name || `Pet ${event.id}`)}` }),
  section({ key: "toys", title: "Toys", line: (event) => `🧸 ${escapeHtml(event.name || `Toy ${event.id}`)}` }),
  section({
    key: "transmogs",
    title: "Transmog",
    line: (event) => `👘 ${wowhead("item", event.id, event.name || `Item ${event.id}`)} ` +
      (event.newAppearance === true
        ? '<span class="appearance-new">new appearance</span>'
        : event.newAppearance === false
          ? '<span class="appearance-variant">variant of one owned</span>'
          : '<span class="muted">unknown</span>'),
  }),
  equipsets(),
  section({
    key: "quests",
    title: "Quests",
    line: (event) => `📜 ${wowhead("quest", event.id, event.name || `Quest ${event.id}`)}` +
      (event.accountFirst ? ' <span class="muted">account first</span>' : ""),
  }),
  section({
    key: "housingItems",
    title: "Housing",
    line: (event) => `🪑 ${escapeHtml(event.name || `Decor ${event.id}`)} ` +
      `<span class="muted">${event.warbandFirst ? "warband first" : "already known"}</span>`,
  }),
  section({
    key: "housingLevelUps",
    title: "Housing levels",
    line: (event) => `🏡 Housing level ${escapeHtml(event.level)}`,
  }),
  section({
    key: "currencies",
    title: "Currency",
    // What the segment earned, then what the character was left holding, then what the
    // account holds altogether. The second is the number that decides whether the first is
    // enough to buy anything; the third is the one no single character can answer. Both are
    // absent rather than zero when nobody has said.
    line: (event) => `🪙 ${escapeHtml(event.name)} <span class="muted">${escapeHtml(signed(event.amount))}` +
      `${event.total == null ? "" : ` (${event.total.toLocaleString()})`}</span>` +
      accountTotal((holdings?.currencies || []).find((entry) => entry.id === event.id)),
  }),
  reputation(holdings),
];

export interface SegmentModalOptions {
  dialog: HTMLDialogElement;
  onEditActivities: (segmentId: number) => void;
  /**
   * What the game says about the achievements a segment names. Injected so the modal is
   * drivable without a backend, and asked only for the segment on screen.
   */
  achievements: AchievementBook;
  /**
   * What every character on the account was last seen holding, so a gain can be read against
   * the account rather than only against the character that earned it. Absent on a history
   * collected before any character reported, which reads as nothing to add.
   */
  holdings?: AccountHoldings;
}

export interface SegmentModal {
  open: (segmentId: number, segments: Segment[]) => void;
  refresh: (segments: Segment[]) => void;
  current: () => Segment | undefined;
  isOpen: () => boolean;
}

/** The dialog's own furniture, which index.html is required to carry. */
function part<T extends Element = HTMLElement>(dialog: HTMLDialogElement, selector: string): T {
  const found = dialog.querySelector<T>(selector);
  if (!found) throw new Error(`The segment detail dialog is missing ${selector}.`);
  return found;
}

export function createSegmentModal(
  { dialog, onEditActivities, achievements: book, holdings }: SegmentModalOptions,
): SegmentModal {
  // The list is held rather than copied out of, so that a repaint after an edit finds the
  // same neighbours the reader was navigating a moment ago.
  let order: Segment[] = [];
  let index = 0;

  const current = (): Segment | undefined => order[index];

  function open(segmentId: number, segments: Segment[]): void {
    if (!segments?.length) return;
    order = segments;
    index = Math.max(segments.findIndex((segment) => segment.segmentId === segmentId), 0);
    draw();
    if (!dialog.open) dialog.showModal();
  }

  function step(by: number): void {
    const next = index + by;
    if (next < 0 || next >= order.length) return;
    index = next;
    draw();
    dialog.querySelector(".detail-body")?.scrollTo({ top: 0 });
  }

  /** Re-resolves the segments on screen against a freshly loaded dashboard. */
  function refresh(segments: Segment[]): void {
    if (!dialog.open) return;
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
    order = order.map((segment) => byId.get(segment.segmentId) || segment);
    draw();
  }

  function draw(): void {
    const segment = current();
    if (!segment) {
      dialog.close();
      return;
    }
    part(dialog, ".detail-position").textContent = `${index + 1} of ${order.length}`;
    part<HTMLButtonElement>(dialog, '[data-role="prev"]').disabled = index === 0;
    part<HTMLButtonElement>(dialog, '[data-role="next"]').disabled = index >= order.length - 1;
    part(dialog, ".detail-title").textContent = segment.instance;
    part(dialog, ".detail-body").innerHTML = body(segment, book, holdings);
    dialog.querySelector("[data-edit-activities]")
      ?.addEventListener("click", () => onEditActivities(segment.segmentId));

    // The lookup runs after the segment is on screen, because reading the game's own files
    // takes about a second and everything else about the segment is already in hand. Each
    // half of it — the words, then the pictures — redraws when it lands, and only if the
    // reader is still on the segment that asked: they may well have stepped on to the next.
    const wanted = achievementIds(segment);
    if (!wanted.length) return;
    void book.learn(wanted, () => {
      if (dialog.open && current()?.segmentId === segment.segmentId) draw();
    });
  }

  part(dialog, '[data-role="prev"]').addEventListener("click", () => step(-1));
  part(dialog, '[data-role="next"]').addEventListener("click", () => step(1));
  part(dialog, '[data-role="close"]').addEventListener("click", () => dialog.close());
  // Arrow keys are what a reader reaches for once they realise the modal walks a list, and
  // nothing inside it wants them: the body scrolls, it does not select.
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });

  return { open, refresh, current, isOpen: () => dialog.open };
}

function body(segment: Segment, book: AchievementBook, holdings?: AccountHoldings): string {
  const facts = [
    `${escapeHtml(dayLabel(segment.day))} · ${escapeHtml(clock(segment.startedAt))} – ${escapeHtml(clock(segment.endedAt))}`,
    escapeHtml(duration(segment.seconds)),
    `<span class="badge">${escapeHtml(locationType(segment))}</span>`,
  ];
  if (segment.difficulty) facts.push(escapeHtml(segment.difficulty));

  return `
    <p class="detail-who">
      ${classDot(segment.classFile)}<strong>${escapeHtml(segment.character)}</strong>
      <span class="muted">${escapeHtml(className(segment.classFile))}${
        segment.level == null ? "" : ` · level ${escapeHtml(segment.level)}`}</span>
    </p>
    <p class="detail-facts">${facts.join(" · ")}</p>
    <div class="detail-activities">
      ${(segment.activities || []).map(activityChip).join("") ||
        '<span class="muted">No activity recorded</span>'}
      <button type="button" data-edit-activities>Edit activities</button>
    </div>
    ${keystone(segment)}
    ${experience(segment)}
    <div class="detail-highlights">${
      highlightList(highlights([segment]), { milestones: false }) ||
      '<p class="muted">Nothing was gained or collected in this segment.</p>'}</div>
    ${sections(book, holdings).map((entry) => entry.render(segment)).join("")}
  `;
}

function keystone(segment: Segment): string {
  const run = segment.keystone;
  if (!run) return "";
  const outcome = !run.completed
    ? '<span class="loss">abandoned</span>'
    : run.onTime === false
      ? '<span class="loss">depleted</span>'
      : '<span class="ok">timed</span>';
  const upgrades = run.upgrades ? ` · +${escapeHtml(run.upgrades)} upgrade${run.upgrades === 1 ? "" : "s"}` : "";
  return `<section class="detail-section">
    <h3>Keystone</h3>
    <p>🔑 <strong>+${escapeHtml(run.level)}</strong> ${outcome}${upgrades}${
      run.durationMs ? ` <span class="muted">${escapeHtml(duration(run.durationMs / 1000))}</span>` : ""}</p>
  </section>`;
}

function experience(segment: Segment): string {
  const gained = segment.experience;
  if (!gained) return "";
  const reached = gained.endLevel == null ? "" : ` <span class="muted">now level ${escapeHtml(gained.endLevel)}</span>`;
  return `<section class="detail-section">
    <h3>Experience</h3>
    <p>${escapeHtml(signed(gained.gained))} XP · ${escapeHtml(Math.round(gained.percent * 10) / 10)}% of a level${reached}</p>
  </section>`;
}
