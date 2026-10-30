/**
 * pi-crew - dispatch pi subagents (crew members) as background jobs.
 *
 * The missing half of pi's official subagent example: that one blocks the turn while
 * the member runs; this one hands the member to the async-jobs engine and returns a
 * job id immediately, with the result arriving later as a message.
 *
 * One tool, and it is conditional:
 *
 *   `crew_async`  only when the async-jobs host is installed. Fires the job and
 *                 returns a job id; the member's output arrives later.
 *
 * Structure follows pi-delegate (a proven consumer of the same host):
 *   index.ts    this entry: recursion guard + activation wiring
 *   crew.ts     the tool
 *   channel.ts  shell command builder + the "crew" channel renderer
 *   agents.ts   role discovery over ~/.pi/agent/agents/*.md
 *   consumer.ts host handshake over pi.events (copied from pi-delegate)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCrewTool } from "./crew.ts";

export default function (pi: ExtensionAPI) {
	// Recursion guard. A crew member is itself a pi and loads this very extension; the
	// dispatched command puts PI_CREW_GUARD=1 in its environment, and a member that
	// sees it declines to register the dispatch tool. Members do not spawn members.
	if (process.env.PI_CREW_GUARD) return;

	const activateCrew = registerCrewTool(pi);

	// Two chances to notice the host, because the two packages can load in either
	// order - same as pi-delegate:
	//   - `session_start`: every factory has returned, so a host that loaded first has
	//     already published its service.
	//   - the host announcing itself: covers a host that loads after this extension.
	const tryActivate = () => {
		activateCrew();
		if (process.env.PI_CREW_HOST_MISMATCH) {
			// Reported once: a tool that throws from inside reads as "broken tool"
			// rather than "two packages disagree about the interface".
			console.warn(`[pi-crew] ${process.env.PI_CREW_HOST_MISMATCH} - crew dispatch is off; align package versions.`);
			delete process.env.PI_CREW_HOST_MISMATCH;
		}
	};

	pi.on("session_start", tryActivate);
	pi.events.on("async-jobs:host-ready", tryActivate);
}
