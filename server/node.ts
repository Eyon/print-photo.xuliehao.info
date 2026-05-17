import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";

type PrintStatus = "pending" | "claimed" | "printed" | "failed";
type PrintSource = "direct" | "wechat";

interface TempUpload {
	id: string;
	storeId: string;
	imagePath: string;
	originalName: string;
	contentType: string;
	size: number;
	createdAt: string;
	expiresAt: string;
	source: PrintSource;
	wechatMediaId?: string;
	userAgent?: string;
	jobId?: string;
	consumedAt?: string;
}

interface PrintJob {
	id: string;
	storeId: string;
	status: PrintStatus;
	imagePath: string;
	imageExpiresAt?: string;
	originalName: string;
	contentType: string;
	size: number;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string;
	printedAt?: string;
	failedAt?: string;
	errorMessage?: string;
	source: PrintSource;
	wechatMediaId?: string;
	userAgent?: string;
}

interface WechatCache {
	value: string;
	expiresAt: number;
}

interface WechatApiError {
	errcode?: number;
	errmsg?: string;
}

const app = express();
const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const downloadDir = path.resolve(process.env.DOWNLOAD_DIR ?? "downloads");
const clientDir = process.env.CLIENT_DIR
	? path.resolve(process.env.CLIENT_DIR)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 15 * 1024 * 1024);
const uploadTtlMs = Number(process.env.UPLOAD_TTL_MS ?? 30 * 60 * 1000);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 1000);

const dirs = {
	uploads: path.join(dataDir, "uploads"),
	tempUploads: path.join(dataDir, "temp-uploads"),
	jobs: path.join(dataDir, "jobs"),
	pending: path.join(dataDir, "queue", "pending"),
	wechat: path.join(dataDir, "wechat"),
};

const requiredEnv = (name: string) => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not configured.`);
	}

	return value;
};

const ensureDataDirs = async () => {
	await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
};

const normalizeContentType = (contentType: string) => contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";

const detectImageContentType = (buffer: Buffer) => {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}

	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}

	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
		return "image/webp";
	}

	if (buffer.length >= 6) {
		const signature = buffer.toString("ascii", 0, 6);
		if (signature === "GIF87a" || signature === "GIF89a") {
			return "image/gif";
		}
	}

	if (buffer.length >= 4) {
		const signature = buffer.toString("ascii", 0, 4);
		if (signature === "II*\x00" || signature === "MM\x00*") {
			return "image/tiff";
		}
	}

	if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
		const brand = buffer.toString("ascii", 8, 12).toLowerCase();
		if (brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("msf")) {
			return brand.includes("f") ? "image/heif" : "image/heic";
		}
	}

	return null;
};

const readWechatErrorPayload = (buffer: Buffer) => {
	const text = buffer.toString("utf8", 0, Math.min(buffer.byteLength, 2048)).trim();
	if (!text.startsWith("{")) {
		return null;
	}

	try {
		const data = JSON.parse(text) as { errcode?: number; errmsg?: string };
		if (typeof data.errcode === "number" || typeof data.errmsg === "string") {
			return data;
		}
	} catch {
		return null;
	}

	return null;
};

const normalizeStoreId = (value: unknown) => {
	const raw = typeof value === "string" ? value.trim() : "";
	const normalized = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return normalized.slice(0, 64) || "home";
};

const contentTypeByExtension: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	tif: "image/tiff",
	tiff: "image/tiff",
};

const getFileExtension = (fileName: string, contentType: string) => {
	const fromName = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
	if (fromName) {
		return fromName;
	}

	const fallback: Record<string, string> = {
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/heic": "heic",
		"image/heif": "heif",
		"image/tiff": "tiff",
	};

	return fallback[normalizeContentType(contentType)] ?? "bin";
};

const getImageContentType = (fileName: string, contentType: string, buffer?: Buffer) => {
	const detectedContentType = buffer ? detectImageContentType(buffer) : null;
	if (detectedContentType) {
		return detectedContentType;
	}

	const normalizedContentType = normalizeContentType(contentType);
	if (normalizedContentType.startsWith("image/")) {
		return normalizedContentType;
	}

	const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
	return contentTypeByExtension[extension] ?? normalizedContentType;
};

const safeOriginalName = (fileName: string) => fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120) || "upload";

const getRouteParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

const writeJson = async (filePath: string, data: unknown) => {
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
	await rename(tempPath, filePath);
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

const listJsonFiles = async (dir: string) => {
	try {
		return (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
};

const tempUploadPath = (uploadId: string) => path.join(dirs.tempUploads, `${uploadId}.json`);
const jobPath = (jobId: string) => path.join(dirs.jobs, `${jobId}.json`);
const pendingDir = (storeId: string) => path.join(dirs.pending, normalizeStoreId(storeId));
const pendingPath = (storeId: string, createdAt: string, jobId: string) =>
	path.join(pendingDir(storeId), `${createdAt.replaceAll(":", "-")}-${jobId}.json`);

const sha1 = (text: string) => crypto.createHash("sha1").update(text).digest("hex");

const isExpired = (isoTime: string) => Date.parse(isoTime) <= Date.now();

const getJobImageExpiresAt = (job: Pick<PrintJob, "createdAt" | "imageExpiresAt">) => {
	if (job.imageExpiresAt) {
		return job.imageExpiresAt;
	}

	const createdTime = Date.parse(job.createdAt);
	return Number.isFinite(createdTime) ? new Date(createdTime + uploadTtlMs).toISOString() : new Date().toISOString();
};

const removePendingMarker = async (job: Pick<PrintJob, "id" | "storeId">) => {
	const queueDir = pendingDir(job.storeId);
	const markers = await listJsonFiles(queueDir);
	await Promise.all(
		markers
			.filter((file) => file.endsWith(`${job.id}.json`))
			.map((file) => rm(path.join(queueDir, file), { force: true })),
	);
};

const expireTempUpload = async (upload: TempUpload) => {
	await rm(upload.imagePath, { force: true });
	await rm(tempUploadPath(upload.id), { force: true });
};

const failExpiredJob = async (job: PrintJob) => {
	await rm(job.imagePath, { force: true });

	if (job.status === "pending" || job.status === "claimed") {
		const now = new Date().toISOString();
		const failedJob: PrintJob = {
			...job,
			status: "failed",
			updatedAt: now,
			imageExpiresAt: getJobImageExpiresAt(job),
			failedAt: now,
			errorMessage: "图片已超过 30 分钟，已自动从服务器删除。",
		};

		await saveJob(failedJob);
		await removePendingMarker(failedJob);
	}
};

const cleanupExpiredUploads = async () => {
	const tempFiles = await listJsonFiles(dirs.tempUploads);
	for (const file of tempFiles) {
		const filePath = path.join(dirs.tempUploads, file);
		const upload = await readJson<TempUpload>(filePath);
		if (!upload) {
			await rm(filePath, { force: true });
			continue;
		}

		if (isExpired(upload.expiresAt)) {
			await expireTempUpload(upload);
		}
	}

	const jobFiles = await listJsonFiles(dirs.jobs);
	for (const file of jobFiles) {
		const filePath = path.join(dirs.jobs, file);
		const job = await readJson<PrintJob>(filePath);
		if (!job) {
			await rm(filePath, { force: true });
			continue;
		}

		if (isExpired(getJobImageExpiresAt(job))) {
			await failExpiredJob(job);
		}
	}
};

const getWechatCache = async (name: "access-token" | "jsapi-ticket") => {
	const cache = await readJson<WechatCache>(path.join(dirs.wechat, `${name}.json`));
	const now = Math.floor(Date.now() / 1000);
	if (cache && cache.expiresAt - 120 > now) {
		return cache.value;
	}

	return null;
};

const setWechatCache = async (name: "access-token" | "jsapi-ticket", value: string, expiresIn = 7200) => {
	await writeJson(path.join(dirs.wechat, `${name}.json`), {
		value,
		expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
	});
};

const clearWechatCache = async (name: "access-token" | "jsapi-ticket") => {
	await rm(path.join(dirs.wechat, `${name}.json`), { force: true });
};

const isWechatAccessTokenError = (data: WechatApiError | null) =>
	data?.errcode === 40001 || data?.errcode === 40014 || data?.errcode === 42001 || data?.errmsg?.includes("access_token");

const getWechatAccessToken = async (options: { ignoreCache?: boolean } = {}) => {
	const cached = options.ignoreCache ? null : await getWechatCache("access-token");
	if (cached) {
		return cached;
	}

	const tokenUrl = new URL("https://api.weixin.qq.com/cgi-bin/stable_token");
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "client_credential",
			appid: requiredEnv("WECHAT_APP_ID"),
			secret: requiredEnv("WECHAT_APP_SECRET"),
			force_refresh: false,
		}),
	});

	const data = (await response.json()) as { access_token?: string; expires_in?: number } & WechatApiError;
	if (!response.ok || !data.access_token) {
		throw new Error(`Failed to get WeChat stable access_token: ${data.errmsg ?? response.statusText}`);
	}

	await setWechatCache("access-token", data.access_token, data.expires_in);
	return data.access_token;
};

const resetWechatCredentialCache = async () => {
	await Promise.all([clearWechatCache("access-token"), clearWechatCache("jsapi-ticket")]);
};

const getWechatJsapiTicket = async () => {
	const cached = await getWechatCache("jsapi-ticket");
	if (cached) {
		return cached;
	}

	let accessToken = await getWechatAccessToken();
	const ticketUrl = new URL("https://api.weixin.qq.com/cgi-bin/ticket/getticket");
	ticketUrl.searchParams.set("access_token", accessToken);
	ticketUrl.searchParams.set("type", "jsapi");

	let response = await fetch(ticketUrl);
	let data = (await response.json()) as { ticket?: string; expires_in?: number } & WechatApiError;
	if ((!response.ok || !data.ticket) && isWechatAccessTokenError(data)) {
		await resetWechatCredentialCache();
		accessToken = await getWechatAccessToken({ ignoreCache: true });
		ticketUrl.searchParams.set("access_token", accessToken);
		response = await fetch(ticketUrl);
		data = (await response.json()) as { ticket?: string; expires_in?: number } & WechatApiError;
	}

	if (!response.ok || !data.ticket) {
		throw new Error(`Failed to get WeChat jsapi_ticket: ${data.errmsg ?? response.statusText}`);
	}

	await setWechatCache("jsapi-ticket", data.ticket, data.expires_in);
	return data.ticket;
};

const downloadWechatMedia = async (mediaId: string, options: { ignoreCache?: boolean } = {}) => {
	const accessToken = await getWechatAccessToken({ ignoreCache: options.ignoreCache });
	const mediaUrl = new URL("https://api.weixin.qq.com/cgi-bin/media/get");
	mediaUrl.searchParams.set("access_token", accessToken);
	mediaUrl.searchParams.set("media_id", mediaId);

	const response = await fetch(mediaUrl);
	const responseContentType = normalizeContentType(response.headers.get("content-type") ?? "image/jpeg");
	const errorData =
		!response.ok || responseContentType === "application/json"
			? ((await response.json().catch(() => null)) as WechatApiError | null)
			: null;

	return { response, responseContentType, errorData };
};

const saveJob = (job: PrintJob) => writeJson(jobPath(job.id), job);

const createTempUpload = async (input: {
	buffer: Buffer;
	contentType: string;
	originalName: string;
	storeId: string;
	source: PrintSource;
	userAgent?: string;
	wechatMediaId?: string;
}) => {
	const uploadId = crypto.randomUUID();
	const storeId = normalizeStoreId(input.storeId);
	const now = new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + uploadTtlMs).toISOString();
	const contentType = normalizeContentType(input.contentType);
	const extension = getFileExtension(input.originalName, contentType);
	const dateDir = path.join(dirs.uploads, createdAt.slice(0, 10));
	await mkdir(dateDir, { recursive: true });

	const imagePath = path.join(dateDir, `${uploadId}.${extension}`);
	await writeFile(imagePath, input.buffer);

	const upload: TempUpload = {
		id: uploadId,
		storeId,
		imagePath,
		originalName: safeOriginalName(input.originalName || `upload.${extension}`),
		contentType,
		size: input.buffer.byteLength,
		createdAt,
		expiresAt,
		source: input.source,
		userAgent: input.userAgent,
		wechatMediaId: input.wechatMediaId,
	};

	await writeJson(tempUploadPath(upload.id), upload);
	return upload;
};

const createPrintJobFromUpload = async (uploadId: string) => {
	const upload = await readJson<TempUpload>(tempUploadPath(uploadId));
	if (!upload) {
		return { error: "not_found" as const };
	}

	if (isExpired(upload.expiresAt)) {
		await expireTempUpload(upload);
		return { error: "expired" as const };
	}

	if (upload.jobId) {
		const existingJob = await readJson<PrintJob>(jobPath(upload.jobId));
		if (existingJob) {
			return { job: existingJob };
		}
	}

	const jobId = crypto.randomUUID();
	const now = new Date().toISOString();
	const job: PrintJob = {
		id: jobId,
		storeId: upload.storeId,
		status: "pending",
		imagePath: upload.imagePath,
		imageExpiresAt: upload.expiresAt,
		originalName: upload.originalName,
		contentType: upload.contentType,
		size: upload.size,
		createdAt: now,
		updatedAt: now,
		source: upload.source,
		userAgent: upload.userAgent,
		wechatMediaId: upload.wechatMediaId,
	};

	await saveJob(job);
	await writeJson(pendingPath(job.storeId, now, job.id), { jobId: job.id, storeId: job.storeId, createdAt: now });
	await writeJson(tempUploadPath(upload.id), { ...upload, jobId: job.id, consumedAt: now });

	return { job };
};

const publicTempUpload = (upload: TempUpload) => ({
	uploadId: upload.id,
	storeId: upload.storeId,
	originalName: upload.originalName,
	contentType: upload.contentType,
	size: upload.size,
	previewUrl: `/api/uploads/${upload.id}/image`,
	printUrl: `/api/uploads/${upload.id}/print`,
	createdAt: upload.createdAt,
	expiresAt: upload.expiresAt,
});

const publicJob = (job: PrintJob) => ({
	id: job.id,
	storeId: job.storeId,
	status: job.status,
	originalName: job.originalName,
	size: job.size,
	createdAt: job.createdAt,
	updatedAt: job.updatedAt,
	imageExpiresAt: getJobImageExpiresAt(job),
	printedAt: job.printedAt,
	failedAt: job.failedAt,
	errorMessage: job.errorMessage,
});

const sendTempUploadResponse = (res: Response, upload: TempUpload) => {
	res.status(201).json(publicTempUpload(upload));
};

const sendJobCreateResponse = (res: Response, job: PrintJob) => {
	res.status(201).json({
		jobId: job.id,
		storeId: job.storeId,
		status: job.status,
		statusUrl: `/api/jobs/${job.id}`,
		createdAt: job.createdAt,
	});
};

const pipeImage = async (res: Response, imagePath: string, contentType: string, size: number, fileName: string, disposition: "inline" | "attachment") => {
	try {
		await access(imagePath);
	} catch {
		res.status(410).json({ error: "Image expired or deleted." });
		return;
	}

	res.setHeader("content-type", contentType);
	res.setHeader("content-length", String(size));
	res.setHeader("content-disposition", `${disposition}; filename="${encodeURIComponent(fileName)}"`);

	const stream = createReadStream(imagePath);
	stream.on("error", () => {
		if (!res.headersSent) {
			res.status(410).json({ error: "Image expired or deleted." });
			return;
		}

		res.destroy();
	});
	stream.pipe(res);
};

const authorizePrinterAgent = (req: Request, res: Response, next: NextFunction) => {
	const expectedToken = process.env.PRINTER_AGENT_TOKEN;
	if (!expectedToken) {
		res.status(503).json({ error: "PRINTER_AGENT_TOKEN is not configured." });
		return;
	}

	const authHeader = req.header("authorization") ?? "";
	const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
	const queryToken = typeof req.query.token === "string" ? req.query.token : "";
	if (bearerToken !== expectedToken && queryToken !== expectedToken) {
		res.status(401).json({ error: "Unauthorized." });
		return;
	}

	next();
};

const asyncHandler =
	(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
	(req: Request, res: Response, next: NextFunction) => {
		handler(req, res, next).catch(next);
	};

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: maxUploadBytes,
		files: 1,
	},
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
	res.json({ ok: true });
});

app.get(
	"/api/wechat/js-config",
	asyncHandler(async (req, res) => {
		const pageUrl = typeof req.query.url === "string" ? req.query.url : "";
		if (!pageUrl.startsWith("http")) {
			res.status(400).json({ error: "Missing page url." });
			return;
		}

		const nonceStr = crypto.randomUUID().replaceAll("-", "");
		const timestamp = Math.floor(Date.now() / 1000);
		const ticket = await getWechatJsapiTicket();
		const signature = sha1(
			`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl.split("#")[0]}`,
		);

		res.json({
			appId: requiredEnv("WECHAT_APP_ID"),
			timestamp,
			nonceStr,
			signature,
			jsApiList: ["chooseImage", "uploadImage"],
		});
	}),
);

app.post(
	"/api/wechat/media-import",
	asyncHandler(async (req, res) => {
		const mediaId = typeof req.body?.mediaId === "string" ? req.body.mediaId : "";
		if (!mediaId) {
			res.status(400).json({ error: "Missing WeChat mediaId." });
			return;
		}

		let { response, responseContentType, errorData } = await downloadWechatMedia(mediaId);
		if ((!response.ok || responseContentType === "application/json") && isWechatAccessTokenError(errorData)) {
			await resetWechatCredentialCache();
			({ response, responseContentType, errorData } = await downloadWechatMedia(mediaId, { ignoreCache: true }));
		}

		if (!response.ok || responseContentType === "application/json") {
			res.status(502).json({ error: `Failed to download WeChat media: ${errorData?.errmsg ?? response.statusText}` });
			return;
		}

		const imageBytes = Buffer.from(await response.arrayBuffer());
		const contentType = getImageContentType("", responseContentType, imageBytes);
		const wechatError = readWechatErrorPayload(imageBytes);
		if (wechatError) {
			res.status(502).json({
				error: `Failed to download WeChat media: ${wechatError.errmsg ?? "unknown WeChat error"}`,
				errcode: wechatError.errcode,
			});
			return;
		}

		if (!contentType.startsWith("image/")) {
			res.status(502).json({ error: `Failed to download WeChat media: unexpected content type ${contentType}` });
			return;
		}

		if (imageBytes.byteLength > maxUploadBytes) {
			res.status(413).json({ error: `Image is too large. The current limit is ${Math.floor(maxUploadBytes / 1024 / 1024)}MB.` });
			return;
		}

		const originalName =
			typeof req.body?.originalName === "string"
				? req.body.originalName
				: `${mediaId}.${getFileExtension("", contentType)}`;
		const tempUpload = await createTempUpload({
			buffer: imageBytes,
			contentType,
			originalName,
			source: "wechat",
			wechatMediaId: mediaId,
			storeId: normalizeStoreId(req.body?.storeId),
			userAgent: req.header("user-agent") ?? undefined,
		});

		sendTempUploadResponse(res, tempUpload);
	}),
);

app.post(
	"/api/uploads",
	upload.single("image"),
	asyncHandler(async (req, res) => {
		if (!req.file) {
			res.status(400).json({ error: "Missing image file." });
			return;
		}

		const contentType = getImageContentType(req.file.originalname, req.file.mimetype, req.file.buffer);
		if (!contentType.startsWith("image/")) {
			res.status(415).json({ error: "Only image files can be uploaded." });
			return;
		}

		const tempUpload = await createTempUpload({
			buffer: req.file.buffer,
			contentType,
			originalName: req.file.originalname,
			storeId: normalizeStoreId(req.body?.storeId),
			source: "direct",
			userAgent: req.header("user-agent") ?? undefined,
		});

		sendTempUploadResponse(res, tempUpload);
	}),
);

app.get(
	"/api/uploads/:uploadId/image",
	asyncHandler(async (req, res) => {
		const upload = await readJson<TempUpload>(tempUploadPath(getRouteParam(req.params.uploadId)));
		if (!upload) {
			res.status(404).json({ error: "Upload not found." });
			return;
		}

		if (isExpired(upload.expiresAt)) {
			await expireTempUpload(upload);
			res.status(410).json({ error: "Image expired." });
			return;
		}

		await pipeImage(res, upload.imagePath, upload.contentType, upload.size, upload.originalName, "inline");
	}),
);

app.post(
	"/api/uploads/:uploadId/print",
	asyncHandler(async (req, res) => {
		const result = await createPrintJobFromUpload(getRouteParam(req.params.uploadId));
		if (result.error === "not_found") {
			res.status(404).json({ error: "Upload not found." });
			return;
		}

		if (result.error === "expired") {
			res.status(410).json({ error: "图片已超过 30 分钟，已自动从服务器删除。请重新上传。" });
			return;
		}

		if (!result.job) {
			res.status(500).json({ error: "Failed to create print job." });
			return;
		}

		sendJobCreateResponse(res, result.job);
	}),
);

app.get(
	"/api/jobs/:jobId",
	asyncHandler(async (req, res) => {
		const job = await readJson<PrintJob>(jobPath(getRouteParam(req.params.jobId)));
		if (!job) {
			res.status(404).json({ error: "Job not found." });
			return;
		}

		res.json(publicJob(job));
	}),
);

app.get(
	"/api/print/next",
	authorizePrinterAgent,
	asyncHandler(async (req, res) => {
		const storeId = normalizeStoreId(req.query.storeId);
		const queueDir = pendingDir(storeId);
		await mkdir(queueDir, { recursive: true });
		const markers = await listJsonFiles(queueDir);

		for (const markerName of markers) {
			const markerPath = path.join(queueDir, markerName);
			const marker = await readJson<{ jobId: string }>(markerPath);
			if (!marker) {
				await rm(markerPath, { force: true });
				continue;
			}

			const job = await readJson<PrintJob>(jobPath(marker.jobId));
			if (!job || job.status !== "pending" || normalizeStoreId(job.storeId) !== storeId) {
				await rm(markerPath, { force: true });
				continue;
			}

			if (isExpired(getJobImageExpiresAt(job))) {
				await failExpiredJob(job);
				await rm(markerPath, { force: true });
				continue;
			}

			const now = new Date().toISOString();
			const claimedJob: PrintJob = {
				...job,
				status: "claimed",
				claimedAt: now,
				updatedAt: now,
			};

			await saveJob(claimedJob);
			await rm(markerPath, { force: true });

			res.json({
				job: {
					id: claimedJob.id,
					storeId: claimedJob.storeId,
					status: claimedJob.status,
					originalName: claimedJob.originalName,
					contentType: claimedJob.contentType,
					size: claimedJob.size,
					createdAt: claimedJob.createdAt,
					imageUrl: `/api/print/jobs/${claimedJob.id}/image`,
				},
			});
			return;
		}

		res.json({ job: null, storeId });
	}),
);

app.get(
	"/api/print/jobs/:jobId/image",
	authorizePrinterAgent,
	asyncHandler(async (req, res) => {
		const job = await readJson<PrintJob>(jobPath(getRouteParam(req.params.jobId)));
		if (!job) {
			res.status(404).json({ error: "Job not found." });
			return;
		}

		if (isExpired(getJobImageExpiresAt(job))) {
			await failExpiredJob(job);
			res.status(410).json({ error: "Image expired." });
			return;
		}

		await pipeImage(res, job.imagePath, job.contentType, job.size, job.originalName, "attachment");
	}),
);

app.post(
	"/api/print/jobs/:jobId/status",
	authorizePrinterAgent,
	asyncHandler(async (req, res) => {
		if (req.body?.status !== "printed" && req.body?.status !== "failed") {
			res.status(400).json({ error: "Status must be printed or failed." });
			return;
		}

		const job = await readJson<PrintJob>(jobPath(getRouteParam(req.params.jobId)));
		if (!job) {
			res.status(404).json({ error: "Job not found." });
			return;
		}

		const now = new Date().toISOString();
		const updatedJob: PrintJob = {
			...job,
			status: req.body.status,
			updatedAt: now,
			printedAt: req.body.status === "printed" ? now : job.printedAt,
			failedAt: req.body.status === "failed" ? now : job.failedAt,
			errorMessage: req.body.status === "failed" ? req.body.errorMessage ?? "Print failed." : undefined,
		};

		await saveJob(updatedJob);
		res.json({ ok: true, job: updatedJob });
	}),
);

app.use(
	"/download",
	express.static(downloadDir, {
		dotfiles: "ignore",
		index: false,
		redirect: false,
	}),
);
app.use("/download", (_req, res) => {
	res.status(404).send("Download file not found.");
});

app.use(express.static(clientDir));
app.get(/^\/(?!api\/).*/, (_req, res) => {
	res.sendFile(path.join(clientDir, "index.html"));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
	console.error(error);

	if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
		res.status(413).json({ error: `Image is too large. The current limit is ${Math.floor(maxUploadBytes / 1024 / 1024)}MB.` });
		return;
	}

	if (error instanceof Error && error.message.includes("WeChat")) {
		res.status(502).json({ error: error.message });
		return;
	}

	if (error instanceof Error && error.message.includes("WECHAT_")) {
		res.status(503).json({ error: error.message });
		return;
	}

	res.status(500).json({ error: "Unexpected server error." });
});

await ensureDataDirs();
await cleanupExpiredUploads().catch((error) => console.error("Initial cleanup failed:", error));

const cleanupTimer = setInterval(() => {
	void cleanupExpiredUploads().catch((error) => console.error("Cleanup failed:", error));
}, cleanupIntervalMs);
cleanupTimer.unref?.();

app.listen(port, "0.0.0.0", () => {
	console.log(`Wechat print app listening on http://0.0.0.0:${port}`);
	console.log(`Data directory: ${dataDir}`);
	console.log(`Download directory: ${downloadDir}`);
	console.log(`Upload retention: ${Math.floor(uploadTtlMs / 1000 / 60)} minutes`);
});
