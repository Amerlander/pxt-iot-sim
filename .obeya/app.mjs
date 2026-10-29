#!/usr/bin/env node
/**
 * Runs the panel for an Obeya worker: the vite dev server plus a fake dashboard
 * server with sample values, and a page that embeds the panel the way MakeCode
 * does (an iframe beside a "simulator" that announces a dashboard).
 *
 *   node .obeya/app.mjs start   start both in the background, print the URLs
 *   node .obeya/app.mjs stop    stop what `start` started in this workspace
 *
 * The panel only shows something once a program announces a dashboard and the
 * dashboard's server answers `/read`; neither exists without a running campus
 * and a real token, so the fake server stands in for both. Nothing here is part
 * of the panel: it only talks to it through the same postMessage packets pxt
 * would send.
 *
 * PIDs, URLs and logs go into node_modules/ (git ignores it), so every
 * workspace has its own and `stop` never touches another workspace's app.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(root, 'node_modules');
const stateFile = path.join(stateDir, '.obeya-app.json');
const HOST = '127.0.0.1';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'start') await start();
else if (mode === 'stop') stop();
else if (mode === 'fake') serveFake(Number(args[0]), args[1]);
else {
	console.error('usage: node .obeya/app.mjs start|stop');
	process.exit(2);
}

// ── start / stop ──────────────────────────────────────────────────────────

async function start() {
	const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
	if (!fs.existsSync(vite)) {
		console.error('vite is not installed here: run `npm ci` first.');
		process.exit(1);
	}
	stop(true);

	// 3400 is the port the targetconfig's devUrl names, so a local MakeCode with
	// simxdev=1 finds the panel there; another workspace may hold it already.
	const panelPort = await freePort(3400);
	const fakePort = await freePort(3401);
	const panelUrl = `http://localhost:${panelPort}/`;
	const harnessUrl = `http://${HOST}:${fakePort}/`;

	const log = fs.openSync(path.join(stateDir, '.obeya-app.log'), 'a');
	const run = (argv) =>
		spawn(process.execPath, argv, {
			cwd: root,
			detached: true,
			windowsHide: true,
			stdio: ['ignore', log, log]
		});
	const panel = run([vite, '--port', String(panelPort), '--strictPort']);
	const fake = run([fileURLToPath(import.meta.url), 'fake', String(fakePort), panelUrl]);
	panel.unref();
	fake.unref();

	const state = { pids: [panel.pid, fake.pid], panelUrl, harnessUrl };
	fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

	if (!(await answers(panelUrl)) || !(await answers(harnessUrl))) {
		console.error(`did not come up; see ${path.join(stateDir, '.obeya-app.log')}`);
		stop(true);
		process.exit(1);
	}
	console.log(`Panel alone:            ${panelUrl}`);
	console.log(`Panel with sample data: ${harnessUrl}`);
	console.log(`Stop with:              node .obeya/app.mjs stop`);
}

function stop(quiet = false) {
	if (!fs.existsSync(stateFile)) {
		if (!quiet) console.log('nothing running here');
		return;
	}
	const { pids = [] } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	for (const pid of pids) {
		try {
			if (process.platform === 'win32')
				execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
			else process.kill(-pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
	fs.rmSync(stateFile, { force: true });
	if (!quiet) console.log(`stopped ${pids.join(', ')}`);
}

function freePort(preferred) {
	const tryPort = (port) =>
		new Promise((resolve) => {
			const server = net.createServer();
			server.once('error', () => resolve(null));
			server.listen(port, HOST, () => {
				const { port: got } = server.address();
				server.close(() => resolve(got));
			});
		});
	return tryPort(preferred).then((port) => port ?? tryPort(0));
}

async function answers(url) {
	for (let i = 0; i < 60; i++) {
		try {
			if ((await fetch(url)).ok) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

// ── the fake dashboard ────────────────────────────────────────────────────

/**
 * Answers `/api/iot/v1/read` the way campus does (`w: [{ f, v, from, to }]`,
 * newest first, plus `ts`/`tzo`), with values that move so a demo shows the
 * panel following them. `/` is the harness page.
 */
function serveFake(port, panelUrl) {
	const started = Date.now();
	const MINI = '48213';

	const rows = (scope) => {
		const t = (Date.now() - started) / 1000;
		const board = [
			{ f: 'temperatur', v: Math.round((22 + 2 * Math.sin(t / 8)) * 10) / 10, from: '0', to: '' },
			{ f: 'nachricht', v: 'Hallo Klasse 4b', from: '0', to: '' },
			{ f: 'ziel', v: 50, from: '0', to: MINI }
		];
		const minis = [
			{ f: 'licht', v: 120 + ((10 * Math.floor(t / 6)) % 120), from: MINI, to: '' },
			{ f: 'temperatur', v: 24, from: MINI, to: '' }
		];
		if (scope === 'all') return [...board, ...minis];
		if (scope === 'devices') return minis;
		return board;
	};

	createServer((req, res) => {
		const url = new URL(req.url, `http://${HOST}:${port}`);
		if (url.pathname === '/api/iot/v1/read') {
			if (url.searchParams.get('t') !== 'R-demo') {
				res.writeHead(403, { 'access-control-allow-origin': '*' });
				return res.end();
			}
			res.writeHead(200, {
				'content-type': 'application/json',
				'access-control-allow-origin': '*'
			});
			return res.end(
				JSON.stringify({
					w: rows(url.searchParams.get('scope') ?? 'dashboard'),
					ts: Math.floor(Date.now() / 1000),
					tzo: -new Date().getTimezoneOffset()
				})
			);
		}
		if (url.pathname === '/') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			return res.end(harness(panelUrl, `http://${HOST}:${port}`));
		}
		res.writeHead(404);
		res.end();
	}).listen(port, HOST);
}

/**
 * Stands in for the editor: embeds the panel at its MakeCode size (aspect
 * ratio 0.78), waits for its `ready`, then announces the dashboard as the IoT
 * extension does. Beside it, what the panel sends back: the `IOT1:` lines for
 * the simulated mini and the feed names for the editor's suggestions.
 * `?scope=d|g|a` picks whose values the "program" reads (default a).
 */
function harness(panelUrl, server) {
	return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>IoT-Panel mit Beispieldaten</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; display: flex; gap: 24px; background: #f3f4f6; }
  .sim { width: 300px; }
  iframe { width: 300px; height: 385px; border: 1px solid #ccc; background: #fff; border-radius: 6px; }
  h2 { font-size: 13px; text-transform: uppercase; color: #555; margin: 0 0 8px; }
  pre { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 8px; height: 300px; width: 380px; overflow: auto; margin: 0; }
  p { color: #555; max-width: 380px; }
</style></head><body>
<div class="sim"><h2>Simulator-Panel</h2><iframe id="panel" src="${panelUrl}#obeya-harness"></iframe></div>
<div><h2>Vom Panel an den Simulator</h2><pre id="log"></pre>
<p id="feeds">Feed-Vorschläge an den Editor: –</p></div>
<script>
  const scope = new URLSearchParams(location.search).get('scope') || 'a';
  const frame = document.getElementById('panel');
  const log = document.getElementById('log');
  const lines = ['IOT1:s:${server}', 'IOT1:h:demo-klasse:R-demo', 'IOT1:i:1', 'IOT1:r:' + scope];
  addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'ready') {
      frame.contentWindow.postMessage({ type: 'messagepacket', channel: 'iot',
        data: new TextEncoder().encode(lines.join('\\n')) }, '*');
    } else if (m.type === 'messagepacket') {
      const time = new Date().toLocaleTimeString('de-DE');
      log.textContent += new TextDecoder().decode(m.data).split('\\n').map((l) => time + '  ' + l).join('\\n') + '\\n';
      log.scrollTop = log.scrollHeight;
    } else if (m.type === 'calliope-iot-feeds') {
      document.getElementById('feeds').textContent = 'Feed-Vorschläge an den Editor: ' + m.feeds.join(', ');
    }
  });
</script></body></html>`;
}
