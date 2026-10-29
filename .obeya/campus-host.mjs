#!/usr/bin/env node
// Runs calliope-campus's Vite dev server against THIS checkout of the widget,
// so a worker can see a widget change in the app that uses it.
//
// campus's vite.config.js aliases the widget to `../../lib/mini-connection-widget/src`
// (the calliope-dev superrepo layout) in dev. This script rebuilds that layout in a
// scratch directory per workspace:
//
//   <host>/editors/calliope-campus   shared clone of the campus checkout, at its HEAD
//   <host>/lib/mini-connection-widget -> junction/symlink to this workspace
//
// Usage (from the workspace root):
//   node .obeya/campus-host.mjs start   prints the app's URL (also in <host>/dev.url)
//   node .obeya/campus-host.mjs stop    stops the dev server and removes <host>
//   node .obeya/campus-host.mjs status  prints the URL when it runs, else nothing
//
// Env: CAMPUS_REPO overrides where campus is cloned from (default: the superrepo's
// editors/calliope-campus beside this repo's main checkout).

import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const workspace = path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd()));
const scratchRoot = fs.existsSync(path.parse(workspace).root + 'tmp')
	? path.join(path.parse(workspace).root, 'tmp') // same drive as the pnpm store on Windows
	: os.tmpdir();
const host = path.join(scratchRoot, 'mcw-campus-host', path.basename(workspace));
const campus = path.join(host, 'editors', 'calliope-campus');
const link = path.join(host, 'lib', 'mini-connection-widget');
const pidFile = path.join(host, 'dev.pid');
const urlFile = path.join(host, 'dev.url');
const logFile = path.join(host, 'dev.log');

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function campusSource() {
	if (process.env.CAMPUS_REPO) return path.resolve(process.env.CAMPUS_REPO);
	// The main checkout of this repo: a submodule's git dir names it in core.worktree.
	const common = path.resolve(workspace, git(['rev-parse', '--git-common-dir'], workspace));
	let main;
	try {
		main = path.resolve(common, git(['config', 'core.worktree'], common));
	} catch {
		main = path.dirname(common);
	}
	const candidate = path.resolve(main, '..', '..', 'editors', 'calliope-campus');
	if (!fs.existsSync(candidate)) {
		throw new Error(`calliope-campus not found at ${candidate}; set CAMPUS_REPO`);
	}
	return candidate;
}

function running() {
	if (!fs.existsSync(pidFile)) return null;
	const pid = Number(fs.readFileSync(pidFile, 'utf8'));
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

function freePort(from) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once('error', () => resolve(freePort(from + 1)));
		srv.listen(from, '127.0.0.1', () => srv.close(() => resolve(from)));
	});
}

async function start() {
	if (running() && fs.existsSync(urlFile)) {
		console.log(fs.readFileSync(urlFile, 'utf8').trim());
		return;
	}
	const source = campusSource();
	const ref = git(['rev-parse', 'HEAD'], source);
	if (fs.existsSync(campus) && !fs.existsSync(path.join(campus, '.git'))) {
		fs.rmSync(campus, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); // half removed
	}
	if (!fs.existsSync(campus)) {
		fs.mkdirSync(path.dirname(campus), { recursive: true });
		git(['clone', '-q', '--shared', '--no-checkout', source, campus], host);
	}
	// Forced every time: it also restores files a stop could not remove.
	git(['checkout', '-q', '-f', '--detach', ref], campus);
	if (!fs.existsSync(link)) {
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(workspace, link, isWin ? 'junction' : 'dir');
	}
	// The checkout's locally trusted localhost certificate (mkcert, gitignored), where it has one;
	// without it campus falls back to a self-signed one that browsers warn about.
	const certs = path.join(source, 'certs');
	if (fs.existsSync(certs) && !fs.existsSync(path.join(campus, 'certs'))) {
		fs.cpSync(certs, path.join(campus, 'certs'), { recursive: true });
	}
	if (!fs.existsSync(path.join(campus, '.env'))) {
		fs.copyFileSync(path.join(campus, '.env.example'), path.join(campus, '.env'));
	}
	// Reinstall when the lock file changed since the last install.
	const lock = fs.readFileSync(path.join(campus, 'pnpm-lock.yaml'), 'utf8');
	const stamp = path.join(host, 'installed.lock');
	const installed = fs.existsSync(stamp) && fs.existsSync(path.join(campus, 'node_modules', 'vite'));
	if (!installed || fs.readFileSync(stamp, 'utf8') !== lock) {
		execSync('pnpm install --frozen-lockfile', {
			cwd: campus,
			stdio: ['ignore', process.stderr, process.stderr]
		});
		fs.writeFileSync(stamp, lock);
	}
	await stop({ keepHost: true }); // a server left without its URL
	const port = await freePort(5300);
	const out = fs.openSync(logFile, 'w');
	// Run Vite's own entry with node, so the PID is the server's (no shell in between).
	const vite = path.join(campus, 'node_modules', 'vite', 'bin', 'vite.js');
	const child = spawn(process.execPath, [vite, 'dev', '--host', '127.0.0.1', '--strictPort'], {
		cwd: campus,
		env: { ...process.env, CAMPUS_PORT: String(port) },
		stdio: ['ignore', out, out],
		detached: true,
		windowsHide: true
	});
	child.unref();
	fs.writeFileSync(pidFile, String(child.pid));
	const url = `https://127.0.0.1:${port}/`; // the mkcert certificate covers 127.0.0.1 too
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const log = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
		if (/Local:/.test(log)) {
			fs.writeFileSync(urlFile, url);
			console.log(url);
			return;
		}
		if (!running()) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.error(fs.readFileSync(logFile, 'utf8'));
	throw new Error(`campus dev server did not come up; log: ${logFile}`);
}

async function stop({ keepHost = false } = {}) {
	const pid = running();
	if (pid) {
		if (isWin) {
			try {
				execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
			} catch {}
		} else {
			try {
				process.kill(-pid, 'SIGTERM');
			} catch {}
		}
		// Windows releases the server's files only once its processes are gone.
		for (let i = 0; i < 20 && running(); i++) await new Promise((r) => setTimeout(r, 500));
	}
	fs.rmSync(pidFile, { force: true });
	fs.rmSync(urlFile, { force: true });
	if (keepHost || !fs.existsSync(host)) return;
	// Remove the link first, so removing the host never reaches into the workspace; the
	// install stamp next, so a host only partly removed is installed afresh.
	fs.rmSync(path.join(host, 'installed.lock'), { force: true });
	if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link);
	try {
		fs.rmSync(host, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
	} catch (error) {
		// The server is stopped; a scratch directory left behind is removed by the next stop.
		console.error(`could not remove ${host} yet: ${error.message}`);
	}
}

const cmd = process.argv[2];
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'status') {
	if (running() && fs.existsSync(urlFile)) console.log(fs.readFileSync(urlFile, 'utf8').trim());
} else {
	console.error('usage: node .obeya/campus-host.mjs start|stop|status');
	process.exit(2);
}
