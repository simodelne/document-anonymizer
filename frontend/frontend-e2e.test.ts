import { File } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';

interface MappingEntry {
  token: string;
  original: string;
  type?: string;
  occurrences?: number;
}

interface AnonymizeResponse {
  output_text: string;
  format: string;
  mapping: MappingEntry[];
  source_text?: string;
  final_mode?: string;
}

interface RehydrateResponse {
  output_text: string;
  format: string;
  restored_count: number;
  source_text?: string;
  final_mode?: string;
}

interface FrontendProcess {
  child: ChildProcess;
  baseUrl: string;
  output: () => string;
  stop: () => Promise<void>;
}

const RUN_TIMEOUT_MS = 900_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function nonce(prefix: string): string {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function reverseWithMapping(outputText: string, mapping: MappingEntry[]): string {
  const longestFirst = [...mapping].sort((a, b) => b.token.length - a.token.length);
  let restored = outputText;
  for (const entry of longestFirst) {
    restored = restored.split(entry.token).join(entry.original);
  }
  return restored;
}

function makePdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const escapePdf = (value: string) => value.replace(/([()\\])/g, '\\$1');
  const body = lines
    .map((line, index) => `${index === 0 ? '72 720 Td' : '0 -18 Td'} (${escapePdf(line)}) Tj`)
    .join('\n');
  const stream = `BT /F1 12 Tf\n${body}\nET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((bodyText, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${bodyText}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1')) as Uint8Array<ArrayBuffer>;
}

async function startFrontend(port: number): Promise<FrontendProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'frontend/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const readyLine = `document-anonymizer frontend on http://localhost:${port}`;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`frontend did not start within 120s\n${output}`));
    }, 120_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`frontend exited before ready code=${String(code)} signal=${String(signal)}\n${output}`));
    });
    const poll = setInterval(() => {
      if (output.includes(readyLine)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 3_000);
      });
    },
  };
}

async function waitForVllmIdle(): Promise<number> {
  const deadline = Date.now() + 600_000;
  let lastRunning = -1;
  while (Date.now() < deadline) {
    const response = await fetch('http://localhost:8000/metrics');
    assert(response.ok, `vLLM metrics returned HTTP ${response.status}`);
    const metrics = await response.text();
    const runningValues = [...metrics.matchAll(/^vllm:num_requests_running(?:\{[^}]*\})?\s+([0-9.]+)/gm)]
      .map((match) => Number(match[1]));
    assert(runningValues.length > 0, 'vLLM metrics did not contain vllm:num_requests_running');
    lastRunning = runningValues.reduce((sum, value) => sum + value, 0);
    if (lastRunning === 0) {
      return lastRunning;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`vLLM still had num_requests_running=${lastRunning} after waiting`);
}

async function postFile<T>(
  url: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append('file', file as unknown as Blob, file.name);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const body = await response.text();
  assert(response.ok, `${url} returned HTTP ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function main() {
  const port = 18_000 + Math.floor(Math.random() * 20_000);
  const frontend = await startFrontend(port);
  const summary: string[] = [];
  try {
    const home = await fetch(`${frontend.baseUrl}/`, { signal: AbortSignal.timeout(30_000) });
    const html = await home.text();
    const containsUploadForm = html.includes('id="anonymize-form"') && html.includes('id="rehydrate-form"');
    assert(home.status === 200, `GET / returned ${home.status}`);
    assert(containsUploadForm, 'GET / did not contain both upload forms');
    summary.push(`home_status=${home.status} contains_upload_form=${containsUploadForm}`);

    const idle = await waitForVllmIdle();
    summary.push(`vllm_num_requests_running_before_drive=${idle}`);

    const txtNonce = nonce('TXTE2E');
    const txtOriginal = [
      'CONFIDENTIAL CASE NOTE',
      '',
      `Primary contact: Alice Johnson <foo.${txtNonce}@example.com>.`,
      `Identifier: CASE-${txtNonce}.`,
      'Alice Johnson spoke with Bob Smith at Northstar Health.',
    ].join('\n');
    const txtResult = await postFile<AnonymizeResponse>(
      `${frontend.baseUrl}/api/anonymize`,
      new File([txtOriginal], 'case-note.txt', { type: 'text/plain' }),
    );
    const txtReverse = reverseWithMapping(txtResult.output_text, txtResult.mapping);
    const txtNonceInOutput = txtResult.output_text.includes(txtNonce);
    const txtNonceInMapping = txtResult.mapping.some((entry) => entry.original.includes(txtNonce));
    const txtReverseExact = txtReverse === txtOriginal;
    assert(!txtNonceInOutput, `TXT output still contained nonce ${txtNonce}: ${txtResult.output_text}`);
    assert(txtResult.mapping.length > 0, 'TXT mapping was empty');
    assert(txtNonceInMapping, `TXT mapping did not contain nonce ${txtNonce}`);
    assert(txtReverseExact, 'TXT reverse mapping did not reproduce original text byte-exact');
    summary.push(
      `txt_nonce=${txtNonce} final_mode=${txtResult.final_mode ?? ''} output_has_nonce=${txtNonceInOutput} mapping_entries=${txtResult.mapping.length} mapping_has_nonce=${txtNonceInMapping} reverse_byte_exact=${txtReverseExact}`,
    );

    const pdfNonce = nonce('PDFE2E');
    const pdfLines = [
      'CONFIDENTIAL PDF INTAKE',
      'Patient Dana Wells',
      `email dana.${pdfNonce}@example.com`,
      `case CASE-${pdfNonce}`,
      'Clinic Northstar Health',
    ];
    const pdfResult = await postFile<AnonymizeResponse>(
      `${frontend.baseUrl}/api/anonymize`,
      new File([makePdf(pdfLines)], 'intake.pdf', { type: 'application/pdf' }),
    );
    const pdfSource = pdfResult.source_text ?? '';
    const pdfReverse = reverseWithMapping(pdfResult.output_text, pdfResult.mapping);
    const pdfNonceInOutput = pdfResult.output_text.includes(pdfNonce);
    const pdfNonceInMapping = pdfResult.mapping.some((entry) => entry.original.includes(pdfNonce));
    const pdfReverseExact = pdfReverse === pdfSource && pdfSource.length > 0;
    assert(pdfSource.includes(pdfNonce), `PDF source text did not include nonce ${pdfNonce}: ${pdfSource}`);
    assert(!pdfNonceInOutput, `PDF output still contained nonce ${pdfNonce}: ${pdfResult.output_text}`);
    assert(pdfResult.mapping.length > 0, 'PDF mapping was empty');
    assert(pdfNonceInMapping, `PDF mapping did not contain nonce ${pdfNonce}`);
    assert(pdfReverseExact, 'PDF reverse mapping did not reproduce extracted source text exactly');
    summary.push(
      `pdf_nonce=${pdfNonce} final_mode=${pdfResult.final_mode ?? ''} format=${pdfResult.format} source_len=${pdfSource.length} output_has_nonce=${pdfNonceInOutput} mapping_entries=${pdfResult.mapping.length} mapping_has_nonce=${pdfNonceInMapping} reverse_extracted_text_exact=${pdfReverseExact}`,
    );

    const rehydrated = await postFile<RehydrateResponse>(
      `${frontend.baseUrl}/api/rehydrate`,
      new File([txtResult.output_text], 'case-note.anonymized.txt', { type: 'text/plain' }),
      { mapping: JSON.stringify(txtResult.mapping) },
    );
    const rehydrateExact = rehydrated.output_text === txtOriginal;
    assert(rehydrateExact, 'Rehydrate output did not equal the original TXT document');
    summary.push(
      `rehydrate_final_mode=${rehydrated.final_mode ?? ''} rehydrate_restored_count=${rehydrated.restored_count} restored_len=${rehydrated.output_text.length} restored_equals_original=${rehydrateExact}`,
    );

    process.stdout.write('FRONTEND E2E PASS\n');
    for (const line of summary) {
      process.stdout.write(`${line}\n`);
    }
  } catch (error) {
    process.stdout.write('FRONTEND E2E FAIL\n');
    for (const line of summary) {
      process.stdout.write(`${line}\n`);
    }
    process.stderr.write(String((error as Error).stack ?? error) + '\n');
    process.stderr.write(frontend.output());
    process.exitCode = 1;
  } finally {
    await frontend.stop();
  }
}

main().catch((error) => {
  process.stdout.write('FRONTEND E2E FAIL\n');
  process.stderr.write(String((error as Error).stack ?? error) + '\n');
  process.exit(1);
});
