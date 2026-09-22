/**
 * The panel itself.
 *
 * Three states, and it says which one it is in — a panel that shows an empty
 * list for "no program yet", "the switch is off" and "the dashboard really is
 * empty" alike would be worse than no panel, because all three look like a
 * broken dashboard.
 */
import { listenToSimulator, type SimxAnnouncement } from './simx';
import { watchValues, type DashboardView } from './dashboard';

const app = document.getElementById('app') as HTMLElement;

let announcement: SimxAnnouncement | null = null;
let view: DashboardView | null = null;
let stopWatching: (() => void) | null = null;
/** Lines seen from the simulator, newest last — the panel's own little stream. */
const log: string[] = [];

function render(): void {
	if (!announcement?.ref) {
		app.innerHTML = `
      <section class="empty">
        <h1>Kein Dashboard</h1>
        <p>
          Starte ein Programm mit den IoT-Blöcken im Simulator. Es muss ein
          Dashboard nennen, und am Übertragungsblock muss
          <b>„im Simulator senden“</b> eingeschaltet sein — sonst schickt das
          Programm hier nichts.
        </p>
      </section>`;
		return;
	}

	if (!view) {
		app.innerHTML = `<section class="empty"><h1>Verbinde…</h1><p>${escape(announcement.ref)}</p></section>`;
		return;
	}

	const byFeed = new Map<string, typeof view.values>();
	for (const value of view.values) {
		const list = byFeed.get(value.feed) ?? [];
		list.push(value);
		byFeed.set(value.feed, list);
	}

	const cards = [...byFeed.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([feed, values]) => {
			const rows = values
				.map(
					(v) => `
          <li>
            <span class="who">${escape(v.from_dev === '0' ? 'Dashboard' : v.from_dev)}</span>
            <span class="val">${escape(v.num === null ? v.str : String(v.num))}</span>
          </li>`
				)
				.join('');
			return `<article class="card"><h2>${escape(feed)}</h2><ul>${rows}</ul></article>`;
		})
		.join('');

	app.innerHTML = `
    <header><h1>${escape(announcement.ref)}</h1></header>
    <div class="cards">${cards || '<p class="empty">Noch keine Werte.</p>'}</div>
    <footer><pre>${escape(log.slice(-8).join('\n'))}</pre></footer>`;
}

function escape(text: string): string {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);
}

listenToSimulator({
	onLine: (line) => {
		log.push(line);
		if (log.length > 64) log.shift();
	},
	onAnnouncement: (next) => {
		// Only restart the watch when the ANSWER changes: the program repeats its
		// announcement on every reset, and tearing the poll down for an identical
		// one would blank the panel each time.
		const same = announcement?.ref === next.ref && announcement?.server === next.server;
		announcement = next;
		if (same) return;

		stopWatching?.();
		view = null;
		render();
		stopWatching = watchValues(next.server, next.ref, (v) => {
			view = v;
			render();
		});
	}
});

render();
