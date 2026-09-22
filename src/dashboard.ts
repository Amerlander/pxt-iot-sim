/**
 * Reading a dashboard straight from PocketBase.
 *
 * Deliberately no PocketBase SDK: the panel needs three GETs and one realtime
 * stream, and the SDK would be the largest thing in a bundle that has to load
 * inside an iframe next to a simulator. The endpoints are the ones
 * `services/iot/dashboards.ts` uses in campus; if those move, this moves with
 * them.
 *
 * The reference out of the program is a slug or a token. Only campus can
 * resolve a slug (its relay route authorises by session), so the panel takes
 * the read token when the program carries one and otherwise asks the public
 * read route with the slug — the same two roads the device itself has.
 */

export type Feed = { id: string; key: string; label: string; unit: string };
export type Value = { feed: string; from_dev: string; to_dev: string; num: number | null; str: string; ts: string };

export type DashboardView = {
	feeds: Feed[];
	values: Value[];
	/** Server time in unix seconds, straight out of the read answer. */
	clock: number;
	/** Its UTC offset in minutes — the mini has no other way to learn either. */
	zone: number;
};

/** `R-…`, `W-…` or `R-…:W-…` — anything else is a slug. */
function readTokenOf(ref: string): string {
	for (const part of ref.split(':')) {
		const p = part.trim();
		if (/^R-/i.test(p)) return p;
	}
	return '';
}

/**
 * Does this reference let us WRITE?
 *
 * The panel asks before it offers to send, not after it fails: a slug is
 * resolvable only by campus (its relay route authorises by session), so with a
 * slug there is nothing the panel could do on its own and the honest thing is
 * to say so rather than to show a switch that does nothing.
 */
export function canWrite(ref: string): boolean {
	return ref.split(':').some((part) => /^W-/i.test(part.trim()));
}

function base(server: string): string {
	const text = String(server || '').trim().replace(/\/+$/, '');
	if (!text) return '';
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		// The block may name the API path or just the host; both have to work,
		// exactly as they do in the relay's `normalizeServer`.
		const path = url.pathname.replace(/\/+$/, '');
		return `${url.origin}${path || '/api/iot/v1'}`;
	} catch {
		return '';
	}
}

/**
 * The current values, through the token route.
 *
 * `/read` answers with `w: [{ f, v, from, to }]` — feed KEY, not id — so the
 * panel builds its feed list from what it sees rather than asking for one.
 * That also means a feed nobody has written yet does not appear, which is
 * honest: it does not exist on the dashboard either.
 */
export async function readValues(
	server: string,
	ref: string,
	scope = 'dashboard'
): Promise<DashboardView | null> {
	const api = base(server);
	const token = readTokenOf(ref) || ref.trim();
	if (!api || !token) return null;

	let payload: any;
	try {
		// The scope is the PROGRAM's question, not ours — see SimxAnnouncement.
		const res = await fetch(
			`${api}/read?t=${encodeURIComponent(token)}&scope=${encodeURIComponent(scope)}`
		);
		if (!res.ok) return null;
		payload = await res.json();
	} catch {
		return null;
	}

	const rows: any[] = Array.isArray(payload?.w) ? payload.w : [];
	const clock = Number(payload?.ts) || 0;
	const zone = Number(payload?.tzo) || 0;
	const feeds = new Map<string, Feed>();
	const values: Value[] = [];
	for (const row of rows) {
		const key = String(row?.f ?? '').trim();
		if (!key) continue;
		if (!feeds.has(key)) feeds.set(key, { id: key, key, label: key, unit: '' });
		const raw = row?.v;
		const num = typeof raw === 'number' ? raw : Number(raw);
		values.push({
			feed: key,
			from_dev: String(row?.from ?? '0'),
			to_dev: String(row?.to ?? ''),
			num: Number.isFinite(num) && String(raw).trim() !== '' ? num : null,
			str: String(raw ?? ''),
			ts: new Date().toISOString()
		});
	}
	return { feeds: [...feeds.values()], values, clock, zone };
}

/**
 * Keep it current.
 *
 * A poll, not a realtime subscription: the realtime stream needs a PocketBase
 * session, and the panel has a token rather than a login. Two seconds is fast
 * enough for watching a value change while programming and slow enough that a
 * classroom of open editors does not become a load problem — the same
 * reasoning that puts the relay's own read poll at twelve.
 */
export function watchValues(
	server: string,
	ref: string,
	scope: string,
	onView: (view: DashboardView) => void
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const tick = async () => {
		if (stopped) return;
		const view = await readValues(server, ref, scope);
		if (stopped) return;
		if (view) onView(view);
		timer = setTimeout(tick, 2000);
	};
	void tick();

	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}

/**
 * Write the simulator's points to the dashboard — the panel's own road.
 *
 * Deliberately the SAME request a device with a WLAN module makes: `POST
 * <server>/ingest` carrying the program's own token. No campus tab in the
 * middle, no back-channel, no session — the panel has the two things the
 * request needs (the address and the credential) because the program told it
 * both, in the very announcement it already listens to.
 *
 * `dev` marks the sender as simulated (`sim-…`, which the extension itself
 * produces in `meineNummer`), so a dashboard shows at a glance that these
 * readings came from a program being written rather than from a mini on a
 * desk — and so they never collide with the real device's row.
 *
 * `dt` and `now` are 0 for the same reason the relay sends 0: a point posted
 * here was produced a fraction of a second ago and the server timestamps it on
 * arrival anyway.
 */
export async function sendPoints(
	server: string,
	ref: string,
	dev: string,
	points: { feed: string; value: string; to: string }[]
): Promise<boolean> {
	const api = base(server);
	if (!api || !points.length || !canWrite(ref)) return false;
	try {
		const res = await fetch(`${api}/ingest`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				// The whole reference, not just the `W-` half: the ingest accepts a
				// combined token and picks the half it needs (`pickToken` in the
				// hook), so splitting here would only add a second place to get it
				// wrong.
				t: ref.trim(),
				dev: dev || 'sim',
				now: 0,
				d: points.map((p) => ({ f: p.feed, v: coerce(p.value), dt: 0, to: p.to }))
			})
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Numbers stay numbers, everything else travels as text — as on the wire. */
function coerce(raw: string): number | string {
	const trimmed = raw.trim();
	if (trimmed === '') return '';
	const num = Number(trimmed);
	return Number.isFinite(num) ? num : raw;
}
