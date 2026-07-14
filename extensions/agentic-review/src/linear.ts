import type { AgenticReviewConfig } from "./config.ts";
import type { BugAnalysis, Finding, LinkedIssue, LoggedTicket, PrContext } from "./types.ts";

interface LinearTeam {
	id: string;
	key: string;
	name: string;
}

interface GraphQlResponse<T> {
	data?: T;
	errors?: Array<{ message?: string }>;
}

export class LinearClient {
	private resolvedTeamId?: string;

	constructor(private config: AgenticReviewConfig["linear"]) {}

	get available(): boolean {
		return this.config.enabled && Boolean(this.config.apiKey);
	}

	async lookupIssue(identifier: string): Promise<LinkedIssue | undefined> {
		if (!this.available) return undefined;
		try {
			const data = await this.query<{
				issue?: { identifier?: string; title?: string; description?: string; url?: string } | null;
			}>(
				`query AgenticReviewIssue($id: String!) {
					issue(id: $id) { identifier title description url }
				}`,
				{ id: identifier },
			);
			if (!data.issue) return undefined;
			return {
				source: "linear",
				key: data.issue.identifier ?? identifier,
				title: data.issue.title,
				description: data.issue.description,
				url: data.issue.url,
			};
		} catch {
			// A linked issue is useful context, not a prerequisite for reviewing.
			return undefined;
		}
	}

	async createDeferredTicket(pr: PrContext, finding: Finding, analysis: BugAnalysis): Promise<LoggedTicket> {
		if (!this.config.enabled) throw new Error("Linear deferral logging is disabled");
		if (!this.config.apiKey) throw new Error("LINEAR_API_KEY is not configured");
		const teamId = await this.resolveTeamId(pr.linkedIssue?.key);
		const title = truncate(
			`Deferred PR edge case [${pr.repo.nameWithOwner}#${pr.number}@${pr.headSha.slice(0, 12)}:${finding.id}]: ${finding.title}`,
			250,
		);
		const existing = await this.findIssueByTitle(title);
		if (existing) {
			return {
				findingId: finding.id,
				identifier: existing.identifier,
				url: existing.url,
				title: existing.title ?? title,
			};
		}
		const description = buildDescription(pr, finding, analysis);
		const input: Record<string, unknown> = {
			teamId,
			title,
			description,
		};
		if (this.config.projectId) input.projectId = this.config.projectId;
		if (this.config.labelIds.length) input.labelIds = this.config.labelIds;

		const data = await this.query<{
			issueCreate?: {
				success?: boolean;
				issue?: { identifier?: string; url?: string; title?: string } | null;
			} | null;
		}>(
			`mutation AgenticReviewCreateDeferredIssue($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue { identifier url title }
				}
			}`,
			{ input },
		);
		const issue = data.issueCreate?.issue;
		if (!data.issueCreate?.success || !issue) throw new Error("Linear issueCreate did not return a created issue");
		return {
			findingId: finding.id,
			identifier: issue.identifier,
			url: issue.url,
			title: issue.title ?? title,
		};
	}

	private async findIssueByTitle(
		title: string,
	): Promise<{ identifier?: string; url?: string; title?: string } | undefined> {
		const data = await this.query<{
			issues?: { nodes?: Array<{ identifier?: string; url?: string; title?: string }> };
		}>(
			`query AgenticReviewExistingDeferral($title: String!) {
				issues(first: 1, filter: { title: { eq: $title } }) {
					nodes { identifier url title }
				}
			}`,
			{ title },
		);
		return data.issues?.nodes?.[0];
	}

	private async resolveTeamId(linkedIssueKey?: string): Promise<string> {
		if (this.resolvedTeamId) return this.resolvedTeamId;
		const data = await this.query<{ teams?: { nodes?: LinearTeam[] } }>(
			`query AgenticReviewTeams { teams { nodes { id key name } } }`,
			{},
		);
		const teams = data.teams?.nodes ?? [];
		if (!teams.length) throw new Error("No Linear teams are available to the configured API key");

		const configured = this.config.team?.trim().toLowerCase();
		let team = configured
			? teams.find((candidate) => [candidate.id, candidate.key, candidate.name].some((value) => value.toLowerCase() === configured))
			: undefined;
		if (configured && !team) throw new Error(`Configured Linear team was not found: ${this.config.team}`);

		if (!team && linkedIssueKey) {
			const key = linkedIssueKey.split("-")[0].toLowerCase();
			team = teams.find((candidate) => candidate.key.toLowerCase() === key);
		}
		if (!team && teams.length === 1) team = teams[0];
		if (!team) {
			throw new Error(
				`Linear team is ambiguous. Configure linear.team or AGENTIC_REVIEW_LINEAR_TEAM. Available: ${teams
					.map((candidate) => `${candidate.key} (${candidate.name})`)
					.join(", ")}`,
			);
		}
		this.resolvedTeamId = team.id;
		return team.id;
	}

	private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const response = await fetch(this.config.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.config.apiKey ?? "",
			},
			body: JSON.stringify({ query, variables }),
		});
		const payload = (await response.json()) as GraphQlResponse<T>;
		if (!response.ok || payload.errors?.length) {
			const details = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
			throw new Error(`Linear API request failed (${response.status})${details ? `: ${details}` : ""}`);
		}
		if (!payload.data) throw new Error("Linear API returned no data");
		return payload.data;
	}
}

function buildDescription(pr: PrContext, finding: Finding, analysis: BugAnalysis): string {
	const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "No line-specific location";
	return [
		"## Deferred edge-case bug",
		"",
		`This follow-up was created automatically by the agentic review of [${pr.repo.nameWithOwner} PR #${pr.number}](${pr.url}) at commit \`${pr.headSha}\`.`,
		"",
		"### Finding",
		`**${finding.title}**`,
		"",
		finding.rationale,
		"",
		`**Source:** \`${location}\``,
		"",
		"### Edge case",
		analysis.edgeCaseDefinition || "The review classified this as an edge case but did not provide a separate definition.",
		"",
		"### Acceptance-criteria impact",
		analysis.impactsAcceptanceCriteria
			? "The edge case intersects the current acceptance criteria but was judged safe to defer with explicit tracking."
			: "The edge case does not prevent the current acceptance criteria from being met.",
		"",
		analysis.reasoning,
		"",
		"### Source context",
		`- Repository: \`${pr.repo.nameWithOwner}\``,
		`- Pull request: [#${pr.number} ${pr.title}](${pr.url})`,
		`- Head: \`${pr.headRefName}\` @ \`${pr.headSha}\``,
		`- Base: \`${pr.baseRefName}\``,
		pr.linkedIssue?.url ? `- Original issue: [${pr.linkedIssue.key}](${pr.linkedIssue.url})` : undefined,
		"",
		"Revisit this behavior before closing the ticket; validate the documented edge case with a regression test.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
