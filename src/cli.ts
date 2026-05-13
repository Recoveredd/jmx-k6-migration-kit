#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { analyzeJmx, generateK6Script, type JmxFinding } from './index.js';

interface CliOptions {
  input?: string;
  out?: string;
  report?: string;
  baseUrl?: string;
  strict: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.input) {
    printHelp();
    process.exit(1);
  }

  const input = await readFile(options.input, 'utf8');
  const analysis = analyzeJmx(input, { sourceName: basename(options.input) });
  const k6 = generateK6Script(analysis, { baseUrl: options.baseUrl });
  const report = {
    analysis,
    generated: {
      ok: k6.ok,
      findings: k6.findings
    }
  };

  if (options.out && k6.script) {
    await writeFile(options.out, k6.script);
  }

  if (options.report) {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }

  printSummary(analysis.findings, k6.findings);

  const hasErrors = !analysis.ok || !k6.ok;
  const hasWarnings = [...analysis.findings, ...k6.findings].some((finding) => finding.severity === 'warning');

  if (hasErrors || (options.strict && hasWarnings)) {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { strict: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--out') {
      options.out = requireValue(args, (index += 1), '--out');
    } else if (arg === '--report') {
      options.report = requireValue(args, (index += 1), '--report');
    } else if (arg === '--base-url') {
      options.baseUrl = requireValue(args, (index += 1), '--base-url');
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function printSummary(analysisFindings: JmxFinding[], generationFindings: JmxFinding[]): void {
  const findingsByCode = new Map<string, JmxFinding>();

  for (const finding of [...analysisFindings, ...generationFindings]) {
    findingsByCode.set(`${finding.code}:${finding.path ?? ''}:${finding.component ?? ''}`, finding);
  }

  const findings = [...findingsByCode.values()];
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const info = findings.filter((finding) => finding.severity === 'info').length;

  console.log(`JMX migration audit: ${errors} error(s), ${warnings} warning(s), ${info} info item(s)`);

  for (const finding of findings) {
    const context = [finding.component, finding.path].filter(Boolean).join(' at ');
    const suffix = context ? ` (${context})` : '';
    console.log(`${finding.severity.toUpperCase()} ${finding.code}${suffix}: ${finding.message}`);
  }
}

function printHelp(): void {
  console.log(`jmx-k6-migrate <plan.jmx> [options]

Options:
  --out <file>        Write the generated k6 scaffold.
  --report <file>     Write a JSON migration report.
  --base-url <url>    Fallback BASE_URL when samplers only contain paths.
  --strict            Exit with code 1 when warnings are present.
  -h, --help          Show this help.
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
