import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	formatSize,
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const HUGGING_FACE_API = "https://huggingface.co/api";
const DEFAULT_DOWNLOAD_DIRECTORY = join(homedir(), ".cache", "pi-ollama-models");
const DEFAULT_OLLAMA_DIRECTORY = join(homedir(), ".ollama", "models");
const OLLAMA_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_HF_SEARCH_RESULTS = 10;

const findOllamaGgufSchema = Type.Object({
	gpu: Type.Optional(
		Type.String({
			description: "GPU to simulate, for example 'Apple M5 Max' or 'RTX 4090'. Omit to use detected hardware.",
		}),
	),
	quant: Type.Optional(
		Type.String({
			description: "Required GGUF quantization, for example 'Q6_K' or 'Q4_K_M'. Omit to use whichllm's recommendation.",
		}),
	),
	top: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Maximum recommendations to inspect (default 5)." }),
	),
	contextLength: Type.Optional(
		Type.String({ description: "Context length passed to whichllm, for example '32k' or '128k'." }),
	),
	fit: Type.Optional(
		StringEnum(["any", "gpu", "full-gpu"] as const, { description: "Runtime-fit requirement (default 'any')." }),
	),
	profile: Type.Optional(
		StringEnum(["general", "coding", "vision", "math", "any"] as const, {
			description: "whichllm ranking profile (default 'general').",
		}),
	),
});

type FindOllamaGgufParams = Static<typeof findOllamaGgufSchema>;

const installOllamaGgufSchema = Type.Object({
	repository: Type.String({
		description: "Public Hugging Face repository that contains the GGUF, for example 'unsloth/Qwen3.6-35B-A3B-GGUF'.",
	}),
	filename: Type.String({ description: "Exact .gguf filename from that repository." }),
	modelName: Type.String({
		description: "Lowercase Ollama model name and optional tag, for example 'qwen3.6:35b-q6k'.",
	}),
	downloadDirectory: Type.Optional(
		Type.String({
			description: `Optional staging directory for the original GGUF. Defaults to ${DEFAULT_DOWNLOAD_DIRECTORY}. Do not use Ollama's managed models directory.`,
		}),
	),
});

type InstallOllamaGgufParams = Static<typeof installOllamaGgufSchema>;

interface WhichLlmModel {
	model_id: string;
	artifact_repo_id?: string | null;
	artifact_filename?: string | null;
	quant_type?: string | null;
	file_size_bytes?: number | null;
	vram_required_bytes?: number | null;
	estimated_tok_per_sec?: number | null;
	speed_confidence?: string | null;
	fit_type?: string | null;
	quality_score?: number | null;
	warnings?: string[];
}

interface WhichLlmOutput {
	hardware?: {
		gpus?: Array<{ name?: string; usable_vram_bytes?: number | null }>;
		cpu?: string;
		ram_bytes?: number | null;
	};
	models?: WhichLlmModel[];
}

interface HuggingFaceModel {
	id: string;
	sha?: string;
	tags?: string[];
	gated?: boolean | "auto";
	private?: boolean;
	siblings?: Array<{ rfilename?: string }>;
}

interface GgufArtifact {
	repository: string;
	filename: string;
	revision: string;
	via: "whichllm" | "huggingface-search";
}

interface Recommendation {
	model: WhichLlmModel;
	artifact?: GgufArtifact;
	suggestedModelName: string;
	error?: string;
}

type InstallableRecommendation = Recommendation & { artifact: GgufArtifact };

interface FindDetails {
	gpu?: string;
	quant?: string;
	recommendations: Recommendation[];
}

interface ProvisioningOutcome {
	cancelled?: boolean;
	result?: { text: string; details: Record<string, unknown> };
	error?: string;
}

type TuiTheme = {
	fg(color: "accent" | "dim" | "error" | "muted" | "success" | "text" | "warning", text: string): string;
	bold(text: string): string;
};

interface PiModelsConfig {
	providers?: Record<string, unknown>;
}

interface PiModelRegistration {
	path: string;
	added: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateForError(value: string): string {
	return truncateHead(value.trim(), { maxLines: 25, maxBytes: 4_000 }).content;
}

function errorMessage(prefix: string, stdout: string, stderr: string): string {
	const detail = truncateForError(stderr || stdout);
	return detail ? `${prefix}: ${detail}` : prefix;
}

function normalizeQuant(quant: string | undefined): string | undefined {
	if (!quant) return undefined;
	const normalized = quant.trim().toUpperCase();
	if (!/^[A-Z0-9_]+$/.test(normalized)) {
		throw new Error(`Invalid GGUF quantization '${quant}'. Use a value such as Q6_K or Q4_K_M.`);
	}
	return normalized;
}

function validateRepository(repository: string): string {
	const value = repository.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error("Hugging Face repository must be in owner/name form.");
	}
	return value;
}

function validateFilename(filename: string): string {
	const value = filename.trim();
	const segments = value.split("/");
	if (
		!value.toLowerCase().endsWith(".gguf") ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("filename must be a repository-relative .gguf path without '.' or '..' segments.");
	}
	return value;
}

function validateModelName(modelName: string): string {
	const value = modelName.trim();
	if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[a-z0-9][a-z0-9._-]*)?$/.test(value)) {
		throw new Error("Ollama model names must be lowercase, for example qwen3.6:35b-q6k.");
	}
	return value;
}

function expandHome(directory: string): string {
	if (directory === "~") return homedir();
	if (directory.startsWith("~/")) return join(homedir(), directory.slice(2));
	return directory;
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function resolveDownloadDirectory(directory: string | undefined): string {
	const resolved = resolve(expandHome(directory?.trim() || DEFAULT_DOWNLOAD_DIRECTORY));
	const ollamaDirectory = resolve(process.env.OLLAMA_MODELS || DEFAULT_OLLAMA_DIRECTORY);
	if (isWithin(ollamaDirectory, resolved)) {
		throw new Error(
			`Do not use ${ollamaDirectory} as a GGUF staging directory; Ollama manages it internally. Use a separate directory instead.`,
		);
	}
	if (/\s/.test(resolved)) {
		throw new Error(
			"The GGUF staging directory cannot contain whitespace because Ollama Modelfiles cannot reliably import whitespace-containing paths.",
		);
	}
	return resolved;
}

function huggingFaceHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": "pi-ollama-models/1.0" };
	if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
	return headers;
}

function huggingFaceRepoPath(repository: string): string {
	return repository.split("/").map(encodeURIComponent).join("/");
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, { headers: huggingFaceHeaders(), signal });
	if (!response.ok) {
		throw new Error(`Hugging Face request failed (${response.status} ${response.statusText}).`);
	}
	return (await response.json()) as T;
}

async function getHuggingFaceRepository(repository: string, signal?: AbortSignal): Promise<HuggingFaceModel> {
	return fetchJson<HuggingFaceModel>(`${HUGGING_FACE_API}/models/${huggingFaceRepoPath(repository)}`, signal);
}

async function searchHuggingFaceGgufs(modelId: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
	const modelName = modelId.split("/").at(-1) ?? modelId;
	const query = new URLSearchParams({
		search: modelName,
		filter: "gguf",
		full: "true",
		limit: String(MAX_HF_SEARCH_RESULTS),
	});
	return fetchJson<HuggingFaceModel[]>(`${HUGGING_FACE_API}/models?${query}`, signal);
}

function ggufFiles(model: HuggingFaceModel): string[] {
	return (model.siblings ?? [])
		.map((sibling) => sibling.rfilename)
		.filter((filename): filename is string => Boolean(filename?.toLowerCase().endsWith(".gguf")))
		.filter((filename) => !filename.toLowerCase().includes("mmproj"));
}

function quantFile(files: string[], quant: string | undefined): string | undefined {
	if (files.length === 0) return undefined;
	if (!quant) return [...files].sort()[0];
	const escaped = quant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const quantPattern = new RegExp(`(?:^|[._-])${escaped}(?:[._-]|$)`, "i");
	return [...files]
		.filter((filename) => quantPattern.test(filename))
		.sort((a, b) => {
			const aExact = a.toUpperCase().endsWith(`${quant}.GGUF`);
			const bExact = b.toUpperCase().endsWith(`${quant}.GGUF`);
			return Number(bExact) - Number(aExact) || a.localeCompare(b);
		})[0];
}

function baseModelMatch(model: HuggingFaceModel, modelId: string): number {
	const tags = new Set(model.tags ?? []);
	if (tags.has(`base_model:quantized:${modelId}`)) return 3;
	if (tags.has(`base_model:${modelId}`)) return 2;
	const expectedName = modelId.split("/").at(-1)?.toLowerCase() ?? "";
	return model.id.toLowerCase().includes(expectedName) ? 1 : 0;
}

function suggestModelName(modelId: string, quant: string | undefined): string {
	const base = (modelId.split("/").at(-1) ?? "model")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	const tag = (quant ?? "gguf")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.slice(0, 32);
	return `${base}:${tag || "gguf"}`;
}

function resolvedArtifact(
	model: HuggingFaceModel,
	filename: string,
	via: GgufArtifact["via"],
): GgufArtifact | undefined {
	if (!model.sha || !/^[a-f0-9]{40}$/i.test(model.sha)) return undefined;
	return { repository: model.id, filename, revision: model.sha, via };
}

async function findArtifactForModel(
	model: WhichLlmModel,
	quant: string | undefined,
	signal?: AbortSignal,
): Promise<GgufArtifact | undefined> {
	if (model.artifact_repo_id && model.artifact_filename) {
		try {
			const repository = validateRepository(model.artifact_repo_id);
			const expectedFilename = validateFilename(model.artifact_filename);
			const candidate = await getHuggingFaceRepository(repository, signal);
			if (ggufFiles(candidate).includes(expectedFilename) && (!quant || quantFile([expectedFilename], quant))) {
				return resolvedArtifact(candidate, expectedFilename, "whichllm");
			}
		} catch {
			// A stale artifact hint must not prevent the Hugging Face GGUF search below.
		}
	}

	const candidates = await searchHuggingFaceGgufs(model.model_id, signal);
	const sorted = candidates
		.filter((candidate) => !candidate.private && !candidate.gated)
		.sort((a, b) => baseModelMatch(b, model.model_id) - baseModelMatch(a, model.model_id) || a.id.localeCompare(b.id));

	for (const candidate of sorted) {
		const filename = quantFile(ggufFiles(candidate), quant);
		const artifact = filename ? resolvedArtifact(candidate, filename, "huggingface-search") : undefined;
		if (artifact) return artifact;
	}

	return undefined;
}

async function findOllamaGgufs(
	pi: ExtensionAPI,
	params: FindOllamaGgufParams,
	signal?: AbortSignal,
): Promise<{ text: string; details: FindDetails }> {
	const quant = normalizeQuant(params.quant);
	const args = ["--json", "--top", String(params.top ?? 5)];
	if (params.gpu?.trim()) args.push("--gpu", params.gpu.trim());
	if (quant) args.push("--quant", quant);
	if (params.contextLength?.trim()) args.push("--context-length", params.contextLength.trim());
	if (params.fit && params.fit !== "any") args.push("--fit", params.fit);
	if (params.profile && params.profile !== "general") args.push("--profile", params.profile);

	const result = await pi.exec("whichllm", args, { signal, timeout: 120_000 });
	if (result.code !== 0) throw new Error(errorMessage("whichllm failed", result.stdout, result.stderr));

	let output: WhichLlmOutput;
	try {
		output = JSON.parse(result.stdout) as WhichLlmOutput;
	} catch {
		throw new Error(`whichllm returned invalid JSON: ${truncateForError(result.stdout)}`);
	}

	const recommendations: Recommendation[] = [];
	for (const model of output.models ?? []) {
		try {
			const artifact = await findArtifactForModel(
				model,
				quant ?? normalizeQuant(model.quant_type ?? undefined),
				signal,
			);
			recommendations.push({
				model,
				artifact,
				suggestedModelName: suggestModelName(model.model_id, quant ?? normalizeQuant(model.quant_type ?? undefined)),
			});
		} catch (error) {
			recommendations.push({
				model,
				suggestedModelName: suggestModelName(model.model_id, quant ?? normalizeQuant(model.quant_type ?? undefined)),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const hardware = output.hardware?.gpus?.[0];
	const hardwareText = hardware
		? `${hardware.name ?? "GPU"}${hardware.usable_vram_bytes ? ` (${formatSize(hardware.usable_vram_bytes)} usable)` : ""}`
		: (output.hardware?.cpu ?? "detected hardware");
	const lines = [`whichllm recommendations for ${hardwareText}:`];
	for (const [index, recommendation] of recommendations.entries()) {
		const { model, artifact } = recommendation;
		const runtime = [
			model.quant_type,
			model.fit_type?.replace("_", " "),
			model.vram_required_bytes ? formatSize(model.vram_required_bytes) : undefined,
			model.estimated_tok_per_sec ? `~${model.estimated_tok_per_sec.toFixed(1)} tok/s` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(`${index + 1}. ${model.model_id}${runtime ? ` — ${runtime}` : ""}`);
		if (artifact) {
			lines.push(
				`   GGUF: ${artifact.repository} @ ${artifact.revision.slice(0, 12)} / ${artifact.filename} (${artifact.via})`,
			);
			lines.push(`   Install as: ${recommendation.suggestedModelName}`);
		} else {
			lines.push(`   No public ${quant ?? model.quant_type ?? "matching"} GGUF was found through Hugging Face.`);
		}
		if (recommendation.error) lines.push(`   Search note: ${recommendation.error}`);
	}

	return { text: lines.join("\n"), details: { gpu: params.gpu, quant, recommendations } };
}

function artifactUrl(artifact: GgufArtifact): string {
	const filename = artifact.filename.split("/").map(encodeURIComponent).join("/");
	return `https://huggingface.co/${huggingFaceRepoPath(artifact.repository)}/resolve/${artifact.revision}/${filename}`;
}

async function artifactSize(url: string, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const response = await fetch(url, { method: "HEAD", headers: huggingFaceHeaders(), redirect: "follow", signal });
		if (!response.ok) return undefined;
		const size = Number(response.headers.get("content-length"));
		return Number.isFinite(size) && size > 0 ? size : undefined;
	} catch {
		return undefined;
	}
}

async function withExclusiveLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	let handle;
	try {
		handle = await open(path, "wx");
		await handle.writeFile(`${process.pid}\n`, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Another Pi session is already downloading this artifact (${path}).`);
		}
		throw error;
	}

	try {
		return await work();
	} finally {
		await handle.close();
		await rm(path, { force: true });
	}
}

async function registerOllamaModelWithPi(modelName: string): Promise<PiModelRegistration> {
	const modelsPath = join(getAgentDir(), "models.json");
	return withFileMutationQueue(modelsPath, async () => {
		let config: PiModelsConfig = {};
		try {
			const parsed: unknown = JSON.parse(await readFile(modelsPath, "utf8"));
			if (!isRecord(parsed)) throw new Error("models.json must contain a JSON object.");
			config = parsed as PiModelsConfig;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		if (config.providers === undefined) config.providers = {};
		if (!isRecord(config.providers)) throw new Error("models.json providers must be a JSON object.");

		let ollama = config.providers.ollama;
		if (ollama === undefined) {
			ollama = {
				baseUrl: OLLAMA_OPENAI_BASE_URL,
				api: "openai-completions",
				apiKey: "ollama",
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
				models: [],
			};
			config.providers.ollama = ollama;
		}
		if (!isRecord(ollama)) throw new Error("models.json providers.ollama must be a JSON object.");

		if (ollama.models === undefined) ollama.models = [];
		if (!Array.isArray(ollama.models)) throw new Error("models.json providers.ollama.models must be an array.");
		if (ollama.models.some((model) => isRecord(model) && model.id === modelName)) {
			return { path: modelsPath, added: false };
		}

		ollama.models.push({
			id: modelName,
			name: `${modelName} (Ollama local)`,
			reasoning: false,
			input: ["text"],
			contextWindow: 32768,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});

		await mkdir(dirname(modelsPath), { recursive: true });
		const temporaryPath = `${modelsPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		await rename(temporaryPath, modelsPath);
		return { path: modelsPath, added: true };
	});
}

async function curlDownload(
	url: string,
	partPath: string,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
		| undefined,
): Promise<void> {
	const download = async (resume: boolean): Promise<{ stderr: string; code: number | null }> => {
		const args = ["--fail", "--location", "--retry", "3", "--retry-delay", "2"];
		if (process.env.HF_TOKEN) args.push("--header", `Authorization: Bearer ${process.env.HF_TOKEN}`);
		if (resume) args.push("--continue-at", "-");
		args.push("--output", partPath, url);

		const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		let lastBytes = -1;
		const progressTimer = setInterval(() => {
			void stat(partPath)
				.then((info) => {
					if (info.size === lastBytes) return;
					lastBytes = info.size;
					onUpdate?.({
						content: [{ type: "text", text: `Downloading ${formatSize(info.size)}…` }],
						details: { downloadedBytes: info.size },
					});
				})
				.catch(() => undefined);
		}, 1_000);

		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const code = await new Promise<number | null>((resolvePromise, reject) => {
				child.once("error", reject);
				child.once("close", resolvePromise);
			});
			return { stderr, code };
		} finally {
			clearInterval(progressTimer);
			signal?.removeEventListener("abort", abort);
		}
	};

	if (signal?.aborted) throw new Error("Download cancelled.");
	const existingBytes = await stat(partPath)
		.then((info) => info.size)
		.catch(() => 0);
	let outcome = await download(existingBytes > 0);
	if (outcome.code !== 0 && existingBytes > 0 && /range|continue|resum/i.test(outcome.stderr)) {
		await rm(partPath, { force: true });
		outcome = await download(false);
	}
	if (signal?.aborted) throw new Error("Download cancelled.");
	if (outcome.code !== 0) throw new Error(errorMessage("curl download failed", "", outcome.stderr));
}

async function installOllamaGguf(
	pi: ExtensionAPI,
	params: InstallOllamaGgufParams,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
		| undefined,
	ctx: { hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> } },
	options: { skipConfirmation?: boolean } = {},
): Promise<{ text: string; details: Record<string, unknown> }> {
	const repository = validateRepository(params.repository);
	const filename = validateFilename(params.filename);
	const modelName = validateModelName(params.modelName);
	const downloadDirectory = resolveDownloadDirectory(params.downloadDirectory);

	const repositoryMetadata = await getHuggingFaceRepository(repository, signal);
	const artifact = resolvedArtifact(repositoryMetadata, filename, "huggingface-search");
	if (!artifact || !ggufFiles(repositoryMetadata).includes(filename)) {
		throw new Error(`${repository} does not contain the requested GGUF '${filename}'.`);
	}

	const url = artifactUrl(artifact);
	const size = await artifactSize(url, signal);
	if (!options.skipConfirmation) {
		if (!ctx.hasUI) {
			return {
				text: "Installation needs an interactive Pi confirmation because it downloads a potentially large file and creates or replaces an Ollama model.",
				details: { repository, filename, modelName, requiresConfirmation: true },
			};
		}

		const confirmed = await ctx.ui.confirm(
			`Install ${modelName}?`,
			[
				`Hugging Face: ${repository} @ ${artifact.revision.slice(0, 12)}`,
				`GGUF: ${filename}${size ? ` (${formatSize(size)})` : ""}`,
				`Staging: ${downloadDirectory}`,
				`Ollama model: ${modelName}`,
				"This downloads the artifact and creates or replaces the named local Ollama model.",
			].join("\n"),
		);
		if (!confirmed) {
			return { text: "Installation cancelled.", details: { repository, filename, modelName, cancelled: true } };
		}
	}

	const sourcePath = join(downloadDirectory, repository.replace("/", "--"), artifact.revision, ...filename.split("/"));
	const partPath = `${sourcePath}.part`;
	const lockPath = `${sourcePath}.lock`;
	const modelfilePath = `${sourcePath}.Modelfile`;
	await mkdir(dirname(sourcePath), { recursive: true });

	await withExclusiveLock(lockPath, async () => {
		const sourceInfo = await stat(sourcePath).catch(() => undefined);
		const exists = Boolean(
			sourceInfo?.isFile() && sourceInfo.size > 0 && (size === undefined || sourceInfo.size === size),
		);
		if (!exists) {
			if (sourceInfo?.isFile()) await rm(sourcePath, { force: true });
			onUpdate?.({ content: [{ type: "text", text: "Downloading GGUF…" }], details: { stage: "downloading" } });
			await curlDownload(url, partPath, signal, onUpdate);
			const downloaded = await stat(partPath);
			if (downloaded.size === 0) throw new Error("Downloaded GGUF is empty.");
			if (size !== undefined && downloaded.size !== size) {
				throw new Error(
					`Downloaded GGUF size (${formatSize(downloaded.size)}) does not match Hugging Face metadata (${formatSize(size)}).`,
				);
			}
			await rename(partPath, sourcePath);
		}

		await writeFile(modelfilePath, `FROM ${sourcePath}\n`, "utf8");
		onUpdate?.({
			content: [{ type: "text", text: `Importing ${modelName} into Ollama…` }],
			details: { stage: "importing" },
		});
		const create = await pi.exec("ollama", ["create", modelName, "-f", modelfilePath], {
			signal,
			timeout: 30 * 60_000,
		});
		if (create.code !== 0) throw new Error(errorMessage("ollama create failed", create.stdout, create.stderr));
	});

	let piModelRegistration: PiModelRegistration | undefined;
	let piModelRegistrationError: string | undefined;
	try {
		piModelRegistration = await registerOllamaModelWithPi(modelName);
	} catch (error) {
		piModelRegistrationError = error instanceof Error ? error.message : String(error);
	}

	const text = [
		`Installed ${modelName} in Ollama.`,
		`Source GGUF: ${sourcePath}`,
		`Ollama now manages its imported copy under ${process.env.OLLAMA_MODELS || DEFAULT_OLLAMA_DIRECTORY}.`,
		piModelRegistration
			? `${piModelRegistration.added ? "Added" : "Kept"} ${modelName} in ${piModelRegistration.path}; select it with Pi's /model command.`
			: `Pi model configuration was not updated: ${piModelRegistrationError}`,
		`Run: ollama run ${modelName}`,
		"Ollama serves models at http://127.0.0.1:11434 when its service is running.",
	].join("\n");
	return {
		text,
		details: {
			repository,
			filename,
			revision: artifact.revision,
			modelName,
			sourcePath,
			modelfilePath,
			piModelRegistration,
			piModelRegistrationError,
		},
	};
}

class RecommendationPicker implements Component {
	private selected = 0;
	private scroll = 0;

	constructor(
		private readonly theme: TuiTheme,
		private readonly recommendations: InstallableRecommendation[],
		private readonly gpu: string | undefined,
		private readonly done: (recommendation: InstallableRecommendation | null) => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureVisible();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.recommendations.length - 1, this.selected + 1);
			this.ensureVisible();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) this.done(this.recommendations[this.selected] ?? null);
	}

	render(width: number): string[] {
		const lines = [this.border(width, "╭", "╮")];
		this.addWrapped(lines, this.theme.fg("accent", this.theme.bold("Ollama model picker")), width);
		this.addWrapped(lines, this.theme.fg("muted", `Hardware: ${this.gpu || "detected hardware"}`), width);
		lines.push(this.row("", width));

		const visibleCount = 7;
		const end = Math.min(this.recommendations.length, this.scroll + visibleCount);
		for (let index = this.scroll; index < end; index++) {
			const recommendation = this.recommendations[index]!;
			const model = recommendation.model;
			const runtime = [
				model.quant_type,
				model.fit_type?.replace("_", " "),
				model.vram_required_bytes ? formatSize(model.vram_required_bytes) : undefined,
				model.estimated_tok_per_sec ? `~${model.estimated_tok_per_sec.toFixed(1)} tok/s` : undefined,
			]
				.filter(Boolean)
				.join(" · ");
			const prefix = index === this.selected ? this.theme.fg("accent", "> ") : "  ";
			const label = `${index + 1}. ${model.model_id}${runtime ? ` — ${runtime}` : ""}`;
			this.addWrapped(lines, `${prefix}${index === this.selected ? this.theme.fg("accent", label) : label}`, width);
			if (index === this.selected) {
				this.addWrapped(
					lines,
					this.theme.fg("muted", `   ${recommendation.artifact.repository} / ${recommendation.artifact.filename}`),
					width,
				);
			}
		}
		if (this.recommendations.length > visibleCount) {
			lines.push(this.row(this.theme.fg("dim", `${this.selected + 1}/${this.recommendations.length}`), width));
		}
		lines.push(this.row("", width));
		this.addWrapped(lines, this.theme.fg("dim", "↑↓ choose • Enter continue • Esc cancel"), width);
		lines.push(this.border(width, "╰", "╯"));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}

	private ensureVisible(): void {
		const visibleCount = 7;
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + visibleCount) this.scroll = this.selected - visibleCount + 1;
	}

	private addWrapped(lines: string[], text: string, width: number): void {
		for (const line of wrapTextWithAnsi(text, Math.max(1, width - 4))) lines.push(this.row(line, width));
	}

	private row(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return `${this.theme.fg("accent", "│")} ${clipped}${padding} ${this.theme.fg("accent", "│")}`;
	}

	private border(width: number, left: string, right: string): string {
		return this.theme.fg("accent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
	}
}

class ProvisioningProgress implements Component {
	private stage = "Preparing installation…";
	private downloadedBytes: number | undefined;
	private cancelling = false;
	private frame = 0;
	private readonly controller = new AbortController();
	private readonly interval: NodeJS.Timeout;
	private finished = false;

	constructor(
		private readonly theme: TuiTheme,
		private readonly recommendation: InstallableRecommendation,
		private readonly modelName: string,
		private readonly done: (outcome: ProvisioningOutcome) => void,
		private readonly requestRender: () => void,
		work: (
			signal: AbortSignal,
			onUpdate: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
		) => Promise<{ text: string; details: Record<string, unknown> }>,
	) {
		this.interval = setInterval(() => {
			this.frame++;
			this.requestRender();
		}, 120);
		void work(this.controller.signal, (update) => {
			this.stage = update.content.map((part) => part.text).join(" ") || this.stage;
			const downloadedBytes = update.details.downloadedBytes;
			if (typeof downloadedBytes === "number") this.downloadedBytes = downloadedBytes;
			this.requestRender();
		})
			.then((result) => this.finish({ result }))
			.catch((error) =>
				this.finish(
					this.controller.signal.aborted
						? { cancelled: true }
						: { error: error instanceof Error ? error.message : String(error) },
				),
			);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) && !this.cancelling) {
			this.cancelling = true;
			this.stage = "Cancelling…";
			this.controller.abort();
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const recommendation = this.recommendation;
		const artifact = recommendation.artifact;
		const spinner = ["◐", "◓", "◑", "◒"][this.frame % 4]!;
		const lines = [this.border(width, "╭", "╮")];
		this.addWrapped(
			lines,
			this.theme.fg("accent", this.theme.bold(`${spinner} Provisioning ${this.modelName}`)),
			width,
		);
		this.addWrapped(lines, this.theme.fg("muted", recommendation.model.model_id), width);
		this.addWrapped(lines, this.theme.fg("muted", `${artifact.repository} / ${artifact.filename}`), width);
		lines.push(this.row("", width));
		this.addWrapped(
			lines,
			this.cancelling ? this.theme.fg("warning", this.stage) : this.theme.fg("text", this.stage),
			width,
		);
		if (this.downloadedBytes !== undefined) {
			this.addWrapped(lines, this.theme.fg("muted", `Downloaded: ${formatSize(this.downloadedBytes)}`), width);
		}
		lines.push(this.row("", width));
		this.addWrapped(lines, this.theme.fg("dim", this.cancelling ? "Waiting for cancellation…" : "Esc cancel"), width);
		lines.push(this.border(width, "╰", "╯"));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}

	private finish(outcome: ProvisioningOutcome): void {
		if (this.finished) return;
		this.finished = true;
		clearInterval(this.interval);
		this.done(outcome);
	}

	private addWrapped(lines: string[], text: string, width: number): void {
		for (const line of wrapTextWithAnsi(text, Math.max(1, width - 4))) lines.push(this.row(line, width));
	}

	private row(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return `${this.theme.fg("accent", "│")} ${clipped}${padding} ${this.theme.fg("accent", "│")}`;
	}

	private border(width: number, left: string, right: string): string {
		return this.theme.fg("accent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
	}
}

async function findWithProgress(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gpu: string | undefined,
): Promise<FindDetails | null> {
	let settled = false;
	return ctx.ui.custom<FindDetails | null>((tui, theme, _keybindings, done) => {
		const finish = (result: FindDetails | null) => {
			if (settled) return;
			settled = true;
			done(result);
		};
		const loader = new BorderedLoader(tui, theme, "Finding Ollama-ready GGUF recommendations…");
		loader.onAbort = () => finish(null);
		void findOllamaGgufs(pi, { gpu }, loader.signal)
			.then((result) => finish(result.details))
			.catch((error) => {
				if (!loader.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				finish(null);
			});
		return loader;
	});
}

export default function ollamaModelsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "find_ollama_gguf",
		label: "Find Ollama GGUF",
		description:
			"Use whichllm to rank models for hardware, then find a matching public GGUF artifact on Hugging Face. Returns repository, immutable revision, filename, and a suggested Ollama model name. Output is limited to 10 recommendations.",
		promptSnippet: "Find GGUF models that can run through Ollama on specified hardware",
		promptGuidelines: [
			"Use find_ollama_gguf to recommend an Ollama-installable GGUF for the user's hardware before proposing a model download.",
			"Use install_ollama_gguf only after the user has explicitly chosen a Hugging Face GGUF and Ollama model name.",
		],
		parameters: findOllamaGgufSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate) {
			const result = await findOllamaGgufs(pi, params, signal);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerTool({
		name: "install_ollama_gguf",
		label: "Install Ollama GGUF",
		description:
			"After interactive confirmation, download an exact public GGUF from Hugging Face to a staging directory and import it as a local Ollama model. The original GGUF is never placed in Ollama's managed models directory.",
		promptSnippet: "Download a chosen Hugging Face GGUF and import it into Ollama",
		promptGuidelines: [
			"Use install_ollama_gguf only after the user explicitly selects the GGUF and Ollama model name; it will ask for final interactive confirmation before downloading.",
		],
		parameters: installOllamaGgufSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await installOllamaGguf(pi, params, signal, onUpdate, ctx);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("ollama-models", {
		description:
			"Interactively choose, download, and provision an Ollama GGUF; optionally pass a GPU name, for example /ollama-models Apple M5 Max",
		handler: async (args, ctx) => {
			const gpu = args.trim() || undefined;
			if (!ctx.hasUI) {
				const result = await findOllamaGgufs(pi, { gpu }, undefined);
				pi.sendMessage({ customType: "ollama-models", content: result.text, details: result.details, display: true });
				return;
			}

			const details = await findWithProgress(pi, ctx, gpu);
			if (!details) return;
			const installable = details.recommendations.filter(
				(recommendation): recommendation is InstallableRecommendation => recommendation.artifact !== undefined,
			);
			if (installable.length === 0) {
				ctx.ui.notify("No public GGUF artifacts were found for these recommendations.", "warning");
				return;
			}

			const selected = await ctx.ui.custom<InstallableRecommendation | null>(
				(tui, theme, _keybindings, done) =>
					new RecommendationPicker(theme as TuiTheme, installable, details.gpu, done, () => tui.requestRender()),
			);
			if (!selected) {
				ctx.ui.notify("Ollama model selection cancelled.", "info");
				return;
			}

			const enteredName = await ctx.ui.input(
				"Ollama model name",
				`${selected.suggestedModelName} (leave blank to use this suggested name)`,
			);
			if (enteredName === undefined) {
				ctx.ui.notify("Ollama model selection cancelled.", "info");
				return;
			}
			const modelName = enteredName.trim() || selected.suggestedModelName;
			try {
				validateModelName(modelName);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const artifact = selected.artifact;
			const confirmed = await ctx.ui.confirm(
				`Install ${modelName}?`,
				[
					`Model: ${selected.model.model_id}`,
					`GGUF: ${artifact.repository} @ ${artifact.revision.slice(0, 12)} / ${artifact.filename}`,
					selected.model.file_size_bytes
						? `Download: ${formatSize(selected.model.file_size_bytes)}`
						: "Download size: checking with Hugging Face",
					`Staging: ${DEFAULT_DOWNLOAD_DIRECTORY}`,
					"This downloads the GGUF, imports it into Ollama, and registers it in Pi's local model catalog.",
				].join("\n"),
			);
			if (!confirmed) {
				ctx.ui.notify("Installation cancelled.", "info");
				return;
			}

			const outcome = await ctx.ui.custom<ProvisioningOutcome>(
				(tui, theme, _keybindings, done) =>
					new ProvisioningProgress(
						theme as TuiTheme,
						selected,
						modelName,
						done,
						() => tui.requestRender(),
						(signal, onUpdate) =>
							installOllamaGguf(
								pi,
								{ repository: artifact.repository, filename: artifact.filename, modelName },
								signal,
								onUpdate,
								ctx,
								{ skipConfirmation: true },
							),
					),
			);
			if (outcome.cancelled) {
				ctx.ui.notify("Installation cancelled.", "info");
				return;
			}
			if (outcome.error) {
				ctx.ui.notify(outcome.error, "error");
				return;
			}
			if (!outcome.result) return;

			pi.sendMessage({
				customType: "ollama-models",
				content: outcome.result.text,
				details: outcome.result.details,
				display: true,
			});
			ctx.ui.notify(`Installed ${modelName}; select it with Pi's /model command.`, "info");
		},
	});
}
