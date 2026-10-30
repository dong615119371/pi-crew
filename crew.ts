/**
 * pi-crew - the `crew_async` tool and its activation.
 *
 * A consumer of the async-jobs host, same shape as pi-delegate's delegate.ts:
 * the tool is registered but NOT active by default; it switches on when the host
 * service arrives over `pi.events`. The channel renderer is registered alongside
 * the tool that produces such jobs, so the two cannot drift apart.
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildCrewCommand, crewChannel, writePersonaFile } from "./channel.ts";
import { connectToHost, HOST_API_VERSION } from "./consumer.ts";
import { discoverRoles, formatRoleList } from "./agents.ts";

const TOOL_DEFAULTS = { defaultActive: false } as const;

const CREW_TIMEOUT_SECONDS = 30 * 60;
const MAX_PARALLEL = 8;
const PREVIEW_CHARS = 100;

function preview(text: string, max = PREVIEW_CHARS): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * Register the crew tool, leaving it inactive.
 *
 * Returns an `activate` function that registers the renderer and puts the tool into
 * the active set. Safe to call repeatedly; returns false while no host is present,
 * which is not an error - it means this package is running without async-jobs.
 */
export function registerCrewTool(pi: any): () => boolean {
	const host = connectToHost(pi);
	let svc: any = null;

	/** The host service, fetched lazily: it may not have arrived when this factory runs. */
	const getService = () => {
		if (!svc) svc = host.service();
		return svc;
	};

	/** Register the renderer; replaces by name, so calling it again is safe. */
	const ensureChannel = () => {
		const current = getService();
		if (!current) return;
		current.registerChannel(crewChannel);
	};

	pi.on("session_start", ensureChannel);
	ensureChannel();

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "crew_async",
		label: "Crew (background)",
		description: [
			"Hand work to pi crew members (subagents) and return immediately.",
			"Each member is a fresh headless pi process with its own clean context - same models, skills, MCP servers and AGENTS.md as this session, but it CANNOT see this conversation.",
			"Roles come from ~/.pi/agent/agents/*.md (by default: worker, scout, planner, reviewer).",
			"Use it for legwork - bulk edits, mechanical refactors, repetitive changes, long grunt work - not for decisions.",
			"Every path in a task must be absolute: the member starts in its own cwd and loads the project found there.",
			"Results arrive as messages when each member settles; do not poll for them.",
			"After starting jobs, carry on with your own work or end your turn.",
			"If the next step needs a member's result, do that step yourself instead - there is no async answer for a dependency.",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					role: Type.String({
						description: "Crew role name, from ~/.pi/agent/agents/*.md (e.g. worker, scout, planner, reviewer)",
					}),
					task: Type.String({
						description: "Self-contained task for this member; absolute paths; it cannot see this conversation",
					}),
					cwd: Type.Optional(
						Type.String({ description: "Working directory for this member (defaults to this session's cwd)" }),
					),
					model: Type.Optional(
						Type.String({ description: "pi model id for this member; overrides the role's model" }),
					),
					thinking: Type.Optional(
						Type.String({
							description: "Thinking level: off | minimal | low | medium | high | xhigh | max",
						}),
					),
				}),
				{ description: "Tasks to dispatch to crew members in the background" },
			),
			timeoutSeconds: Type.Optional(
				Type.Number({ description: `Per-task timeout in seconds. Default ${CREW_TIMEOUT_SECONDS}.` }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.tasks.length === 0) {
				return { content: [{ type: "text", text: "Provide at least one task." }], details: undefined };
			}
			if (params.tasks.length > MAX_PARALLEL) {
				return {
					content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL}.` }],
					details: undefined,
				};
			}

			// The renderer has to be registered before the first job it will render settles.
			ensureChannel();
			if (!getService()) {
				return {
					content: [
						{ type: "text", text: "The async-jobs host service is not available yet. Try again in a moment." },
					],
					details: undefined,
				};
			}

			const roles = discoverRoles();
			const byName = new Map(roles.map((r) => [r.name, r]));
			const unknown = [...new Set(params.tasks.map((t) => t.role))].filter((r) => !byName.has(r));
			if (unknown.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown role: ${unknown.join(", ")}.\nAvailable roles in ~/.pi/agent/agents:\n${formatRoleList(roles)}`,
						},
					],
					details: undefined,
				};
			}

			const started: Array<{ id: string; role: string; task: string }> = [];
			for (const item of params.tasks) {
				const role = byName.get(item.role)!;
				try {
					const handle = svc.startProcess({
						command: buildCrewCommand({
							cwd: item.cwd ?? ctx.cwd,
							task: item.task,
							model: item.model ?? role.model,
							thinking: item.thinking,
							tools: role.tools,
							systemPromptFile:
								role.systemPrompt.trim() !== "" ? writePersonaFile(role.name, role.systemPrompt) : undefined,
						}),
						name: `crew:${role.name}: ${preview(item.task, 60)}`,
						kind: "crew",
						channel: "crew",
						timeoutSeconds: params.timeoutSeconds ?? CREW_TIMEOUT_SECONDS,
					});
					started.push({ id: handle.id, role: role.name, task: item.task });
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Started ${started.length} job(s), then failed: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { jobs: started },
					};
				}
			}

			const lines = started.map((s) => `  ${s.id}  [${s.role}]  ${preview(s.task)}`);
			return {
				content: [
					{
						type: "text",
						text:
							`Dispatched ${started.length} crew member(s). This call has already returned - it did NOT block.\n` +
							`What to do now: carry on with your own work, or end your turn. ` +
							`Each member's result arrives as a message when it settles - no action needed, do not poll.\n` +
							`Job ids:\n${lines.join("\n")}`,
					},
				],
				details: { jobs: started },
			};
		},

		renderCall(args: any, theme: any, _context: any) {
			const tasks = args?.tasks ?? [];
			let text = `${theme.fg("toolTitle", theme.bold("crew_async "))}${theme.fg("accent", `x${tasks.length}`)}`;
			for (const t of tasks.slice(0, 3)) {
				text += `\n  ${theme.fg("dim", `[${t.role ?? "?"}]`)} ${theme.fg("muted", preview(t.task ?? "", 60))}`;
			}
			if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _opts: any, theme: any, _context: any) {
			const first = result?.content?.[0];
			return new Text(theme.fg("toolOutput", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});

	/**
	 * Turn the tool on, if the host is there - same contract as pi-delegate: renderer
	 * and tool switch on together, version mismatch is reported once via env and then
	 * left alone, and a missing tool registration is treated as "not active".
	 */
	return () => {
		const current = getService();
		if (!current) return false;

		if (host.status() === "incompatible") {
			process.env.PI_CREW_HOST_MISMATCH = `host apiVersion ${String(current.apiVersion)} != expected ${String(HOST_API_VERSION)}`;
			return false;
		}

		current.registerChannel(crewChannel);

		if (!pi.getAllTools().some((tool: any) => tool.name === "crew_async")) return false;

		const active = new Set(pi.getActiveTools());
		active.add("crew_async");
		pi.setActiveTools([...active]);
		return true;
	};
}
