/**
 * pi-crew - shell command builder and the "crew" channel renderer.
 *
 * The command shape mirrors pi's official subagent example:
 *
 *   pi --mode json -p --no-session [--model ..] [--thinking ..] [--tools ..]
 *      [--append-system-prompt <persona>] "Task: ..."
 *
 * handed to the async-jobs engine as a shell string instead of a spawn() call,
 * because that is the only surface the host service exposes (see ./consumer.ts).
 *
 * Transport: the task body travels on stdin (base64-encoded in the command, decoded
 * by the shell before pi reads it). It must NOT ride in an argument: through the
 * pi.cmd shim the command line caps at 8191 chars (cmd.exe), and the engine's own
 * spawn caps near 32K, so argument-transport fails silently on big tasks. The
 * persona travels as a FILE PATH for the same reason in spirit: pi.cmd goes through
 * cmd.exe, which re-parses the argument list, and a decoded multi-line persona -
 * which every real role body is - corrupts every argument after it, dropping the
 * task and making pi exit silently. --append-system-prompt reads file contents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobRecordLike, RendererLike, RenderContextLike } from "./consumer.ts";

/** Quote for bash: single quotes, with the POSIX escape for embedded single quotes. */
export function quote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Backslashes to forward slashes: Git Bash cd, node and pi all accept them. */
export function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

export function encodeText(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Write a role's persona to a per-role cache file and return its path.
 *
 * The persona must not ride in an argument (see the transport note above), and
 * --append-system-prompt accepts a file path and appends its contents - the same
 * mechanism pi's official subagent example uses with its temp prompt files. One
 * file per role name, overwritten on every dispatch, so no cleanup is needed.
 */
export function writePersonaFile(roleName: string, body: string): string {
	const safe = roleName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(os.tmpdir(), `pi-crew-persona-${safe}.md`);
	fs.writeFileSync(filePath, body, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

/**
 * Locate a pi entry, in descending order of trust:
 *
 *   1. PI_CREW_CLI env override.
 *   2. process.argv[1] - the official example's trick, which holds in the pi CLI
 *      (the running entry IS pi) but NOT in embedded SDK hosts: under piweb the
 *      entry is Next.js's bin, and spawning that with pi flags is how a dispatch
 *      once called `next -p` (= --port) and died. So only accept an argv[1] that
 *      lives inside a pi-coding-agent install.
 *   3. The pi installer's shim in ~/.local/bin (standard location, independent of
 *      where pi itself is installed).
 *   4. Bare `pi` on PATH.
 */
export function getPiInvocation(): { command: string; args: string[] } {
	const override = process.env.PI_CREW_CLI;
	if (override && fs.existsSync(override)) return { command: override, args: [] };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const looksLikePiEntry = currentScript != null && /pi-coding-agent[\\/]dist[\\/]/.test(currentScript);
	if (currentScript && !isBunVirtualScript && looksLikePiEntry && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	for (const shim of [
		path.join(os.homedir(), ".local", "bin", "pi.cmd"),
		path.join(os.homedir(), ".local", "bin", "pi"),
	]) {
		if (fs.existsSync(shim)) return { command: shim, args: [] };
	}

	return { command: "pi", args: [] };
}

export interface CrewCommandOptions {
	/** Working directory for the crew member: also the project it loads. */
	cwd: string;
	task: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	/** Path to a file holding the role's persona (see writePersonaFile). */
	systemPromptFile?: string;
}

export function buildCrewCommand(o: CrewCommandOptions): string {
	const pi = getPiInvocation();
	const parts = [
		`cd ${quote(toPosix(o.cwd))}`,
		"&&",
		`printf '%s' ${quote(encodeText(`Task: ${o.task}`))} | base64 -d |`,
		// Recursion guard: a crew member is itself a pi that loads this extension.
		// Seeing this variable in its environment, the extension declines to register
		// the dispatch tool, so a member cannot spawn members. NOTE the placement: an
		// env prefix on a pipeline binds to that segment only, so it must sit on the
		// pi segment - not on printf.
		"PI_CREW_GUARD=1",
		...[pi.command, ...pi.args].map((a) => quote(toPosix(a))),
		"--mode",
		"json",
		// Long form on purpose: some other CLI on the path binds -p to --port,
		// and an unvalidated entry used to dispatch one to it.
		"--print",
		"--no-session",
	];
	if (o.model) parts.push("--model", quote(o.model));
	if (o.thinking) parts.push("--thinking", quote(o.thinking));
	if (o.tools && o.tools.length > 0) parts.push("--tools", quote(o.tools.join(",")));
	if (o.systemPromptFile) {
		parts.push("--append-system-prompt", quote(toPosix(o.systemPromptFile)));
	}
	// stdin is prepended to the first prompt; this anchor tells the member what it is.
	// It disclaims itself so line-counting/quoting tasks are not polluted by it.
	parts.push(quote("（上方输入为任务正文，请执行。本句仅是指引，不属于正文。）"));
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Channel renderer: the job's output file is the --mode json JSONL event stream.
// ---------------------------------------------------------------------------

interface ParsedCrew {
	finalText: string;
	toolCalls: number;
	turns: number;
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	error?: string;
	stopReason?: string;
}

function parseCrewOutput(raw: string): ParsedCrew {
	const out: ParsedCrew = { finalText: "", toolCalls: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let e: any;
		try {
			e = JSON.parse(t);
		} catch {
			continue;
		}
		if (e.type !== "message_end" || !e.message) continue;
		const m = e.message;
		if (m.role !== "assistant") continue;
		out.turns++;
		const usage = m.usage;
		if (usage) {
			out.input += usage.input || 0;
			out.output += usage.output || 0;
			out.cacheRead += usage.cacheRead || 0;
			out.cost += usage.cost?.total || 0;
		}
		if (!out.model && m.model) out.model = m.model;
		if (m.errorMessage) out.error = m.errorMessage;
		if (m.stopReason) out.stopReason = m.stopReason;
		const blocks = Array.isArray(m.content) ? m.content : [];
		for (const b of blocks) {
			// Count real tool calls only: thinking blocks ride in the same content
			// array and used to inflate this number.
			if (b && b.type === "toolCall") out.toolCalls++;
		}
		const text = blocks
			.filter((b: any) => b?.type === "text")
			.map((b: any) => b.text || "")
			.join("")
			.trim();
		// Later assistant messages win: the final answer is what the caller wants.
		if (text) out.finalText = text;
	}
	return out;
}

function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

const FINAL_TEXT_CAP = 1500;

/**
 * Last human-readable line of the raw output - the likes of "Error: Model ... not
 * found" or bash's "cd: No such file or directory". JSON event lines are skipped so
 * the hint is the actual reason, not stream noise.
 */
function errorHint(raw: string): string {
	const nonJson: string[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		if (t.startsWith("{")) {
			try {
				JSON.parse(t);
				continue;
			} catch {
				// A brace line that is not JSON is still a message worth keeping.
			}
		}
		nonJson.push(t);
	}
	return (nonJson[nonJson.length - 1] ?? "").slice(0, 200);
}

function renderCrew(record: JobRecordLike, ctx: RenderContextLike): string {
	const raw = ctx.tailOutput(record.id, 96 * 1024).text;
	const p = parseCrewOutput(raw);
	const label = (record.name ?? "crew").replace(/^crew:\s*/, "");

	const lines: string[] = [];
	const icon = record.state === "failed" || p.error ? "✗" : record.state === "killed" ? "⛔" : "✓";
	lines.push(`${icon} ${label}`);

	if (p.finalText) {
		const text =
			p.finalText.length > FINAL_TEXT_CAP ? `${p.finalText.slice(0, FINAL_TEXT_CAP)}…` : p.finalText;
		lines.push("", text);
	} else if (p.error) {
		lines.push("", `错误：${p.error}`);
	} else if (record.error) {
		const hint = errorHint(raw);
		lines.push("", `错误：${record.error}${hint ? `\n原因：${hint}` : ""}`);
	} else {
		lines.push("", "(没有文本输出)");
	}

	const usage: string[] = [];
	if (p.turns) usage.push(`${p.turns} turns`);
	if (p.input) usage.push(`↑${fmtTokens(p.input)}`);
	if (p.output) usage.push(`↓${fmtTokens(p.output)}`);
	if (p.cacheRead) usage.push(`R${fmtTokens(p.cacheRead)}`);
	if (p.cost > 0) usage.push(`$${p.cost.toFixed(4)}`);
	if (p.model) usage.push(p.model);
	if (p.toolCalls) usage.push(`${p.toolCalls} tool calls`);
	if (usage.length > 0) lines.push("", `[${usage.join(" · ")}]`);

	return lines.join("\n");
}

function digestCrew(record: JobRecordLike): string {
	const label = (record.name ?? "crew").replace(/^crew:\s*/, "");
	const snippet = (record.output ?? record.summary ?? "").slice(0, 60);
	return `${label}: ${snippet}`;
}

export const crewChannel: RendererLike = {
	name: "crew",
	render: renderCrew,
	digest: digestCrew,
};
