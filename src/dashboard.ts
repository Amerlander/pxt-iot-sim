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
};

/** `R-…`, `W-…` or `R-…:W-…` — anything else is a slug. */
function readTokenOf(ref: string): string {
	for (const part of ref.split(':')) {
		const p = part.trim();
		if (/^R-/i.test(p)) return p;
	}
	return '';
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
export async function readValues(server: string, ref: string): Promise<DashboardView | null> {
	const api = base(server);
	const token = readTokenOf(ref) || ref.trim();
	if (!api || !token) return null;

	let payload: any;
	try {
		const res = await fetch(`${api}/read?t=${encodeURIComponent(token)}`);
		if (!res.ok) return null;
		payload = await res.json();
	} catch {
		return null;
	}

	const rows: any[] = Array.isArray(payload?.w) ? payload.w : [];
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
	return { feeds: [...feeds.values()], values };
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
	onView: (view: DashboardView) => void
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const tick = async () => {
		if (stopped) return;
		const view = await readValues(server, ref);
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
