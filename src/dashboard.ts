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
 *
 * Reading only. The panel used to offer a switch that posted the simulator's
 * points to `<server>/ingest`, marked by a negative serial. Campus no longer
 * reads the sign as "simulated", so such points would land on the board as an
 * ordinary mini; until simulators get a marking of their own, the panel writes
 * nothing.
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

/**
 * Why a poll came back empty-handed, sorted by what the person in front of the
 * panel would have to check — the only reason to tell the cases apart at all.
 *
 *   address      the program names no server (or none that parses), or no
 *                dashboard: nothing was asked
 *   refused      the server answered, but not with the board: unknown slug,
 *                wrong token
 *   unreachable  no answer, or no usable one: wrong host, the server is down,
 *                the network is
 */
export type ReadFailure = 'address' | 'refused' | 'unreachable';

/**
 * Longer than any healthy answer takes, shorter than the browser's own limit,
 * which runs to minutes — a host that swallows the request without answering
 * would otherwise hold the poll, and with it the panel, at its last word.
 */
const READ_TIMEOUT_MS = 6000;

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
 *
 * A failure comes back as its reason rather than as nothing: the panel has to
 * be able to say that it cannot reach the board, not just keep waiting for it.
 */
export async function readValues(
	server: string,
	ref: string,
	scope = 'dashboard'
): Promise<DashboardView | ReadFailure> {
	const api = base(server);
	const token = readTokenOf(ref) || ref.trim();
	if (!api || !token) return 'address';

	let payload: any;
	try {
		// The scope is the PROGRAM's question, not ours — see SimxAnnouncement.
		const res = await fetch(
			`${api}/read?t=${encodeURIComponent(token)}&scope=${encodeURIComponent(scope)}`,
			{ signal: AbortSignal.timeout(READ_TIMEOUT_MS) }
		);
		// 4xx is the server's considered no; anything else is a server that is
		// not (all) there.
		if (res.status >= 400 && res.status < 500) return 'refused';
		if (!res.ok) return 'unreachable';
		payload = await res.json();
	} catch {
		return 'unreachable';
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
 *
 * It keeps polling through failures and reports each one: whether a run of them
 * is worth telling anybody about is the panel's call, and a board that comes
 * back has to be noticed without anyone pressing anything.
 */
export function watchValues(
	server: string,
	ref: string,
	scope: string,
	onView: (view: DashboardView) => void,
	onFailure: (reason: ReadFailure) => void
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const tick = async () => {
		if (stopped) return;
		const result = await readValues(server, ref, scope);
		if (stopped) return;
		if (typeof result === 'string') onFailure(result);
		else onView(result);
		timer = setTimeout(tick, 2000);
	};
	void tick();

	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
