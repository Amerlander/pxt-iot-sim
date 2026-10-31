/**
 * The simx side of the panel: what the simulator tells us, and how.
 *
 * pxt hands a simulator extension its messages as window `postMessage` of
 * shape `{ type: 'messagepacket', channel: '<package>', data: Uint8Array }`.
 * The IoT extension writes ordinary `IOT1:` lines, so the panel learns
 * everything it needs from the announcement the program makes at start:
 *
 *   IOT1:r:<scope>     whose values it wants to read
 *   IOT1:i:<serial>    who the device is
 *   IOT1:s:<server>    where the program wants to talk
 *   IOT1:h:<ref>       slug or token — WHICH dashboard; always last
 *   IOT1:d:<to>:<feed>:<value>   a datapoint it would have sent — ignored
 *                                here, the panel only reads the dashboard
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
	/** The device's own id, as the simulator reports it (`IOT1:i:`). */
	device: string;
	/**
	 * Whose values the program subscribed to (`IOT1:r:`) — d | g | a.
	 *
	 * Passed straight on to `/read`, because the panel is standing in for the
	 * device here and must ask the question the device asked. Without it the
	 * route answers with its default ("dashboard" only), so a program reading
	 * from other minis would sit there receiving nothing while the board
	 * beside it visibly filled up. Defaults to the same thing the route does,
	 * which is what every hex predating the line effectively asks for.
	 */
	scope: string;
};

/**
 * The human-readable half of a reference.
 *
 * A reference is `<slug>:R-…:W-…`, and the panel was showing all of it as its
 * heading — forty characters of credential where a name belongs, wrapped over
 * three lines. The slug is the part a person can match against the board in
 * front of them; the tokens are plumbing and belong nowhere near a heading.
 *
 * Returns the whole string when there is no slug (a bare token), because
 * something is better than an empty title and that case means the program
 * never named a dashboard a human could recognise.
 */
export function refLabel(ref: string): string {
	for (const part of ref.split(':')) {
		const p = part.trim();
		if (!p) continue;
		if (/^[RW]-/i.test(p)) continue;
		return p;
	}
	return ref.trim();
}

/*
 * No `onLine`. The panel used to keep the raw `IOT1:…` lines in a footer, where
 * they cost a fifth of its height to repeat, in protocol, what the readings
 * above them already said in words. The lines are still there for whoever needs
 * them in that form: the serial console in the editor, and the campus stream.
 */
export type SimxHandlers = {
	onAnnouncement?: (a: SimxAnnouncement) => void;
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
 * Tell the editor we exist.
 *
 * WITHOUT THIS THE PANEL RECEIVES NOTHING, AND NOT A SINGLE LINE, so it is the
 * first thing that happens here.
 *
 * pxt stamps every simulator frame it creates with `dataset.loading` and holds
 * back each `messagepacket` addressed to it until the frame says it is up —
 * `postDeferrableMessage` in `pxt/pxtsim/simdriver.ts`. The only two things
 * that clear that flag are a `{type:'ready', frameid}` message and a running
 * `status` from a pxt runtime. A simx panel is not a pxt runtime, so if it does
 * not send `ready` itself, its messages sit in `deferredMessages` for the
 * lifetime of the page.
 *
 * And the lines that get lost that way are exactly the ones that matter: the
 * program announces its dashboard (`IOT1:s:`/`IOT1:h:`) in the same tick that
 * spawns this frame, so the announcement is always the first thing deferred.
 * The panel then sat at "Kein Dashboard" forever while the program was running
 * fine — datapoints arriving later would have gone through, with nowhere to go.
 *
 * `frameid` is the fragment pxt put on our own URL (`furl += '#' + frame.id`),
 * and it has to be echoed verbatim: the driver looks the frame up by that id.
 * Same handshake jacdac-docs performs for the Jacdac dashboard.
 */
export function announceReady(): void {
	if (window.parent === window) return; // opened directly, not embedded
	window.parent.postMessage(
		{ type: 'ready', frameid: window.location.hash.slice(1) },
		// The editor's origin is not knowable here without trusting a query
		// parameter, and the message carries nothing secret — it says only "the
		// frame you just created has loaded". jacdac-docs posts it the same way.
		'*'
	);
}

/**
 * Send lines DOWN into the running simulator.
 *
 * The other half of the panel, and without it the simulated mini is deaf:
 * `iot.lese`, `wenn … empfangen` and the clock all wait for `IOT1:v:` /
 * `IOT1:t:` lines that nobody was writing. The panel is the only thing in the
 * simulator's world that talks to the server, so it is the only thing that can
 * write them.
 *
 * Deliberately the SAME lines a real device receives over its serial link. The
 * simulator therefore runs the identical code path — `empfangeZeile` in the
 * extension — and a program that behaves one way here behaves the same way on
 * the desk. A private simulator dialect would be a second truth, and the first
 * thing it would hide is a bug in the real one.
 *
 * The route needs no campus and no back-channel: the message goes to the
 * editor, and pxt's simulator driver hands every broadcast messagepacket to all
 * its frames — the running program among them.
 */
export function sendToSimulator(lines: string[]): void {
	if (window.parent === window || lines.length === 0) return;
	window.parent.postMessage(
		{
			type: 'messagepacket',
			channel: IOT_CHANNEL,
			broadcast: true,
			// One packet for the whole batch: the extension splits on newlines.
			// A packet per value would be a round of postMessage plumbing per
			// feed per poll, for lines that were all read in the same request.
			data: new TextEncoder().encode(lines.join('\n'))
		},
		'*'
	);
}

/**
 * Hand the dashboard's feed names to the editor's feed suggestions.
 *
 * The feed inputs of the IoT blocks are text fields with a suggestion list;
 * pxt-calliope (`fieldeditors/iotFeedOptions.ts`) adds whatever is posted to
 * the editor window as `calliope-iot-feeds`. Campus sends the same message
 * when it embeds the editor — this is the same help for MakeCode without
 * campus, where the panel is the only thing that knows the dashboard.
 *
 * Our parent is the editor window (pxt's simulator driver creates the simx
 * frame in the editor document), which is exactly where the receiver listens.
 */
export function sendFeedsToEditor(feeds: string[]): void {
	if (window.parent === window) return;
	window.parent.postMessage({ type: 'calliope-iot-feeds', feeds }, '*');
}

/**
 * How long a half-told announcement may wait for its `h:` line before it is
 * passed on anyway. Only hexes that send `h:` before the other lines need it
 * (see `listenToSimulator`); the lines of one hello come a few ms apart.
 */
const ANNOUNCEMENT_SETTLE_MS = 300;

/**
 * Listen for the simulator's IoT lines.
 *
 * The announcement is accumulated rather than replaced field by field: the
 * program sends `r:`, `i:`, `s:` and `h:` as separate lines a millisecond
 * apart, and a consumer that reacted to each one on its own would subscribe to
 * PocketBase with a server but no dashboard, then throw it away.
 *
 * And it is passed on ONCE, when it is complete, not after every line. A
 * restarted program's `r:` (or `s:`) arrives while `ref` still holds the
 * PREVIOUS program's dashboard; reported right then, it looked like "same
 * dashboard, new program" and the panel re-sent the old dashboard's clock and
 * values to a program that had named a different one — `wenn … empfangen`
 * fired for a board it never asked for. The extension sends `h:` last (the
 * reference may carry colons, so it ends the hello on its own line), so `h:`
 * completes it. Hexes that sent `h:` first and `i:`/`r:` after it get their
 * late lines passed on once they settle.
 */
export function listenToSimulator(handlers: SimxHandlers): () => void {
	const announcement: SimxAnnouncement = { ref: '', server: '', device: '', scope: 'dashboard' };
	let settle: ReturnType<typeof setTimeout> | undefined;

	const report = () => {
		clearTimeout(settle);
		settle = undefined;
		if (announcement.ref) handlers.onAnnouncement?.({ ...announcement });
	};

	const onMessage = (event: MessageEvent) => {
		const msg = event.data as { type?: unknown; channel?: unknown; data?: unknown } | null;
		if (!msg || typeof msg !== 'object') return;
		if (msg.type !== 'messagepacket' || msg.channel !== IOT_CHANNEL) return;

		// Per packet, not per line: a packet carrying the whole hello is
		// reported once, after all of its lines.
		let complete = false;
		let partial = false;

		for (const raw of toText(msg.data).split('\n')) {
			const line = raw.replace(/\r$/, '').trim();
			if (!line.startsWith(WIRE_PREFIX)) continue;

			const body = line.slice(WIRE_PREFIX.length);
			const kind = body.slice(0, 1);
			const rest = body.slice(2);

			if (kind === 'h') {
				announcement.ref = rest.trim();
				complete = true;
			} else if (kind === 's') {
				announcement.server = rest.trim();
				partial = true;
			} else if (kind === 'i') {
				announcement.device = rest.trim();
				partial = true;
			} else if (kind === 'r') {
				// One letter on the wire, because it has to fit a 20-byte serial
				// buffer on the real device. Spelled out here, because that is
				// what the route's query parameter expects.
				const code = rest.trim().toLowerCase();
				announcement.scope =
					code === 'a' || code === 'all'
						? 'all'
						: code === 'g' || code === 'devices'
							? 'devices'
							: 'dashboard';
				partial = true;
			}
		}

		if (complete) report();
		else if (partial) {
			clearTimeout(settle);
			settle = setTimeout(report, ANNOUNCEMENT_SETTLE_MS);
		}
	};

	window.addEventListener('message', onMessage);
	return () => {
		clearTimeout(settle);
		window.removeEventListener('message', onMessage);
	};
}
