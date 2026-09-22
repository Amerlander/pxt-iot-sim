/**
 * The simx side of the panel: what the simulator tells us, and how.
 *
 * pxt hands a simulator extension its messages as window `postMessage` of
 * shape `{ type: 'messagepacket', channel: '<package>', data: Uint8Array }`.
 * The IoT extension writes ordinary `IOT1:` lines, so the panel learns
 * everything it needs from the announcement the program makes at start:
 *
 *   IOT1:s:<server>    where the program wants to talk
 *   IOT1:h:<ref>       slug or token — WHICH dashboard
 *   IOT1:i:<serial>    who the device is
 *   IOT1:r:<scope>     whose values it wants to read
 *   IOT1:d:<to>:<feed>:<value>   a datapoint it would have sent
 *
 * Deliberately no second protocol: the panel reads the same lines a real
 * device would write, so anything it shows is something a device would really
 * have sent. A panel with its own private channel would be a second truth, and
 * the first thing it would hide is a program that talks to nobody.
 */

export const IOT_CHANNEL = 'iot';
const WIRE_PREFIX = 'IOT1:';

export type SimxAnnouncement = {
	/** Slug or token from the dashboard block. Empty until the program says it. */
	ref: string;
	/** Server the program names, if it names one. */
	server: string;
	/** The device's own id, as the simulator reports it (`sim-…`). */
	device: string;
};

export type SimxDatapoint = { feed: string; value: string; to: string };

export type SimxHandlers = {
	onAnnouncement?: (a: SimxAnnouncement) => void;
	onDatapoint?: (p: SimxDatapoint) => void;
	/** Every line, raw — the panel shows them as a log, like the campus stream. */
	onLine?: (line: string) => void;
};

/** pxt may hand the payload over as text or as bytes; accept both. */
function toText(data: unknown): string {
	if (typeof data === 'string') return data;
	if (data instanceof Uint8Array) return new TextDecoder().decode(data);
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		const v = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
	}
	return '';
}

/**
 * Listen for the simulator's IoT lines.
 *
 * The announcement is accumulated rather than replaced field by field: the
 * program sends `s:`, `h:`, `i:` and `r:` as separate lines a millisecond
 * apart, and a consumer that reacted to each one on its own would subscribe to
 * PocketBase with a server but no dashboard, then throw it away.
 */
export function listenToSimulator(handlers: SimxHandlers): () => void {
	const announcement: SimxAnnouncement = { ref: '', server: '', device: '' };

	const onMessage = (event: MessageEvent) => {
		const msg = event.data as { type?: unknown; channel?: unknown; data?: unknown } | null;
		if (!msg || typeof msg !== 'object') return;
		if (msg.type !== 'messagepacket' || msg.channel !== IOT_CHANNEL) return;

		for (const raw of toText(msg.data).split('\n')) {
			const line = raw.replace(/\r$/, '').trim();
			if (!line.startsWith(WIRE_PREFIX)) continue;
			handlers.onLine?.(line);

			const body = line.slice(WIRE_PREFIX.length);
			const kind = body.slice(0, 1);
			const rest = body.slice(2);

			if (kind === 'h') {
				announcement.ref = rest.trim();
				handlers.onAnnouncement?.({ ...announcement });
			} else if (kind === 's') {
				announcement.server = rest.trim();
				if (announcement.ref) handlers.onAnnouncement?.({ ...announcement });
			} else if (kind === 'i') {
				announcement.device = rest.trim();
				if (announcement.ref) handlers.onAnnouncement?.({ ...announcement });
			} else if (kind === 'd') {
				// <to>:<feed>:<value…> — the value is last and may contain colons.
				const first = rest.indexOf(':');
				const second = rest.indexOf(':', first + 1);
				if (first < 0 || second < 0) continue;
				const feed = rest.slice(first + 1, second).trim();
				if (!feed) continue;
				handlers.onDatapoint?.({
					to: rest.slice(0, first).trim(),
					feed,
					value: rest.slice(second + 1)
				});
			}
		}
	};

	window.addEventListener('message', onMessage);
	return () => window.removeEventListener('message', onMessage);
}
