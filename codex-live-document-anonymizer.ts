process.env.PGAS_PROVIDER = 'openai';
process.env.PGAS_OPENAI_BASE_URL = 'http://localhost:8000/v1';
process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
process.env.PGAS_MODEL = 'qwen36-27b';
process.env.PGAS_OPENAI_API_KEY = 'local';
process.env.PGAS_OPENAI_TOOL_CHOICE = 'required';
process.env.PGAS_OPENAI_DISABLE_THINKING = '1';
process.env.PGAS_OPENAI_TEMPERATURE = '0.2';
process.env.PGAS_ROUND_TIMEOUT_MS = '600000';

import { File } from 'node:buffer';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createProviderHandles } from '@simodelne/pgas-server/plugin.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createDocumentAnonymizerProgramEntry } from './src/programs/document-anonymizer/registration.js';

const PROGRAM = 'document-anonymizer';
const MAX_CONTINUES = 32;
const METRICS_URL = 'http://localhost:8000/metrics';

type MappingEntry = {
  token: string;
  original: string;
  type?: string;
  occurrences?: number;
};

type Snapshot = {
  mode: string | null;
  status: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
};

type DriveKind = 'anonymize' | 'rehydrate';

type VllmIdleNote = {
  label: string;
  waitedMs: number;
  samples: Array<{ running: number; line: string }>;
};

type DriveResult = {
  label: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
  finalMode?: string | null;
  finalStatus?: string | null;
  rounds?: number;
  modeTrail?: string[];
  actionNames?: string[];
  failedGates?: string[];
  repairs?: number;
  fallbacks?: number;
  durationsMs?: number[];
  branchTaken?: string;
  extractionKind?: string;
  sourceText?: string;
  outputText?: string;
  mapping?: MappingEntry[];
  rehydrateOutputText?: string;
  rehydrateRestoredCount?: number;
  rawAssertions: Record<string, unknown>;
};

type TestReport = {
  generatedAt: string;
  environment: Record<string, string>;
  provider: string;
  vllmContention: VllmIdleNote[];
  tests: Array<{
    id: string;
    name: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    details: Record<string, unknown>;
  }>;
};

function nonce(prefix: string): string {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getPath(domain: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(domain, path)) return domain[path];
  let current: unknown = domain;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function getString(domain: Record<string, unknown>, path: string): string {
  const value = getPath(domain, path);
  return typeof value === 'string' ? value : '';
}

function getBoolean(domain: Record<string, unknown>, path: string): boolean {
  return getPath(domain, path) === true;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function pickStage(domain: Record<string, unknown>, stage: string): Record<string, unknown> | undefined {
  const output = parseJsonObject(getPath(domain, `${stage}.output`));
  const fromOutput = parseJsonObject(output?.result_json);
  if (fromOutput) return fromOutput;

  const flatOutput = parseJsonObject(getPath(domain, `${stage}.output.result_json`));
  if (flatOutput) return flatOutput;

  if (stage === 'detect_pii') {
    const detect = parseJsonObject(getPath(domain, 'detect_pii.result_json'));
    if (detect) return detect;
  }
  return undefined;
}

function normalizeMapping(value: unknown): MappingEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => typeof entry.token === 'string' && typeof entry.original === 'string')
    .map((entry) => ({
      token: entry.token as string,
      original: entry.original as string,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      occurrences: typeof entry.occurrences === 'number' ? entry.occurrences : undefined,
    }));
}

function restoreWithMapping(outputText: string, mapping: MappingEntry[]): string {
  let restored = outputText;
  for (const entry of [...mapping].sort((a, b) => b.token.length - a.token.length)) {
    restored = restored.split(entry.token).join(entry.original);
  }
  return restored;
}

function branchFromActions(actions: string[], modes: string[]): string {
  if (actions.includes('advance_ingest_to_rehydrate') || modes.includes('rehydrate')) return 'ingest->rehydrate';
  if (actions.includes('advance_ingest_to_detect_pii') || modes.includes('detect_pii')) return 'ingest->detect_pii';
  return 'unknown';
}

async function snapshot(client: any, sessionId: string): Promise<Snapshot> {
  const [env, world] = await Promise.all([client.sessions.get(sessionId), client.sessions.world(sessionId)]);
  const state = env.state && typeof env.state === 'object' ? env.state as Record<string, unknown> : undefined;
  const mode = typeof env.mode === 'string' && env.mode.length > 0
    ? env.mode
    : state && typeof state.mode === 'string'
      ? state.mode
      : null;
  const status = typeof env.status === 'string' ? env.status : null;
  const awaiting = state && state.awaitingUserDecision && typeof state.awaitingUserDecision === 'object'
    ? state.awaitingUserDecision as Record<string, unknown>
    : undefined;
  return { mode, status, domain: world.domain as Record<string, unknown>, awaiting };
}

async function roundEvidence(client: any, sessionId: string): Promise<{
  rounds: number;
  modeTrail: string[];
  actionNames: string[];
  failedGates: string[];
  repairs: number;
  fallbacks: number;
  durationsMs: number[];
}> {
  const response = await client.sessions.roundEnvelopes(sessionId);
  const envelopes = Array.isArray(response?.envelopes) ? response.envelopes as Array<Record<string, unknown>> : [];
  const modeTrail: string[] = [];
  const actionNames: string[] = [];
  const failedGates: string[] = [];
  const durationsMs: number[] = [];
  let repairs = 0;
  let fallbacks = 0;
  for (const envelope of envelopes) {
    if (typeof envelope.modeBefore === 'string' && (modeTrail.length === 0 || modeTrail[modeTrail.length - 1] !== envelope.modeBefore)) {
      modeTrail.push(envelope.modeBefore);
    }
    if (typeof envelope.modeAfter === 'string' && modeTrail[modeTrail.length - 1] !== envelope.modeAfter) {
      modeTrail.push(envelope.modeAfter);
    }
    if (Array.isArray(envelope.actionNames)) {
      for (const action of envelope.actionNames) if (typeof action === 'string') actionNames.push(action);
    }
    if (typeof envelope.terminalActionName === 'string') actionNames.push(envelope.terminalActionName);
    if (Array.isArray(envelope.failedGates)) {
      for (const gate of envelope.failedGates) if (typeof gate === 'string') failedGates.push(`round ${String(envelope.roundNumber)}: ${gate}`);
    }
    repairs += typeof envelope.repairAttempts === 'number' ? envelope.repairAttempts : 0;
    if (envelope.fallback === true) fallbacks += 1;
    if (typeof envelope.durationMs === 'number') durationsMs.push(envelope.durationMs);
  }
  return { rounds: envelopes.length, modeTrail, actionNames, failedGates, repairs, fallbacks, durationsMs };
}

async function uploadDocument(client: any, sessionId: string, name: string, bytes: BlobPart[], type: string): Promise<Record<string, unknown>> {
  const form = new FormData();
  const file = new File(bytes, name, { type });
  form.append('files', file as unknown as Blob, file.name);
  const upload = await client.files.upload(sessionId, form);
  const files = Array.isArray((upload as Record<string, unknown>)?.files) ? (upload as Record<string, unknown>).files as Record<string, unknown>[] : [];
  const first = files[0];
  if (!first || typeof first.fileId !== 'string') {
    throw new Error(`upload did not return a fileId: ${JSON.stringify(upload)}`);
  }
  return first;
}

async function waitForUploadRequest(client: any, sessionId: string): Promise<Snapshot> {
  let current = await snapshot(client, sessionId);
  for (let i = 0; i < 8; i += 1) {
    const channel = typeof current.awaiting?.channelId === 'string' ? current.awaiting.channelId : '';
    if (channel === 'document_upload' || getBoolean(current.domain, 'inputs.document_intake.documents_requested')) {
      return current;
    }
    await client.sessions.trigger(sessionId, {
      channel: 'user_text',
      payload: i === 0 ? 'Please request the document upload now.' : `continue upload request ${String(i)}`,
    });
    current = await snapshot(client, sessionId);
  }
  throw new Error(`document_upload was not requested; last mode=${String(current.mode)} awaiting=${JSON.stringify(current.awaiting ?? null)}`);
}

async function driveToComplete(client: any, sessionId: string): Promise<Snapshot> {
  let current = await snapshot(client, sessionId);
  let previousEvidence = await roundEvidence(client, sessionId);
  let consecutiveSameModeFallbacks = 0;
  for (let i = 0; i < MAX_CONTINUES && current.mode !== 'complete'; i += 1) {
    const modeBefore = current.mode;
    try {
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue ${String(i + 1)}` });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message.toLowerCase().includes('terminal')) break;
      throw error;
    }
    current = await snapshot(client, sessionId);
    process.stdout.write(`[codex-live] ${sessionId} round=${String(i + 1)} mode=${String(current.mode)}\n`);
    const evidence = await roundEvidence(client, sessionId);
    const fallbackAdvanced = evidence.fallbacks > previousEvidence.fallbacks;
    if (current.mode === modeBefore && fallbackAdvanced) {
      consecutiveSameModeFallbacks += 1;
    } else {
      consecutiveSameModeFallbacks = 0;
    }
    previousEvidence = evidence;
    if (consecutiveSameModeFallbacks >= 3) {
      throw new Error(
        `no_progress_same_mode_fallback after continue ${String(i + 1)}; mode=${String(current.mode)}; ` +
        `rounds=${String(evidence.rounds)}; fallbacks=${String(evidence.fallbacks)}; ` +
        `failed_gates=${JSON.stringify(evidence.failedGates.slice(-8))}; ` +
        `actions=${JSON.stringify(evidence.actionNames.slice(-12))}`,
      );
    }
  }
  const final = await snapshot(client, sessionId);
  if (final.mode !== 'complete') {
    const evidence = await roundEvidence(client, sessionId);
    throw new Error(
      `max_continues_reached; mode=${String(final.mode)}; rounds=${String(evidence.rounds)}; ` +
      `fallbacks=${String(evidence.fallbacks)}; failed_gates=${JSON.stringify(evidence.failedGates.slice(-8))}`,
    );
  }
  return final;
}

function extractDriveArtifacts(current: Snapshot | undefined): Pick<
  DriveResult,
  'sourceText' | 'extractionKind' | 'outputText' | 'mapping' | 'rehydrateOutputText' | 'rehydrateRestoredCount'
> {
  const domain = current?.domain ?? {};
  const sourceText = getString(domain, 'inputs.source_document.full_text');
  const extractionKind = getString(domain, 'inputs.source_document.extraction_kind');
  const anonymize = pickStage(domain, 'anonymize');
  const rehydrate = pickStage(domain, 'rehydrate');
  const outputText = typeof anonymize?.output_text === 'string' ? anonymize.output_text : '';
  const mapping = normalizeMapping(anonymize?.mapping);
  const rehydrateOutputText = typeof rehydrate?.output_text === 'string' ? rehydrate.output_text : '';
  const rehydrateRestoredCount = typeof rehydrate?.restored_count === 'number' ? rehydrate.restored_count : undefined;
  return { sourceText, extractionKind, outputText, mapping, rehydrateOutputText, rehydrateRestoredCount };
}

async function runDrive(
  client: any,
  label: string,
  kind: DriveKind,
  requestText: string,
  upload: { name: string; type: string; bytes: BlobPart[] },
): Promise<DriveResult> {
  const created = await client.sessions.create({ program: PROGRAM });
  const sessionId = created.sessionId as string;
  process.stdout.write(`[codex-live] ${label} session=${sessionId}\n`);
  try {
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: requestText });
    await waitForUploadRequest(client, sessionId);
    const fileRef = await uploadDocument(client, sessionId, upload.name, upload.bytes, upload.type);
    process.stdout.write(`[codex-live] ${label} uploaded fileId=${String(fileRef.fileId)} name=${String(fileRef.name)}\n`);
    await client.sessions.trigger(sessionId, {
      channel: 'document_upload',
      payload: { 'inputs.document_intake.file_refs': [{ fileId: fileRef.fileId, name: fileRef.name }] },
    });
    const final = await driveToComplete(client, sessionId);
    const evidence = await roundEvidence(client, sessionId);
    const artifacts = extractDriveArtifacts(final);
    return {
      label,
      sessionId,
      ok: final.mode === 'complete',
      finalMode: final.mode,
      finalStatus: final.status,
      rounds: evidence.rounds,
      modeTrail: evidence.modeTrail,
      actionNames: evidence.actionNames,
      failedGates: evidence.failedGates,
      repairs: evidence.repairs,
      fallbacks: evidence.fallbacks,
      durationsMs: evidence.durationsMs,
      branchTaken: branchFromActions(evidence.actionNames, evidence.modeTrail),
      ...artifacts,
      rawAssertions: { requested_kind: kind },
    };
  } catch (error) {
    let evidence: Awaited<ReturnType<typeof roundEvidence>> | undefined;
    let current: Snapshot | undefined;
    try { evidence = await roundEvidence(client, sessionId); } catch { /* ignore evidence collection failure */ }
    try { current = await snapshot(client, sessionId); } catch { /* ignore snapshot failure */ }
    return {
      label,
      sessionId,
      ok: false,
      error: String((error as Error)?.stack ?? error),
      finalMode: current?.mode,
      finalStatus: current?.status,
      rounds: evidence?.rounds,
      modeTrail: evidence?.modeTrail,
      actionNames: evidence?.actionNames,
      failedGates: evidence?.failedGates,
      repairs: evidence?.repairs,
      fallbacks: evidence?.fallbacks,
      durationsMs: evidence?.durationsMs,
      branchTaken: evidence ? branchFromActions(evidence.actionNames, evidence.modeTrail) : undefined,
      ...extractDriveArtifacts(current),
      rawAssertions: { requested_kind: kind },
    };
  }
}

function parseMetricRunning(metricsText: string): { running: number; line: string } {
  const lines = metricsText.split(/\r?\n/u).filter((line) => line.includes('num_requests_running') && !line.startsWith('#'));
  const values = lines
    .map((line) => {
      const match = /(?:^|\s)(-?\d+(?:\.\d+)?)(?:\s*)$/u.exec(line.trim());
      return match ? Number(match[1]) : Number.NaN;
    })
    .filter((value) => Number.isFinite(value));
  return {
    running: values.reduce((sum, value) => sum + value, 0),
    line: lines.join(' | '),
  };
}

async function waitForVllmIdle(label: string): Promise<VllmIdleNote> {
  const started = Date.now();
  const samples: Array<{ running: number; line: string }> = [];
  for (;;) {
    const response = await fetch(METRICS_URL);
    if (!response.ok) {
      throw new Error(`vLLM metrics check failed for ${label}: HTTP ${String(response.status)} ${response.statusText}`);
    }
    const parsed = parseMetricRunning(await response.text());
    samples.push(parsed);
    if (parsed.running <= 0) {
      const waitedMs = Date.now() - started;
      process.stdout.write(`[codex-live] vLLM idle before ${label}: running=${String(parsed.running)} waitedMs=${String(waitedMs)}\n`);
      return { label, waitedMs, samples };
    }
    process.stdout.write(`[codex-live] vLLM busy before ${label}: running=${String(parsed.running)}; waiting\n`);
    if (Date.now() - started > 30 * 60 * 1000) {
      throw new Error(`vLLM stayed busy before ${label} for more than 1800000ms; last=${parsed.line}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function makeDocx(text: string): Buffer {
  const paragraphs = text.split('\n').map((line) => `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`).join('');
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${paragraphs}<w:sectPr/></w:body>`,
    '</w:document>',
  ].join('');
  return zipDeflate([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

function zipDeflate(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function anonymizeAssertions(drive: DriveResult, original: string, nonceValue?: string, expectedPii: string[] = []): Record<string, unknown> {
  const mapping = drive.mapping ?? [];
  const output = drive.outputText ?? '';
  const restored = restoreWithMapping(output, mapping);
  const mappingOriginals = mapping.map((entry) => entry.original);
  const expectedMissingFromOutput = expectedPii.filter((pii) => output.includes(pii));
  const expectedMissingFromMapping = expectedPii.filter((pii) => !mappingOriginals.some((originalEntry) => originalEntry.includes(pii) || pii.includes(originalEntry)));
  const hasNonce = typeof nonceValue === 'string' && nonceValue.length > 0;
  return {
    final_mode: drive.finalMode,
    branch_taken: drive.branchTaken,
    extraction_kind: drive.extractionKind,
    nonce_in_output: hasNonce ? output.includes(nonceValue) : null,
    nonce_in_mapping: hasNonce ? mapping.some((entry) => entry.original.includes(nonceValue)) : null,
    mapping_entries: mapping.length,
    mapping_entries_json: mapping,
    reverse_byte_exact: restored === original,
    source_text_matches_original: drive.sourceText === original,
    expected_pii_left_in_output: expectedMissingFromOutput,
    expected_pii_missing_from_mapping: expectedMissingFromMapping,
    actions: drive.actionNames,
    modes: drive.modeTrail,
    failed_gates: drive.failedGates,
    repair_attempts: drive.repairs,
    fallbacks: drive.fallbacks,
  };
}

function rehydrateAssertions(drive: DriveResult, original: string, mapping: MappingEntry[]): Record<string, unknown> {
  const restored = drive.rehydrateOutputText ?? '';
  const tokensLeft = mapping.map((entry) => entry.token).filter((token) => restored.includes(token));
  const detectPiiSeen = (drive.actionNames ?? []).includes('complete_detect_pii') || (drive.modeTrail ?? []).includes('detect_pii');
  return {
    final_mode: drive.finalMode,
    branch_taken: drive.branchTaken,
    extraction_kind: drive.extractionKind,
    restored_equals_original: restored === original,
    tokens_left: tokensLeft,
    detect_pii_seen: detectPiiSeen,
    restored_count: drive.rehydrateRestoredCount,
    actions: drive.actionNames,
    modes: drive.modeTrail,
    failed_gates: drive.failedGates,
    repair_attempts: drive.repairs,
    fallbacks: drive.fallbacks,
  };
}

function statusFromAssertions(kind: 'anon' | 'rehydrate', assertions: Record<string, unknown>): 'PASS' | 'FAIL' {
  if (assertions.final_mode !== 'complete') return 'FAIL';
  if (kind === 'anon') {
    if (assertions.branch_taken !== 'ingest->detect_pii') return 'FAIL';
    if (assertions.nonce_in_output !== null && assertions.nonce_in_output !== false) return 'FAIL';
    if (assertions.nonce_in_mapping !== null && assertions.nonce_in_mapping !== true) return 'FAIL';
    if (assertions.reverse_byte_exact !== true) return 'FAIL';
    if (assertions.source_text_matches_original !== true) return 'FAIL';
    if (Array.isArray(assertions.expected_pii_left_in_output) && assertions.expected_pii_left_in_output.length > 0) return 'FAIL';
    if (Array.isArray(assertions.expected_pii_missing_from_mapping) && assertions.expected_pii_missing_from_mapping.length > 0) return 'FAIL';
    return 'PASS';
  }
  if (assertions.branch_taken !== 'ingest->rehydrate') return 'FAIL';
  if (assertions.detect_pii_seen !== false) return 'FAIL';
  if (assertions.restored_equals_original !== true) return 'FAIL';
  if (Array.isArray(assertions.tokens_left) && assertions.tokens_left.length > 0) return 'FAIL';
  return 'PASS';
}

function makeReportMarkdown(report: TestReport): string {
  const lines: string[] = [];
  lines.push('# CODEX Live Test: Document Anonymizer');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Provider: ${report.provider}`);
  lines.push('');
  lines.push('## Environment');
  for (const [key, value] of Object.entries(report.environment)) lines.push(`- ${key}=${value}`);
  lines.push('');
  lines.push('## vLLM Contention');
  for (const note of report.vllmContention) {
    const last = note.samples[note.samples.length - 1];
    lines.push(`- ${note.label}: waited_ms=${note.waitedMs}; final_num_requests_running=${String(last?.running ?? 'unknown')}; final_metric_line=${JSON.stringify(last?.line ?? '')}`);
  }
  lines.push('');
  lines.push('## Results');
  for (const test of report.tests) {
    lines.push(`### ${test.id}. ${test.name}: ${test.status}`);
    for (const [key, value] of Object.entries(test.details)) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function main(): Promise<void> {
  const providerNotes: VllmIdleNote[] = [];
  const tests: TestReport['tests'] = [];
  const { authorHandle, observerHandle } = createProviderHandles({ provider: 'openai' });
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-doc-anon-live-'));
  const server = await createPgasServer({
    programs: [{ name: PROGRAM, entry: createDocumentAnonymizerProgramEntry() }],
    drivers: { provider: 'openai', authorHandle, observerHandle, authorMode: 'json' },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  } as never);
  const client = createPgasClient(appTransport((server as any).app, { token: 'dev-token' }));

  let test1Drive: DriveResult | undefined;
  let original1 = '';
  try {
    const nonce1 = nonce('TXT');
    original1 = [
      'CONFIDENTIAL MEMO',
      '',
      `From: Alice Johnson (alice.johnson.${nonce1}@example.com), phone +1-202-555-0173.`,
      'To: Bob Smith at Acme Corporation, 123 Main Street, Springfield.',
      `Re: settlement for client Carol Danvers, case reference CASE-${nonce1}.`,
      '',
      'Alice Johnson will follow up with Bob Smith next week. Acme Corporation confirmed.',
    ].join('\n');
    providerNotes.push(await waitForVllmIdle('test1-anonymize-txt'));
    test1Drive = await runDrive(client, 'test1-anonymize-txt', 'anonymize', 'Please anonymize the uploaded TXT document. Remove all PII and produce a reversible mapping.', {
      name: 'codex-live-memo.txt',
      type: 'text/plain',
      bytes: [original1],
    });
    const details = {
      ...anonymizeAssertions(test1Drive, original1, nonce1),
      session_id: test1Drive.sessionId,
      rounds: test1Drive.rounds,
      error: test1Drive.error,
    };
    tests.push({ id: '1', name: 'ANONYMIZE / TXT', status: test1Drive.error ? 'FAIL' : statusFromAssertions('anon', details), details });
  } catch (error) {
    tests.push({
      id: '1',
      name: 'ANONYMIZE / TXT',
      status: 'FAIL',
      details: { error: String((error as Error)?.stack ?? error) },
    });
  }

  try {
    const nonce2 = nonce('DOCX');
    const original2 = [
      'DOCX intake memo',
      `Prepared by Eve Martinez at eve.martinez.${nonce2}@example.com.`,
      `Matter ID CASE-${nonce2} for patient Oscar Reed.`,
      'Clinic: Westlake Health Partners.',
    ].join('\n');
    providerNotes.push(await waitForVllmIdle('test2-anonymize-docx'));
    const docx = makeDocx(original2);
    const test2Drive = await runDrive(client, 'test2-anonymize-docx', 'anonymize', 'Please anonymize this DOCX file and produce a reversible mapping.', {
      name: 'codex-live-source.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: [docx],
    });
    const test2Details = {
      ...anonymizeAssertions(test2Drive, original2, nonce2),
      session_id: test2Drive.sessionId,
      rounds: test2Drive.rounds,
      error: test2Drive.error,
    };
    const test2Status = test2Drive.error
      ? 'FAIL'
      : statusFromAssertions('anon', test2Details) === 'PASS' && String(test2Details.extraction_kind).includes('docx')
        ? 'PASS'
        : 'FAIL';
    tests.push({ id: '2', name: 'ANONYMIZE / DOCX', status: test2Status, details: test2Details });
  } catch (error) {
    tests.push({
      id: '2',
      name: 'ANONYMIZE / DOCX',
      status: 'FAIL',
      details: { error: String((error as Error)?.stack ?? error) },
    });
  }

  try {
    if (test1Drive?.outputText && test1Drive.mapping && test1Drive.mapping.length > 0) {
      providerNotes.push(await waitForVllmIdle('test3-rehydrate'));
      const mappingJson = JSON.stringify(test1Drive.mapping);
      const test3Drive = await runDrive(
        client,
        'test3-rehydrate',
        'rehydrate',
        `REHYDRATE / REBUILD the uploaded anonymized text using this mapping JSON array:\n${mappingJson}`,
        {
          name: 'codex-live-anonymized.txt',
          type: 'text/plain',
          bytes: [test1Drive.outputText],
        },
      );
      const test3Details = {
        ...rehydrateAssertions(test3Drive, original1, test1Drive.mapping),
        session_id: test3Drive.sessionId,
        rounds: test3Drive.rounds,
        error: test3Drive.error,
      };
      tests.push({ id: '3', name: 'REHYDRATE', status: test3Drive.error ? 'FAIL' : statusFromAssertions('rehydrate', test3Details), details: test3Details });
    } else {
      tests.push({
        id: '3',
        name: 'REHYDRATE',
        status: 'SKIP',
        details: { reason: 'test 1 did not produce anonymized output_text plus mapping', test1_session_id: test1Drive?.sessionId, test1_error: test1Drive?.error },
      });
    }
  } catch (error) {
    tests.push({
      id: '3',
      name: 'REHYDRATE',
      status: 'FAIL',
      details: { error: String((error as Error)?.stack ?? error), test1_session_id: test1Drive?.sessionId },
    });
  }

  try {
    const original4 = [
      'Vendor onboarding record',
      'Nadia Flores and Marcus Lee represent Northstar Biologics.',
      'Primary phone: 415-555-0198.',
      'Office address: 740 Market Street, San Francisco, CA 94103.',
      'The org requested contract review on July 19, 2026.',
    ].join('\n');
    const expectedPii4 = [
      'Nadia Flores',
      'Marcus Lee',
      'Northstar Biologics',
      '415-555-0198',
      '740 Market Street, San Francisco, CA 94103',
    ];
    providerNotes.push(await waitForVllmIdle('test4-anonymize-robustness'));
    const test4Drive = await runDrive(client, 'test4-anonymize-robustness', 'anonymize', 'Anonymize this different record. Detect names, phone numbers, addresses, organizations, and dates.', {
      name: 'codex-live-robustness.txt',
      type: 'text/plain',
      bytes: [original4],
    });
    const test4Details = {
      ...anonymizeAssertions(test4Drive, original4, undefined, expectedPii4),
      session_id: test4Drive.sessionId,
      rounds: test4Drive.rounds,
      error: test4Drive.error,
    };
    tests.push({ id: '4', name: 'ANONYMIZE / TXT DIFFERENT PII', status: test4Drive.error ? 'FAIL' : statusFromAssertions('anon', test4Details), details: test4Details });
  } catch (error) {
    tests.push({
      id: '4',
      name: 'ANONYMIZE / TXT DIFFERENT PII',
      status: 'FAIL',
      details: { error: String((error as Error)?.stack ?? error) },
    });
  } finally {
    await (server as any).close?.();
  }

  const report: TestReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      PGAS_PROVIDER: process.env.PGAS_PROVIDER ?? '',
      PGAS_OPENAI_BASE_URL: process.env.PGAS_OPENAI_BASE_URL ?? '',
      PGAS_OPENAI_MODEL: process.env.PGAS_OPENAI_MODEL ?? '',
      PGAS_MODEL: process.env.PGAS_MODEL ?? '',
      PGAS_OPENAI_API_KEY: process.env.PGAS_OPENAI_API_KEY ?? '',
      PGAS_OPENAI_TOOL_CHOICE: process.env.PGAS_OPENAI_TOOL_CHOICE ?? '',
      PGAS_OPENAI_DISABLE_THINKING: process.env.PGAS_OPENAI_DISABLE_THINKING ?? '',
      PGAS_OPENAI_TEMPERATURE: process.env.PGAS_OPENAI_TEMPERATURE ?? '',
      PGAS_ROUND_TIMEOUT_MS: process.env.PGAS_ROUND_TIMEOUT_MS ?? '',
    },
    provider: String((authorHandle as Record<string, unknown>).modelId ?? 'openai:qwen36-27b'),
    vllmContention: providerNotes,
    tests,
  };
  mkdirSync('audit', { recursive: true });
  const markdown = makeReportMarkdown(report);
  writeFileSync('audit/CODEX-LIVE-TEST.md', markdown);
  process.stdout.write(`\n${markdown}`);

  process.exitCode = tests.some((test) => test.status === 'FAIL' || test.status === 'SKIP') ? 1 : 0;
  process.exit(process.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[codex-live] FATAL ${String((error as Error)?.stack ?? error)}\n`);
    process.exit(1);
  });
}
