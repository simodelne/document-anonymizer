import { File as NodeFile } from 'node:buffer';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

type PgasClient = ReturnType<(typeof import('@simodelne/pgas-server/client.js'))['createPgasClient']>;

interface MappingEntry {
  token: string;
  original: string;
  type: string;
  occurrences: number;
}

interface UploadedDocument {
  name: string;
  mimeType: string;
  extension: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface DriveResult {
  sessionId: string;
  finalMode: string | null;
  sourceText: string;
  result: Record<string, unknown>;
  docxBase64?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, 'index.html');
const port = Number(process.env.PORT ?? '5178');
const uploadsRoot = mkdtempSync(join(tmpdir(), 'document-anonymizer-frontend-'));
const uploadsDir = join(uploadsRoot, 'uploads');

setProviderDefaults();
mkdirSync(uploadsDir, { recursive: true });

const [{ createPgasServer }, { appTransport, createPgasClient }, { createProviderHandles }, { createDocumentAnonymizerProgramEntry }] = await Promise.all([
  import('@simodelne/pgas-server/create-server.js'),
  import('@simodelne/pgas-server/client.js'),
  import('@simodelne/pgas-server/plugin.js'),
  import('../src/programs/document-anonymizer/registration.js'),
]);

const { authorHandle, observerHandle } = createProviderHandles({ provider: 'openai' });
const pgasServer = await createPgasServer({
  programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
  drivers: { authorHandle, observerHandle, authorMode: 'json' },
  devMode: true,
  storage: { uploadsDir },
  telemetry: { enabled: false },
  port: 0,
} as never);
const client = createPgasClient(appTransport((pgasServer as { app: unknown }).app as never, { token: 'dev-token' }));

const httpServer = createServer((req, res) => {
  void route(req, res).catch((error) => {
    const statusCode = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
    sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  process.stdout.write(`document-anonymizer frontend on http://localhost:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/anonymize') {
    const form = await readMultipart(req);
    const file = await readRequiredFile(form, 'file');
    const result = await driveAnonymize(client, file);
    const mapping = normalizeMapping(result.result.mapping);
    sendJson(res, 200, {
      output_text: stringField(result.result, 'output_text'),
      format: stringField(result.result, 'format'),
      mapping,
      entity_count: numberField(result.result, 'entity_count'),
      source_text: result.sourceText,
      session_id: result.sessionId,
      final_mode: result.finalMode,
      download_name: `anonymized.${downloadExtension(file, result.docxBase64)}`,
      docx_base64: result.docxBase64,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rehydrate') {
    const form = await readMultipart(req);
    const file = await readRequiredFile(form, 'file');
    const mappingText = await readMappingText(form);
    const mapping = parseMappingJson(mappingText);
    const result = await driveRehydrate(client, file, mapping);
    sendJson(res, 200, {
      output_text: stringField(result.result, 'output_text'),
      format: stringField(result.result, 'format'),
      restored_count: numberField(result.result, 'restored_count'),
      source_text: result.sourceText,
      session_id: result.sessionId,
      final_mode: result.finalMode,
      download_name: `restored.${downloadExtension(file, result.docxBase64)}`,
      docx_base64: result.docxBase64,
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function setProviderDefaults(): void {
  process.env.PGAS_PROVIDER ??= 'openai';
  process.env.PGAS_OPENAI_BASE_URL ??= 'http://localhost:8000/v1';
  process.env.PGAS_OPENAI_MODEL ??= 'qwen36-27b';
  process.env.PGAS_MODEL ??= 'qwen36-27b';
  process.env.PGAS_OPENAI_API_KEY ??= 'local';
  process.env.PGAS_OPENAI_TOOL_CHOICE ??= 'required';
  process.env.PGAS_OPENAI_DISABLE_THINKING ??= '1';
  process.env.PGAS_OPENAI_TEMPERATURE ??= '0.2';
  process.env.PGAS_ROUND_TIMEOUT_MS ??= '600000';
  process.env.PGAS_LOG_LEVEL ??= 'silent';
}

async function driveAnonymize(pgasClient: PgasClient, file: UploadedDocument): Promise<DriveResult> {
  return driveDocument(pgasClient, file, {
    initialText: 'Please anonymize the uploaded document. Remove all personally identifying information and give me a reversible mapping.',
    resultStage: 'anonymize',
  });
}

async function driveRehydrate(
  pgasClient: PgasClient,
  file: UploadedDocument,
  mapping: MappingEntry[],
): Promise<DriveResult> {
  const mappingJson = JSON.stringify(mapping);
  return driveDocument(pgasClient, file, {
    initialText: [
      'Please rehydrate/rebuild the uploaded anonymized document using the mapping JSON array below.',
      'Do not anonymize it again; choose the rehydrate branch and rebuild the original text.',
      mappingJson,
    ].join('\n'),
    resultStage: 'rehydrate',
  });
}

async function driveDocument(
  pgasClient: PgasClient,
  file: UploadedDocument,
  options: { initialText: string; resultStage: 'anonymize' | 'rehydrate' },
): Promise<DriveResult> {
  const created = await pgasClient.sessions.create({ program: 'document-anonymizer' });
  const sessionId = created.sessionId;

  await pgasClient.sessions.trigger(sessionId, { channel: 'user_text', payload: options.initialText });
  let snap = await snapshot(pgasClient, sessionId);
  for (let i = 0; i < 4 && snap.awaiting?.channelId !== 'document_upload' && snap.mode !== 'ingest'; i += 1) {
    await pgasClient.sessions.trigger(sessionId, {
      channel: 'user_text',
      payload: 'Go ahead and request the upload.',
    });
    snap = await snapshot(pgasClient, sessionId);
  }

  const form = new FormData();
  const uploadFile = new NodeFile([file.bytes], file.name, { type: file.mimeType });
  form.append('files', uploadFile as unknown as Blob, uploadFile.name);
  const upload = await pgasClient.files.upload(sessionId, form) as { files?: Array<{ fileId: string; name: string }> };
  const fileRef = (upload.files ?? [])[0];
  if (!fileRef?.fileId) {
    throw new Error('PGAS file upload did not return a fileId');
  }
  await pgasClient.sessions.trigger(sessionId, {
    channel: 'document_upload',
    payload: { ['inputs.document_intake.file_refs']: [{ fileId: fileRef.fileId, name: fileRef.name }] },
  });

  let final = await snapshot(pgasClient, sessionId);
  const immediate = resultFromSnapshot(sessionId, final, options.resultStage);
  if (immediate) {
    return immediate;
  }
  for (let i = 0; i < 24 && final.mode !== 'complete'; i += 1) {
    try {
      await pgasClient.sessions.trigger(sessionId, {
        channel: 'user_text',
        payload: `continue ${String(i + 1)}`,
      });
    } catch (error) {
      if (String((error as Error).message).toLowerCase().includes('terminal')) {
        break;
      }
      throw error;
    }
    final = await snapshot(pgasClient, sessionId);
    const stageResult = resultFromSnapshot(sessionId, final, options.resultStage);
    if (stageResult) {
      return stageResult;
    }
  }
  final = await snapshot(pgasClient, sessionId);

  const result = pickStage(final.domain, options.resultStage);
  if (!result) {
    throw new Error(`PGAS session did not produce ${options.resultStage}.output.result_json; final_mode=${String(final.mode)}`);
  }
  const docx = pickStage(final.domain, options.resultStage === 'anonymize' ? 'export_anonymized' : 'export_restored');
  return {
    sessionId,
    finalMode: final.mode,
    sourceText: typeof final.domain['inputs.source_document.full_text'] === 'string'
      ? final.domain['inputs.source_document.full_text'] as string
      : '',
    result,
    docxBase64: typeof docx?.docx_base64 === 'string' ? docx.docx_base64 : undefined,
  };
}

function resultFromSnapshot(
  sessionId: string,
  snap: { mode: string | null; domain: Record<string, unknown> },
  resultStage: 'anonymize' | 'rehydrate',
): DriveResult | undefined {
  const result = pickStage(snap.domain, resultStage);
  if (!result) {
    return undefined;
  }
  const docx = snap.mode === 'complete'
    ? pickStage(snap.domain, resultStage === 'anonymize' ? 'export_anonymized' : 'export_restored')
    : undefined;
  return {
    sessionId,
    finalMode: snap.mode,
    sourceText: typeof snap.domain['inputs.source_document.full_text'] === 'string'
      ? snap.domain['inputs.source_document.full_text'] as string
      : '',
    result,
    docxBase64: typeof docx?.docx_base64 === 'string' ? docx.docx_base64 : undefined,
  };
}

async function snapshot(pgasClient: PgasClient, sessionId: string): Promise<{
  mode: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
}> {
  const [env, world] = await Promise.all([
    pgasClient.sessions.get(sessionId),
    pgasClient.sessions.world(sessionId),
  ]);
  const envRecord = env as Record<string, unknown>;
  const state = isRecord(envRecord.state) ? envRecord.state : undefined;
  const mode = typeof envRecord.mode === 'string' && envRecord.mode
    ? envRecord.mode
    : state && typeof state.mode === 'string'
      ? state.mode
      : null;
  const awaiting = state && isRecord(state.awaitingUserDecision) ? state.awaitingUserDecision : undefined;
  const worldRecord = world as { domain?: unknown };
  return {
    mode,
    domain: isRecord(worldRecord.domain) ? worldRecord.domain : {},
    awaiting,
  };
}

function pickStage(domain: Record<string, unknown>, stage: string): Record<string, unknown> | undefined {
  const objectOutput = domain[`${stage}.output`];
  if (isRecord(objectOutput)) {
    if (typeof objectOutput.result_json === 'string') {
      return parseRecord(objectOutput.result_json);
    }
    if (isRecord(objectOutput.result_json)) {
      return objectOutput.result_json;
    }
  }
  const flatOutput = domain[`${stage}.output.result_json`];
  if (typeof flatOutput === 'string') {
    return parseRecord(flatOutput);
  }
  if (isRecord(flatOutput)) {
    return flatOutput;
  }
  return undefined;
}

async function readMultipart(req: IncomingMessage): Promise<FormData> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  const request = new Request('http://localhost/', {
    method: req.method,
    headers,
    body: Readable.toWeb(req) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return request.formData();
}

async function readRequiredFile(form: FormData, fieldName: string): Promise<UploadedDocument> {
  const value = form.get(fieldName);
  if (!isFormFile(value)) {
    throw httpError(400, `Missing multipart file field "${fieldName}"`);
  }
  const extension = extensionFor(value.name, value.type);
  if (!extension) {
    throw httpError(400, 'Unsupported file type. Use .txt, .md, .markdown, .docx, or .pdf.');
  }
  const mimeType = mimeForExtension(extension);
  const bytes = new Uint8Array(await value.arrayBuffer());
  return {
    name: sanitizeName(value.name, extension),
    mimeType,
    extension,
    bytes,
  };
}

async function readMappingText(form: FormData): Promise<string> {
  const raw = form.get('mapping');
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw;
  }
  const uploaded = form.get('mapping_file');
  if (isFormFile(uploaded)) {
    const text = await uploaded.text();
    if (text.trim().length > 0) {
      return text;
    }
  }
  throw httpError(400, 'Missing mapping JSON in "mapping" or "mapping_file".');
}

function parseMappingJson(text: string): MappingEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, 'Mapping JSON is not valid JSON.');
  }
  const mapping = normalizeMapping(parsed);
  if (mapping.length === 0) {
    throw httpError(400, 'Mapping JSON must be a non-empty array with token and original fields.');
  }
  return mapping;
}

function normalizeMapping(value: unknown): MappingEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): MappingEntry[] => {
    if (!isRecord(entry) || typeof entry.token !== 'string' || typeof entry.original !== 'string') {
      return [];
    }
    return [{
      token: entry.token,
      original: entry.original,
      type: typeof entry.type === 'string' ? entry.type : 'ENTITY',
      occurrences: typeof entry.occurrences === 'number' ? entry.occurrences : 0,
    }];
  });
}

function extensionFor(name: string, mimeType: string): string | undefined {
  const rawExt = extname(name).toLowerCase();
  if (rawExt === '.txt') return 'txt';
  if (rawExt === '.md' || rawExt === '.markdown') return rawExt.slice(1);
  if (rawExt === '.docx') return 'docx';
  if (rawExt === '.pdf') return 'pdf';
  const normalized = mimeType.toLowerCase();
  if (normalized === 'text/plain') return 'txt';
  if (normalized === 'text/markdown') return 'md';
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (normalized === 'application/pdf') return 'pdf';
  return undefined;
}

function mimeForExtension(extension: string): string {
  switch (extension) {
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function downloadExtension(file: UploadedDocument, docxBase64?: string): string {
  if (file.extension === 'docx' && docxBase64) {
    return 'docx';
  }
  if (file.extension === 'md' || file.extension === 'markdown') {
    return file.extension;
  }
  return 'txt';
}

function sanitizeName(name: string, extension: string): string {
  const basename = name.split(/[\\/]/).pop()?.replace(/[^\w .()[\]-]+/g, '_').trim();
  if (basename && basename.includes('.')) {
    return basename;
  }
  return `upload.${extension}`;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
}

function parseRecord(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isFormFile(value: FormDataEntryValue | null): value is File {
  return !!value
    && typeof value === 'object'
    && typeof (value as File).name === 'string'
    && typeof (value as File).arrayBuffer === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sendHtml(res: ServerResponse): void {
  const html = readFileSync(htmlPath, 'utf8');
  res.writeHead(200, {
    ...corsHeaders(),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    setTimeout(resolve, 2_000);
  });
  await (pgasServer as { close?: () => Promise<void> }).close?.();
  rmSync(uploadsRoot, { recursive: true, force: true });
}
