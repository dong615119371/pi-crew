/**
 * pi-crew - crew role discovery.
 *
 * Ported from pi's official subagent example (examples/extensions/subagent/agents.ts),
 * trimmed to user scope: roles are the .md files in ~/.pi/agent/agents - the same
 * files the built-in Agent tool and the official example read. Discovery runs fresh
 * on every dispatch, so editing a role file takes effect on the next task.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

/**
 * Raw role frontmatter. Values are `unknown` because `parseFrontmatter` runs a real
 * YAML parser, so any scalar or collection can appear here.
 */
type RoleFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else yields no tools rather than throwing: a single bad
 * role file must not take down the other roles in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadRolesFromDir(dir: string): AgentConfig[] {
	const roles: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return roles;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return roles;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<RoleFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		roles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			filePath,
		});
	}

	return roles;
}

/** Discover crew roles from ~/.pi/agent/agents. Fresh on every call. */
export function discoverRoles(): AgentConfig[] {
	return loadRolesFromDir(path.join(getAgentDir(), "agents"));
}

/** One-line-per-role listing for error messages. */
export function formatRoleList(roles: AgentConfig[]): string {
	if (roles.length === 0) return "  (no roles found in ~/.pi/agent/agents)";
	return roles
		.map((r) => `  ${r.name}: ${r.description}${r.model ? ` [model: ${r.model}]` : ""}`)
		.join("\n");
}
