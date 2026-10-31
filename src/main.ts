/**
 * The panel itself.
 *
 * Four states, and it says which one it is in — a panel that shows an empty
 * list for "no program yet", "still connecting", "cannot get through" and "the
 * dashboard really is empty" alike would be worse than no panel, because all
 * four look like a broken dashboard.
 *
 * "Cannot get through" also has a quiet form: when the connection goes after
 * values are on screen, they stay, faded, under a line that says since when
 * they have not been confirmed. Left at full strength they would pass for
 * current; taken away they would leave the child with less than they had.
 *
 * It only READS. The simulator's own datapoints go nowhere: there was a switch
 * here that posted them to the dashboard, removed because nothing on the board
 * could tell those readings from a real mini's (see `dashboard.ts`).
 *
 * WHAT GETS THE ROOM. The panel stands in a column some 300 px wide beside a
 * running simulator, so the one thing it is for — the CURRENT reading of each
 * feed — takes the full width at a size that can be read from a step back.
 * Everything else about a reading (when it arrived, who sent it, who it was
 * addressed to) sits one tap below it in a small table: a feed usually carries a
 * single row anyway, and listing every sender flat spent the panel's height
 * repeating the word "Dashboard".
 */
import './style.css';
import {
	announceReady,
	listenToSimulator,
	refLabel,
	sendFeedsToEditor,
	sendToSimulator,
	type SimxAnnouncement
} from './simx';
import { watchValues, type DashboardView, type ReadFailure, type Value } from './dashboard';

const app = document.getElementById('app') as HTMLElement;

let announcement: SimxAnnouncement | null = null;
let view: DashboardView | null = null;
let stopWatching: (() => void) | null = null;
/** The feed set last handed to the editor, so a poll that changed nothing posts nothing. */
let feedsPosted: string | null = null;

// ── Verbindung ────────────────────────────────────────────────────────────

/**
 * Failed polls in a row before the panel says so. One is a hiccup — a reloading
 * dev server, a dropped packet — and saying "no connection" for it would teach
 * the child to ignore the message; three is six seconds and no longer a blink.
 */
const FAILURES_BEFORE_SAYING = 3;
let failures = 0;
let failure: ReadFailure | null = null;
/** When a poll last answered: the moment the values on screen are from. */
let answeredAt = 0;

function cutOff(): boolean {
	return failures >= FAILURES_BEFORE_SAYING;
}

/** The server as a person would recognise it: its host, without scheme or path. */
function hostOf(server: string): string {
	return server
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
		.replace(/\/.*$/, '');
}

/**
 * What to check, in the words of the blocks rather than of HTTP. Each reason
 * names the one thing that would cause it: a child cannot act on "403", but can
 * look at the name in the dashboard block.
 */
function advice(reason: ReadFailure | null): string {
	const host = hostOf(announcement?.server ?? '');
	const board = refLabel(announcement?.ref ?? '');
	switch (reason) {
		case 'address':
			return 'Das Programm nennt keine gültige Server-Adresse. Prüfe die Adresse in den IoT-Blöcken.';
		case 'refused':
			return `${host || 'Der Server'} kennt das Dashboard „${board}“ nicht. Prüfe den Namen oder Schlüssel im Dashboard-Block.`;
		default:
			return `${host || 'Der Server'} antwortet nicht. Prüfe die Server-Adresse im Programm und ob das Dashboard erreichbar ist.`;
	}
}

/** The editor's feed suggestions follow the dashboard (see `sendFeedsToEditor`). */
function postFeeds(v: DashboardView): void {
	const keys = Array.from(new Set(v.feeds.map((f) => f.key))).sort();
	const signature = keys.join('\n');
	if (signature === feedsPosted) return;
	feedsPosted = signature;
	sendFeedsToEditor(keys);
}

// ── Lesen: was auf dem Dashboard steht, geht zurück ins Programm ──────────
//
// Unconditional: reading is what the panel is for. A simulated mini that can
// see the board it is programmed against needs no switch — nothing leaves the
// machine, and the values were already on screen a line above.

/** Last reading seen per feed+from+to — only CHANGES go down the wire. */
const seen = new Map<string, string>();
/** The clock is sent once: a simulated mini does not reboot between polls. */
let clockPushed = false;
/**
 * When the panel saw each reading take its current value.
 *
 * NOT a server timestamp: `/read` answers with the last value per feed and
 * sender and carries no time for any of them (see `iot.pb.js`). So the table's
 * time column says the one thing that is actually known here — the poll at which
 * this reading appeared. A value that was already on the board when the panel
 * connected has no such moment, and says so rather than borrowing the moment the
 * panel happened to start.
 */
const changedAt = new Map<string, number>();
let firstView = true;

/** A reading is one feed, one sender, one recipient; that triple is its name. */
function keyOf(value: Value): string {
	return `${value.feed} ${value.from_dev || '0'} ${value.to_dev || ''}`;
}

function textOf(value: Value): string {
	return value.num === null ? value.str : String(value.num);
}

/**
 * One pass over a fresh snapshot, for the two things that care about CHANGE:
 * the lines that go down into the simulator, and the times the table shows.
 * Both ask the same question — "is this reading new?" — and asking it in two
 * places would be two places for the answer to drift.
 */
function absorb(next: DashboardView): void {
	const lines: string[] = [];

	if (!clockPushed && next.clock > 0) {
		clockPushed = true;
		// Two lines, exactly as the campus relay splits them — the device's
		// serial buffer holds 20 bytes and `IOT1:t:<secs>:<tzo>` is one over.
		// The simulator has no such limit, but a second format for the same
		// fact is a second thing that can drift.
		lines.push(`IOT1:t:${next.clock}`);
		lines.push(`IOT1:z:${next.zone}`);
	}

	const now = Date.now();
	for (const value of next.values) {
		const key = keyOf(value);
		const text = textOf(value);
		if (seen.get(key) === text) continue;
		seen.set(key, text);
		if (!firstView) changedAt.set(key, now);
		lines.push(`IOT1:v:${value.from_dev || '0'}:${value.to_dev || ''}:${value.feed}:${text}`);
	}
	firstView = false;

	sendToSimulator(lines);
}

// ── Das Bild ──────────────────────────────────────────────────────────────

/** Feeds the child opened. Kept here because `innerHTML` forgets everything. */
const opened = new Set<string>();
/** Signature of what is on screen — see `signature`. */
let painted = '';

/**
 * What the picture actually depends on.
 *
 * The poll comes round every two seconds and mostly finds nothing new. Redrawing
 * regardless would rebuild every `<details>` element — snapping shut the table
 * the child had just opened, and dropping a selection with it — for a picture
 * identical to the one already on screen.
 */
function signature(): string {
	// The moment of the last answer only counts while it is shown — that is,
	// while cut off; otherwise every poll would redraw for it.
	const parts = [announcement?.ref ?? '', cutOff() ? String(answeredAt) : ''];
	for (const value of view?.values ?? []) {
		const key = keyOf(value);
		parts.push(key, textOf(value), String(changedAt.get(key) ?? 0));
	}
	return parts.join('\n');
}

function render(): void {
	if (!announcement?.ref) {
		painted = '';
		app.innerHTML = `
      <section class="empty">
        <h1>Kein Dashboard</h1>
        <p>
          Starte ein Programm mit den IoT-Blöcken im Simulator. Es muss ein
          Dashboard nennen — dann zeigt dieses Feld, was darauf steht.
        </p>
      </section>`;
		return;
	}

	if (!view) {
		painted = '';
		app.innerHTML = cutOff()
			? `
      <section class="empty">
        <h1>Keine Verbindung zum Dashboard</h1>
        <p>${escape(advice(failure))}</p>
        <p class="retry">Das Feld versucht es weiter.</p>
      </section>`
			: `<section class="empty"><h1>Verbinde…</h1><p>${escape(refLabel(announcement.ref))}</p></section>`;
		return;
	}

	const next = signature();
	if (next === painted) return;
	painted = next;

	const byFeed = new Map<string, Value[]>();
	for (const value of view.values) {
		const list = byFeed.get(value.feed) ?? [];
		list.push(value);
		byFeed.set(value.feed, list);
	}

	// Alphabetical, and deliberately not by recency: `/read` answers newest
	// first, so ordering by it would have the feeds swap places under the finger
	// of somebody trying to watch one of them.
	const feeds = [...byFeed.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([feed, values]) => feedBlock(feed, values))
		.join('');

	// Cut off, the values stay where they are, faded, and the header says since
	// when — the advice sits in the tooltip, because the panel has room for one
	// line here and the readings are still what the child is looking at.
	const stale = cutOff();
	const note = stale
		? `<p class="offline" title="${escape(advice(failure))}">Keine Verbindung · Stand ${clock(answeredAt)}</p>`
		: '';
	app.innerHTML = `
    <header>
      <h1 title="${escape(announcement.ref)}">${escape(refLabel(announcement.ref))}</h1>
      ${note}
    </header>
    <div class="feeds${stale ? ' stale' : ''}">${feeds || '<p class="empty">Noch keine Werte.</p>'}</div>`;
	wire();
}

/**
 * A feed: the reading, big, and the rest a tap below it.
 *
 * `values[0]` IS the current reading — the route orders its snapshot by `-ts`
 * (`iot.pb.js`), which is fortunate, because the answer carries no timestamp the
 * panel could sort by itself.
 */
function feedBlock(feed: string, values: Value[]): string {
	const rows = values.map(valueRow).join('');
	// Closed, a feed is its name and its newest reading and nothing else: no
	// sender count, no caret. Who sent what is the opened row's business.
	// A message is set smaller than a number: it is read once, not watched.
	const kind = values[0].num === null ? 'val text' : 'val';
	return `
      <details class="feed" data-feed="${escape(feed)}"${opened.has(feed) ? ' open' : ''}>
        <summary>
          <span class="name">${escape(feed)}</span>
          <span class="${kind}">${escape(brief(textOf(values[0])))}</span>
        </summary>
        <table>
          <tr><th>Zeit</th><th>Von</th><th>Wert</th></tr>
          ${rows}
        </table>
      </details>`;
}

/**
 * Time, sender, value — in the order a stream is read. No recipient column:
 * nearly every reading goes to everyone, and a column that says "alle" on
 * every row was width taken from the value.
 */
function valueRow(value: Value): string {
	return `<tr>
            <td class="when">${when(changedAt.get(keyOf(value)))}</td>
            <td>${escape(senderName(value.from_dev))}</td>
            <td class="num">${escape(textOf(value))}</td>
          </tr>`;
}

/**
 * The board itself writes as device `0`; everything else is a mini. Campus says
 * it the same way (`deviceLabel` in `IotDashboard.svelte`), and a panel that
 * invented its own word for the same sender would be a second vocabulary.
 */
function senderName(serial: string): string {
	return !serial || serial === '0' ? 'Dashboard' : serial;
}

function when(at: number | undefined): string {
	if (!at)
		return `<span title="Stand schon auf dem Dashboard, als das Panel dazukam">&middot;</span>`;
	return clock(at);
}

function clock(at: number): string {
	const time = new Date(at);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** The summary is one line by design; the table under it has the whole value. */
function brief(text: string): string {
	return text.length > 16 ? `${text.slice(0, 15)}…` : text;
}

function wire(): void {
	// Noted, not re-rendered: `<details>` opens itself. The note exists only so
	// the next redraw can put the panel back the way the child left it.
	app.querySelectorAll<HTMLDetailsElement>('details.feed').forEach((el) => {
		el.ontoggle = () => {
			const feed = el.dataset.feed ?? '';
			if (el.open) opened.add(feed);
			else opened.delete(feed);
		};
	});
}

function escape(text: string): string {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);
}

listenToSimulator({
	onAnnouncement: (next) => {
		// Only restart the watch when the ANSWER changes: the program repeats its
		// announcement on every reset, and tearing the poll down for an identical
		// one would blank the panel each time.
		// The SCOPE counts as part of the answer: a program that changes what it
		// subscribes to needs a different query, and treating that as "same"
		// would leave the panel asking the old question forever.
		const same =
			announcement?.ref === next.ref &&
			announcement?.server === next.server &&
			announcement?.scope === next.scope;
		announcement = next;
		if (same) {
			// SAME QUERY, NEW PROGRAM. An announcement always means the program
			// started over — that is the only thing that emits one — so the panel
			// keeps its poll but must hand the fresh program the current state
			// again. Without this, a restarted simulator got NOTHING until some
			// other sender happened to write: `seen` still held every value from
			// before the reset, so the next poll found no change and pushed no
			// lines, and `wenn … empfangen` never fired on startup.
			//
			// The real device does not have this hole because campus forgets its
			// downlink cache on every hello (`forgetDeviceSession`) and re-states
			// clock and setpoints. This is the same promise, kept the same way.
			seen.clear();
			clockPushed = false;
			// Re-seeding is not "everything just changed": `firstView` keeps the
			// highlight off, so the panel does not flash every row on a reset.
			firstView = true;
			if (view) absorb(view);
			return;
		}

		stopWatching?.();
		view = null;
		render();
		seen.clear();
		changedAt.clear();
		firstView = true;
		clockPushed = false;
		feedsPosted = null;
		failures = 0;
		failure = null;
		answeredAt = 0;
		stopWatching = watchValues(
			next.server,
			next.ref,
			next.scope,
			(v) => {
				view = v;
				failures = 0;
				failure = null;
				answeredAt = Date.now();
				absorb(v);
				render();
				postFeeds(v);
			},
			(reason) => {
				failures++;
				failure = reason;
				render();
			}
		);
	}
});

// Listener first, THEN the handshake: pxt flushes everything it had held back
// the instant it sees `ready`, and a flush that lands before the listener is
// wired would take the announcement with it.
announceReady();

render();
