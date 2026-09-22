/**
 * The panel itself.
 *
 * Three states, and it says which one it is in — a panel that shows an empty
 * list for "no program yet", "the switch is off" and "the dashboard really is
 * empty" alike would be worse than no panel, because all three look like a
 * broken dashboard.
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
	sendToSimulator,
	type SimxAnnouncement,
	type SimxDatapoint
} from './simx';
import { canWrite, sendPoints, watchValues, type DashboardView, type Value } from './dashboard';

const app = document.getElementById('app') as HTMLElement;

let announcement: SimxAnnouncement | null = null;
let view: DashboardView | null = null;
let stopWatching: (() => void) | null = null;

// ── Senden ────────────────────────────────────────────────────────────────
//
// READING AND WRITING ARE NOT THE SAME QUESTION, and the panel treats them as
// two.
//
// Reading needs no permission from anybody: the panel shows the dashboard the
// program names, live, always. That is what makes it useful while programming —
// a child sees what is actually on the board next to the program that is
// supposed to change it.
//
// Writing is a different thing entirely, because a simulator writes into a
// board a whole class may be looking at. So it is OFF until somebody says
// otherwise, and the switch sits HERE rather than in the program: the panel is
// where the sending happens, so it is where the sending is decided. A switch in
// the program would travel with a shared file and turn on twenty simulators
// that nobody asked.
//
// Deliberately NOT remembered across reloads. "Default aus" has to mean off
// every time the panel comes up, or it is not a default but a setting somebody
// once made and has since forgotten.
let sending = false;

/**
 * Points waiting to go out, and the pacing.
 *
 * Same floor as everywhere else on this path — the ingest route accepts one
 * batch per device per ~900 ms and answers 429 beyond that. A simulator fires
 * as fast as the program loops, so without this the panel would spend its time
 * being rejected.
 */
let outbox: SimxDatapoint[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentAt = 0;
const MIN_BATCH_MS = 1000;
/** Bounded like the device's own ring: on overflow the OLDEST point goes. */
const MAX_OUTBOX = 60;
/** Last outcome, so the panel can say "on, but it is not arriving". */
let sendError = '';

function queue(point: SimxDatapoint): void {
	// Collected even while the switch is off, and then dropped on the next
	// flush — see `flush`. Queueing unconditionally keeps the pacing honest: the
	// gate is one place, and it is the place that posts.
	if (outbox.length >= MAX_OUTBOX) outbox.shift();
	outbox.push(point);
	schedule();
}

function schedule(): void {
	if (flushTimer || !outbox.length) return;
	const wait = Math.max(0, lastSentAt + MIN_BATCH_MS - Date.now());
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flush();
	}, wait);
}

async function flush(): Promise<void> {
	const batch = outbox;
	outbox = [];
	if (!batch.length) return;
	// The switch is the gate, and it is checked HERE rather than in `queue`:
	// a point produced while the switch was off belongs to the time it was off,
	// and turning the switch on must not post a minute of backlog.
	if (!sending || !announcement?.ref) return;

	lastSentAt = Date.now();
	const ok = await sendPoints(
		announcement.server,
		announcement.ref,
		announcement.device,
		batch
	);
	const before = sendError;
	sendError = ok ? '' : 'Das Dashboard hat die Werte nicht angenommen.';
	if (sendError !== before) render();
	if (outbox.length) schedule();
}

// ── Lesen: was auf dem Dashboard steht, geht zurück ins Programm ──────────
//
// Unconditional, and it is the asymmetry that makes the panel useful. WRITING
// is a decision somebody has to make (see `sending`); READING is what the panel
// is for. A simulated mini that can see the board it is programmed against
// needs no switch — nothing leaves the machine, and the values were already on
// screen a line above.

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

function toggleSending(next: boolean): void {
	sending = next;
	if (!next) outbox = [];
	sendError = '';
	render();
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
	const parts = [announcement?.ref ?? '', sending ? '1' : '0', sendError];
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
          Dashboard nennen — dann zeigt dieses Feld, was es sendet.
        </p>
      </section>`;
		return;
	}

	if (!view) {
		painted = '';
		app.innerHTML = `<section class="empty"><h1>Verbinde…</h1><p>${escape(refLabel(announcement.ref))}</p></section>`;
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

	app.innerHTML = `
    <header>
      <h1 title="${escape(announcement.ref)}">${escape(refLabel(announcement.ref))}</h1>
      ${sendSwitch()}
    </header>
    <div class="feeds">${feeds || '<p class="empty">Noch keine Werte.</p>'}</div>`;
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
	// The number of senders is only worth saying when there is more than one; on
	// a single-row feed it would be a "1" beside every name on the panel.
	const count = values.length > 1 ? `<span class="count">${values.length}</span>` : '';
	return `
      <details class="feed" data-feed="${escape(feed)}"${opened.has(feed) ? ' open' : ''}>
        <summary>
          <span class="name">${escape(feed)}${count}</span>
          <span class="val">${escape(brief(textOf(values[0])))}</span>
        </summary>
        <table>
          <tr><th>Zeit</th><th>Wert</th><th>Von</th><th>An</th></tr>
          ${rows}
        </table>
      </details>`;
}

function valueRow(value: Value): string {
	const to = value.to_dev ? senderName(value.to_dev) : 'alle';
	return `<tr>
            <td class="when">${when(changedAt.get(keyOf(value)))}</td>
            <td class="num">${escape(textOf(value))}</td>
            <td>${escape(senderName(value.from_dev))}</td>
            <td>${escape(to)}</td>
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
	const time = new Date(at);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** The summary is one line by design; the table under it has the whole value. */
function brief(text: string): string {
	return text.length > 16 ? `${text.slice(0, 15)}…` : text;
}

/**
 * The switch, and what it says when it cannot be offered.
 *
 * With a slug instead of a token the panel holds no credential of its own, so
 * there is nothing to switch on - and a disabled control with a reason beats a
 * control that silently does nothing. That case is not a fault: a slug is the
 * normal shape for a program that relies on campus to carry its data.
 */
function sendSwitch(): string {
	if (!announcement?.ref) return '';
	if (!canWrite(announcement.ref)) {
		return `<p class="switch off">Der Simulator kann hier nicht selbst senden &mdash;
		  das Programm nennt einen Kurznamen statt eines Schreib-Tokens.</p>`;
	}
	return `
	  <label class="switch">
	    <input type="checkbox" id="sendToggle" ${sending ? 'checked' : ''} />
	    <span>Simulierte Werte ins Dashboard schreiben</span>
	  </label>
	  ${sendError ? `<p class="switch err">${escape(sendError)}</p>` : ''}`;
}

function wire(): void {
	const box = document.getElementById('sendToggle') as HTMLInputElement | null;
	if (box) box.onchange = () => toggleSending(box.checked);
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
	onDatapoint: (point) => queue(point),
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
		if (same) return;

		stopWatching?.();
		view = null;
		render();
		seen.clear();
		changedAt.clear();
		firstView = true;
		clockPushed = false;
		stopWatching = watchValues(next.server, next.ref, next.scope, (v) => {
			view = v;
			absorb(v);
			render();
		});
	}
});

// Listener first, THEN the handshake: pxt flushes everything it had held back
// the instant it sees `ready`, and a flush that lands before the listener is
// wired would take the announcement with it.
announceReady();

render();
