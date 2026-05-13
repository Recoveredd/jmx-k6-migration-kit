import { XMLParser, XMLValidator } from 'fast-xml-parser';

type XmlNode = Record<string, unknown>;

const ATTRIBUTES_KEY = ':@';
const TEXT_KEY = '#text';

export type SupportLevel = 'supported' | 'partial' | 'unsupported' | 'informational';
export type FindingSeverity = 'info' | 'warning' | 'error';

export interface JmxFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  component?: string;
  path?: string;
}

export interface JmxComponent {
  type: string;
  name: string;
  enabled: boolean;
  support: SupportLevel;
  path: string;
}

export interface ThreadProfile {
  name: string;
  vus: number;
  loops: number | 'forever';
  rampUpSeconds: number;
}

export interface HttpRequestPlan {
  name: string;
  method: string;
  protocol?: string;
  domain?: string;
  port?: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
  delayMs: number;
  checks: K6CheckPlan[];
  migrationNotes: string[];
  enabled: boolean;
  sourcePath: string;
}

export interface K6CheckPlan {
  label: string;
  expression: string;
  sourcePath: string;
}

export interface JmxAnalysisSummary {
  totalComponents: number;
  supportedComponents: number;
  partialComponents: number;
  unsupportedComponents: number;
  disabledComponents: number;
  httpRequests: number;
  convertibleHttpRequests: number;
}

export interface JmxAnalysisResult {
  ok: boolean;
  sourceName: string;
  summary: JmxAnalysisSummary;
  findings: JmxFinding[];
  components: JmxComponent[];
  threadProfiles: ThreadProfile[];
  httpRequests: HttpRequestPlan[];
}

export interface JmxAnalysisOptions {
  sourceName?: string;
}

export interface K6GenerationOptions {
  baseUrl?: string;
  includeUnsupportedSummary?: boolean;
}

export interface K6GenerationResult {
  ok: boolean;
  script: string;
  findings: JmxFinding[];
}

export interface MigrationResult {
  analysis: JmxAnalysisResult;
  k6: K6GenerationResult;
}

interface ScopedConfig {
  headers: Record<string, string>;
  variables: Record<string, string>;
  csvDataSets: string[];
  httpDefaults: HttpDefaults;
  constantDelayMs: number;
  assertions: ResponseAssertionPlan[];
  migrationNotes: string[];
}

interface ElementPair {
  element: XmlNode;
  subtree?: XmlNode;
}

interface HttpDefaults {
  protocol?: string;
  domain?: string;
  port?: string;
  path?: string;
  method?: string;
}

interface ResponseAssertionPlan {
  name: string;
  field: string;
  rule: AssertionRule;
  patterns: string[];
  supported: boolean;
  sourcePath: string;
  note?: string;
}

type AssertionRule = 'contains' | 'matches' | 'equals' | 'substring' | 'unsupported';

const SUPPORTED_TAGS = new Set([
  'jmeterTestPlan',
  'hashTree',
  'TestPlan',
  'ConfigTestElement',
  'ThreadGroup',
  'LoopController',
  'HTTPSamplerProxy',
  'HTTPSampler',
  'HeaderManager',
  'Arguments',
  'CSVDataSet',
  'CookieManager',
  'CacheManager',
  'ConstantTimer',
  'UniformRandomTimer',
  'ResponseAssertion'
]);

const HTTP_METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JMX_FORM_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function analyzeJmx(input: string, options: JmxAnalysisOptions = {}): JmxAnalysisResult {
  const sourceName = options.sourceName ?? 'jmeter-plan.jmx';
  const findings: JmxFinding[] = [];
  const components: JmxComponent[] = [];
  const threadProfiles: ThreadProfile[] = [];
  const httpRequests: HttpRequestPlan[] = [];

  let document: unknown;

  try {
    const validation = XMLValidator.validate(input);

    if (validation !== true) {
      throw new Error(validation.err.msg);
    }

    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: TEXT_KEY,
      trimValues: true,
      parseTagValue: false,
      parseAttributeValue: false,
      allowBooleanAttributes: true
    });
    document = parser.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown XML parser error';
    findings.push({
      code: 'invalid-xml',
      severity: 'error',
      message: `Unable to parse JMX XML: ${message}`
    });
    return emptyAnalysis(sourceName, findings);
  }

  const documentNodes = asNodeArray(document);
  const root = findFirstNode(documentNodes, 'jmeterTestPlan');

  if (!root) {
    findings.push({
      code: 'missing-jmeter-root',
      severity: 'error',
      message: 'Expected a jmeterTestPlan root element.'
    });
    return emptyAnalysis(sourceName, findings);
  }

  const rootHashTree = getChildren(root).find((child) => getTagName(child) === 'hashTree');

  if (!rootHashTree) {
    findings.push({
      code: 'missing-root-hashtree',
      severity: 'error',
      message: 'Expected the JMeter root to contain a hashTree.'
    });
    return emptyAnalysis(sourceName, findings);
  }

  walkHashTree(getChildren(rootHashTree), {
    path: 'jmeterTestPlan/hashTree',
    inheritedConfig: emptyConfig(),
    findings,
    components,
    threadProfiles,
    httpRequests
  });

  for (const component of components) {
    if (!SUPPORTED_TAGS.has(component.type)) {
      findings.push({
        code: 'unsupported-component',
        severity: 'warning',
        component: component.name,
        path: component.path,
        message: `${component.type} is not converted. It is included in the audit so migration work can be planned.`
      });
    }
  }

  for (const request of httpRequests) {
    if (!request.domain && !request.path.startsWith('http://') && !request.path.startsWith('https://')) {
      findings.push({
        code: 'request-needs-base-url',
        severity: 'info',
        component: request.name,
        path: request.sourcePath,
        message: 'HTTP sampler has no domain. The generated k6 script will use BASE_URL for this request.'
      });
    }

    if (requestHasUnresolvedVariables(request)) {
      findings.push({
        code: 'unresolved-variable',
        severity: 'warning',
        component: request.name,
        path: request.sourcePath,
        message: 'HTTP sampler still contains JMeter variables. Only statically defined variables are replaced automatically.'
      });
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    sourceName,
    summary: summarize(components, httpRequests),
    findings,
    components,
    threadProfiles,
    httpRequests
  };
}

export function generateK6Script(
  analysis: JmxAnalysisResult,
  options: K6GenerationOptions = {}
): K6GenerationResult {
  const findings: JmxFinding[] = [...analysis.findings];
  const enabledRequests = analysis.httpRequests.filter((request) => request.enabled);

  if (enabledRequests.length === 0) {
    findings.push({
      code: 'no-enabled-http-requests',
      severity: 'error',
      message: 'No enabled HTTP sampler could be converted to a k6 request.'
    });
    return { ok: false, script: '', findings };
  }

  const baseUrl = options.baseUrl ?? inferBaseUrl(enabledRequests) ?? 'https://example.test';
  const threadProfile = analysis.threadProfiles[0];
  const optionsBlock = formatK6Options(threadProfile);
  const unsupportedSummary = analysis.components
    .filter((component) => component.enabled && component.support === 'unsupported')
    .map((component) => `// - ${component.type}: ${component.name} (${component.path})`);

  const lines: string[] = [
    "import http from 'k6/http';",
    "import { check, group, sleep } from 'k6';",
    '',
    `export const options = ${optionsBlock};`,
    '',
    `const BASE_URL = __ENV.BASE_URL || ${quoteJs(baseUrl)};`
  ];

  if (options.includeUnsupportedSummary !== false && unsupportedSummary.length > 0) {
    lines.push('', '// JMeter elements requiring manual migration:', ...unsupportedSummary);
  }

  lines.push('', 'export default function () {');

  for (const request of enabledRequests) {
    const url = buildK6UrlExpression(request);
    const params = buildK6Params(request.headers);
    const requestLines = request.migrationNotes.map((note) => `  // ${note}`);

    if (request.delayMs > 0) {
      requestLines.push(`  sleep(${formatSeconds(request.delayMs)});`);
    }

    requestLines.push(`  const url = ${url};`);

    const body = request.body;
    const hasBody = HTTP_METHODS_WITH_BODY.has(request.method) && body !== undefined;

    if (hasBody) {
      requestLines.push(`  const body = ${quoteJs(body)};`);
    }

    requestLines.push(`  const response = ${formatK6HttpCall(request.method, hasBody, params)};`);
    requestLines.push(formatK6Checks(request.checks));

    lines.push(`  group(${quoteJs(request.name)}, () => {`, ...requestLines, '  });');
  }

  lines.push('}');

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    script: `${lines.join('\n')}\n`,
    findings
  };
}

export function migrateJmxToK6(
  input: string,
  options: JmxAnalysisOptions & K6GenerationOptions = {}
): MigrationResult {
  const analysis = analyzeJmx(input, options);
  return {
    analysis,
    k6: generateK6Script(analysis, options)
  };
}

function walkHashTree(
  children: XmlNode[],
  context: {
    path: string;
    inheritedConfig: ScopedConfig;
    findings: JmxFinding[];
    components: JmxComponent[];
    threadProfiles: ThreadProfile[];
    httpRequests: HttpRequestPlan[];
  }
): void {
  const pairs = pairHashTreeChildren(children);
  const localConfig = collectScopedConfig(pairs);
  const scopedConfig = mergeConfig(context.inheritedConfig, localConfig);

  for (const pair of pairs) {
    const type = getTagName(pair.element);

    if (!type) {
      continue;
    }

    const name = getAttribute(pair.element, '@_testname') ?? type;
    const enabled = getAttribute(pair.element, '@_enabled') !== 'false';
    const path = `${context.path}/${type}[${name}]`;
    const support = classifySupport(type);

    context.components.push({ type, name, enabled, support, path });

    if (!enabled) {
      context.findings.push({
        code: 'disabled-component',
        severity: 'info',
        component: name,
        path,
        message: `${type} is disabled in the JMX plan and will not be converted.`
      });
    }

    if (type === 'ThreadGroup') {
      context.threadProfiles.push(extractThreadProfile(pair.element, name));
    }

    if (isHttpSampler(type)) {
      const childConfig = pair.subtree ? collectScopedConfig(pairHashTreeChildren(getChildren(pair.subtree))) : emptyConfig();
      context.httpRequests.push(extractHttpRequest(pair.element, {
        config: mergeConfig(scopedConfig, childConfig),
        enabled,
        name,
        path
      }));
    }

    if (type === 'CSVDataSet') {
      context.findings.push({
        code: 'csv-dataset-partial',
        severity: 'warning',
        component: name,
        path,
        message: 'CSV data sets are detected, but k6 shared arrays and open() calls must be reviewed manually.'
      });
    }

    if (type.endsWith('Timer') && type !== 'ConstantTimer') {
      context.findings.push({
        code: 'timer-partial',
        severity: 'warning',
        component: name,
        path,
        message: `${type} is detected but not converted. Only ConstantTimer has guaranteed conversion.`
      });
    }

    if (type === 'ResponseAssertion') {
      const assertion = extractResponseAssertion(pair.element, path);
      if (!assertion.supported) {
        context.findings.push({
          code: 'assertion-partial',
          severity: 'warning',
          component: name,
          path,
          message: 'Response assertion is outside the guaranteed conversion scope. Recreate it manually with k6 check().'
        });
      }
    }

    if (pair.subtree) {
      walkHashTree(getChildren(pair.subtree), {
        ...context,
        path,
        inheritedConfig: scopedConfig
      });
    }
  }
}

function extractHttpRequest(
  element: XmlNode,
  context: { config: ScopedConfig; enabled: boolean; name: string; path: string }
): HttpRequestPlan {
  const args = extractArguments(element);
  const method = replaceKnownVariables(
    getTextProp(element, 'HTTPSampler.method') || context.config.httpDefaults.method || 'GET',
    context.config.variables
  ).toUpperCase();
  const headers = replaceRecordVariables(context.config.headers, context.config.variables);
  const shouldSendArgumentsAsBody = args.mode === 'query' && JMX_FORM_BODY_METHODS.has(method) && Object.keys(args.values).length > 0;
  const query = args.mode === 'query' && !shouldSendArgumentsAsBody
    ? replaceRecordVariables(args.values, context.config.variables)
    : {};
  const body = args.mode === 'body'
    ? replaceKnownVariables(args.body ?? '', context.config.variables)
    : shouldSendArgumentsAsBody
      ? new URLSearchParams(replaceRecordVariables(args.values, context.config.variables)).toString()
      : undefined;

  if (shouldSendArgumentsAsBody && !hasHeader(headers, 'Content-Type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  return {
    name: context.name,
    method,
    protocol: resolveRequestValue(getTextProp(element, 'HTTPSampler.protocol'), context.config.httpDefaults.protocol, context.config.variables),
    domain: resolveRequestValue(getTextProp(element, 'HTTPSampler.domain'), context.config.httpDefaults.domain, context.config.variables),
    port: resolveRequestValue(getTextProp(element, 'HTTPSampler.port'), context.config.httpDefaults.port, context.config.variables),
    path: normalizePath(resolveRequestValue(getTextProp(element, 'HTTPSampler.path'), context.config.httpDefaults.path, context.config.variables) ?? '/'),
    query,
    headers,
    body,
    delayMs: context.config.constantDelayMs,
    checks: context.config.assertions.flatMap(assertionToK6Checks),
    migrationNotes: context.config.migrationNotes,
    enabled: context.enabled,
    sourcePath: context.path
  };
}

function extractThreadProfile(element: XmlNode, fallbackName: string): ThreadProfile {
  const loopsText = getNestedTextProp(element, ['LoopController.loops']) ?? getTextProp(element, 'LoopController.loops');
  const loops = loopsText === '-1' ? 'forever' : parsePositiveInteger(loopsText, 1);

  return {
    name: fallbackName,
    vus: parsePositiveInteger(getTextProp(element, 'ThreadGroup.num_threads'), 1),
    loops,
    rampUpSeconds: parsePositiveInteger(getTextProp(element, 'ThreadGroup.ramp_time'), 0)
  };
}

function collectScopedConfig(pairs: ElementPair[]): ScopedConfig {
  const config = emptyConfig();

  for (const pair of pairs) {
    const type = getTagName(pair.element);

    if (type === 'Arguments') {
      Object.assign(config.variables, extractArguments(pair.element).values);
    }
  }

  for (const pair of pairs) {
    const type = getTagName(pair.element);

    if (type === 'HeaderManager') {
      Object.assign(config.headers, extractHeaders(pair.element));
    }

    if (type === 'ConfigTestElement') {
      config.httpDefaults = mergeHttpDefaults(config.httpDefaults, extractHttpDefaults(pair.element, config.variables));
    }

    if (type === 'CSVDataSet') {
      const filename = optionalString(getTextProp(pair.element, 'filename'));
      if (filename) {
        config.csvDataSets.push(filename);
        config.migrationNotes.push(`TODO: migrate CSV data set ${filename} with k6 open() or SharedArray.`);
      }
    }

    if (type === 'ConstantTimer') {
      config.constantDelayMs += extractConstantTimerDelay(pair.element);
    }

    if (type === 'ResponseAssertion') {
      const assertion = extractResponseAssertion(pair.element, getAttribute(pair.element, '@_testname') ?? 'Response Assertion');
      config.assertions.push(assertion);
      if (!assertion.supported && assertion.note) {
        config.migrationNotes.push(assertion.note);
      }
    }
  }

  return config;
}

function extractHeaders(element: XmlNode): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const headerElement of findElementProps(element, 'Header')) {
    const name = getTextProp(headerElement, 'Header.name');
    const value = getTextProp(headerElement, 'Header.value');
    if (name) {
      headers[name] = value ?? '';
    }
  }

  return headers;
}

function extractHttpDefaults(element: XmlNode, variables: Record<string, string>): HttpDefaults {
  return compactHttpDefaults({
    protocol: optionalString(replaceKnownVariables(getTextProp(element, 'HTTPSampler.protocol') ?? '', variables)),
    domain: optionalString(replaceKnownVariables(getTextProp(element, 'HTTPSampler.domain') ?? '', variables)),
    port: optionalString(replaceKnownVariables(getTextProp(element, 'HTTPSampler.port') ?? '', variables)),
    path: optionalString(replaceKnownVariables(getTextProp(element, 'HTTPSampler.path') ?? '', variables)),
    method: optionalString(replaceKnownVariables(getTextProp(element, 'HTTPSampler.method') ?? '', variables))?.toUpperCase()
  });
}

function extractConstantTimerDelay(element: XmlNode): number {
  return parsePositiveInteger(getTextProp(element, 'ConstantTimer.delay'), 0);
}

function extractResponseAssertion(element: XmlNode, sourcePath: string): ResponseAssertionPlan {
  const name = getAttribute(element, '@_testname') ?? 'Response Assertion';
  const field = getTextProp(element, 'Assertion.test_field') ?? 'Assertion.response_data';
  const rule = parseAssertionRule(getTextProp(element, 'Assertion.test_type'));
  const patterns = getAssertionPatterns(element);
  const supported = isSupportedAssertion(field, rule, patterns);

  return {
    name,
    field,
    rule,
    patterns,
    supported,
    sourcePath,
    note: supported
      ? undefined
      : `TODO: manually migrate response assertion "${name}" (${field}, ${rule}).`
  };
}

function parseAssertionRule(value: string | undefined): AssertionRule {
  const type = parsePositiveInteger(value, 0);

  if ((type & 4) === 4 || (type & 32) === 32) {
    return 'unsupported';
  }

  if ((type & 8) === 8) {
    return 'equals';
  }

  if ((type & 16) === 16) {
    return 'substring';
  }

  if ((type & 2) === 2) {
    return 'contains';
  }

  if ((type & 1) === 1) {
    return 'matches';
  }

  return 'unsupported';
}

function getAssertionPatterns(element: XmlNode): string[] {
  const patterns: string[] = [];

  function visit(node: XmlNode): void {
    const tag = getTagName(node);
    if (tag === 'stringProp') {
      const name = getAttribute(node, '@_name');
      if (name !== undefined && name !== 'Assertion.test_field') {
        const value = getText(node);
        if (value !== undefined) {
          patterns.push(value);
        }
      }
    }

    for (const child of getChildren(node)) {
      visit(child);
    }
  }

  for (const child of getChildren(element)) {
    const propName = getAttribute(child, '@_name');
    if (getTagName(child) === 'collectionProp' && (propName === 'Asserion.test_strings' || propName === 'Assertion.test_strings')) {
      visit(child);
    }
  }

  return patterns;
}

function isSupportedAssertion(field: string, rule: AssertionRule, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  if (field === 'Assertion.response_code') {
    return rule === 'equals' && patterns.every((pattern) => /^\d{3}$/.test(pattern));
  }

  if (field === 'Assertion.response_data' || field === 'Assertion.response_headers') {
    return rule === 'equals' || rule === 'substring';
  }

  return false;
}

function extractArguments(element: XmlNode): { mode: 'query' | 'body'; values: Record<string, string>; body?: string } {
  const values: Record<string, string> = {};
  const rawBody = getTextProp(element, 'Argument.value') ?? getTextProp(element, 'HTTPSampler.body');
  const postBodyRaw = getTextProp(element, 'HTTPSampler.postBodyRaw') === 'true';

  for (const argument of [...findElementProps(element, 'HTTPArgument'), ...findElementProps(element, 'Argument')]) {
    const name = getTextProp(argument, 'Argument.name') ?? '';
    const value = getTextProp(argument, 'Argument.value') ?? '';

    if (postBodyRaw && !name) {
      return { mode: 'body', values: {}, body: value };
    }

    if (name) {
      values[name] = value;
    }
  }

  if (postBodyRaw && rawBody !== undefined) {
    return { mode: 'body', values: {}, body: rawBody };
  }

  return { mode: 'query', values };
}

function findElementProps(element: XmlNode, elementType: string): XmlNode[] {
  const found: XmlNode[] = [];

  function visit(node: XmlNode): void {
    if (getTagName(node) === 'elementProp' && getAttribute(node, '@_elementType') === elementType) {
      found.push(node);
    }

    for (const child of getChildren(node)) {
      visit(child);
    }
  }

  visit(element);
  return found;
}

function pairHashTreeChildren(children: XmlNode[]): ElementPair[] {
  const pairs: ElementPair[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const element = children[index];
    const type = getTagName(element);

    if (!type || type === 'hashTree') {
      continue;
    }

    const next = children[index + 1];
    const subtree = next && getTagName(next) === 'hashTree' ? next : undefined;
    pairs.push({ element, subtree });
  }

  return pairs;
}

function getTextProp(element: XmlNode, propName: string): string | undefined {
  for (const child of getChildren(element)) {
    const tag = getTagName(child);
    if ((tag === 'stringProp' || tag === 'boolProp' || tag === 'intProp' || tag === 'longProp') && getAttribute(child, '@_name') === propName) {
      return getText(child);
    }
  }

  return undefined;
}

function getNestedTextProp(element: XmlNode, propNames: string[]): string | undefined {
  for (const child of getChildren(element)) {
    const value = getTextProp(child, propNames[0]);
    if (value !== undefined) {
      return value;
    }

    const nested = getNestedTextProp(child, propNames);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function findFirstNode(nodes: XmlNode[], tagName: string): XmlNode | undefined {
  for (const node of nodes) {
    if (getTagName(node) === tagName) {
      return node;
    }

    const nested = findFirstNode(getChildren(node), tagName);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function getTagName(node: XmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ATTRIBUTES_KEY && key !== TEXT_KEY);
}

function getChildren(node: XmlNode): XmlNode[] {
  const tagName = getTagName(node);
  if (!tagName) {
    return [];
  }

  return asNodeArray(node[tagName]);
}

function getText(node: XmlNode): string | undefined {
  for (const child of getChildren(node)) {
    if (TEXT_KEY in child) {
      const value = child[TEXT_KEY];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : undefined;
    }
  }

  if (TEXT_KEY in node) {
    const value = node[TEXT_KEY];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;
  }

  return '';
}

function getAttribute(node: XmlNode, name: string): string | undefined {
  const attributes = node[ATTRIBUTES_KEY];
  if (!isRecord(attributes)) {
    return undefined;
  }

  const value = attributes[name];
  return value === undefined ? undefined : String(value);
}

function asNodeArray(value: unknown): XmlNode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function isRecord(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifySupport(type: string): SupportLevel {
  if (
    type === 'HTTPSamplerProxy'
    || type === 'HTTPSampler'
    || type === 'HeaderManager'
    || type === 'Arguments'
    || type === 'ConfigTestElement'
  ) {
    return 'supported';
  }

  if (type === 'ThreadGroup' || type === 'CSVDataSet' || type === 'ResponseAssertion' || type.endsWith('Timer')) {
    return 'partial';
  }

  if (type === 'TestPlan' || type === 'LoopController' || type === 'CookieManager' || type === 'CacheManager') {
    return 'informational';
  }

  return 'unsupported';
}

function isHttpSampler(type: string): boolean {
  return type === 'HTTPSamplerProxy' || type === 'HTTPSampler';
}

function emptyConfig(): ScopedConfig {
  return {
    headers: {},
    variables: {},
    csvDataSets: [],
    httpDefaults: {},
    constantDelayMs: 0,
    assertions: [],
    migrationNotes: []
  };
}

function mergeConfig(base: ScopedConfig, next: ScopedConfig): ScopedConfig {
  return {
    headers: { ...base.headers, ...next.headers },
    variables: { ...base.variables, ...next.variables },
    csvDataSets: [...base.csvDataSets, ...next.csvDataSets],
    httpDefaults: mergeHttpDefaults(base.httpDefaults, next.httpDefaults),
    constantDelayMs: base.constantDelayMs + next.constantDelayMs,
    assertions: [...base.assertions, ...next.assertions],
    migrationNotes: [...base.migrationNotes, ...next.migrationNotes]
  };
}

function mergeHttpDefaults(base: HttpDefaults, next: HttpDefaults): HttpDefaults {
  return compactHttpDefaults({ ...base, ...next });
}

function compactHttpDefaults(defaults: HttpDefaults): HttpDefaults {
  return Object.fromEntries(
    Object.entries(defaults).filter(([, value]) => value !== undefined && value !== '')
  ) as HttpDefaults;
}

function summarize(components: JmxComponent[], httpRequests: HttpRequestPlan[]): JmxAnalysisSummary {
  return {
    totalComponents: components.length,
    supportedComponents: components.filter((component) => component.support === 'supported').length,
    partialComponents: components.filter((component) => component.support === 'partial').length,
    unsupportedComponents: components.filter((component) => component.support === 'unsupported').length,
    disabledComponents: components.filter((component) => !component.enabled).length,
    httpRequests: httpRequests.length,
    convertibleHttpRequests: httpRequests.filter((request) => request.enabled).length
  };
}

function emptyAnalysis(sourceName: string, findings: JmxFinding[]): JmxAnalysisResult {
  return {
    ok: false,
    sourceName,
    summary: summarize([], []),
    findings,
    components: [],
    threadProfiles: [],
    httpRequests: []
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRequestValue(
  explicitValue: string | undefined,
  defaultValue: string | undefined,
  variables: Record<string, string>
): string | undefined {
  const value = optionalString(explicitValue) ?? defaultValue;
  return value === undefined ? undefined : replaceKnownVariables(value, variables);
}

function replaceRecordVariables(
  values: Record<string, string>,
  variables: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      replaceKnownVariables(key, variables),
      replaceKnownVariables(value, variables)
    ])
  );
}

function replaceKnownVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][\w.-]*)\}/g, (match, name: string) => variables[name] ?? match);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name.toLowerCase());
}

function requestHasUnresolvedVariables(request: HttpRequestPlan): boolean {
  const values = [
    request.protocol,
    request.domain,
    request.port,
    request.path,
    request.body,
    ...Object.keys(request.query),
    ...Object.values(request.query),
    ...Object.keys(request.headers),
    ...Object.values(request.headers)
  ];

  return values.some((value) => value !== undefined && /\$\{[^}]+\}/.test(value));
}

function normalizePath(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
    return value;
  }

  return `/${value}`;
}

function inferBaseUrl(requests: HttpRequestPlan[]): string | undefined {
  const firstWithDomain = requests.find((request) => request.domain);
  if (!firstWithDomain?.domain) {
    return undefined;
  }

  const protocol = firstWithDomain.protocol || 'https';
  const port = firstWithDomain.port ? `:${firstWithDomain.port}` : '';
  return `${protocol}://${firstWithDomain.domain}${port}`;
}

function formatK6Options(profile: ThreadProfile | undefined): string {
  if (!profile) {
    return JSON.stringify({ vus: 1, duration: '1m' }, null, 2);
  }

  if (typeof profile.loops === 'number' && profile.loops > 0) {
    return JSON.stringify({ vus: profile.vus, iterations: profile.vus * profile.loops }, null, 2);
  }

  const duration = `${Math.max(profile.rampUpSeconds, 60)}s`;
  return JSON.stringify({ vus: profile.vus, duration }, null, 2);
}

function formatK6HttpCall(method: string, hasBody: boolean, params: string): string {
  switch (method) {
    case 'GET':
      return `http.get(url, ${params})`;
    case 'POST':
      return `http.post(url, ${hasBody ? 'body' : 'null'}, ${params})`;
    case 'PUT':
      return `http.put(url, ${hasBody ? 'body' : 'null'}, ${params})`;
    case 'PATCH':
      return `http.patch(url, ${hasBody ? 'body' : 'null'}, ${params})`;
    case 'DELETE':
      return `http.del(url, ${hasBody ? 'body' : 'null'}, ${params})`;
    case 'HEAD':
      return `http.head(url, ${params})`;
    default:
      return `http.request(${quoteJs(method)}, url, ${hasBody ? 'body' : 'null'}, ${params})`;
  }
}

function formatK6Checks(checks: K6CheckPlan[]): string {
  const effectiveChecks = checks.length > 0
    ? checks
    : [{ label: 'status is below 400', expression: 'result.status < 400', sourcePath: 'default' }];

  const lines = effectiveChecks.map((check) => `    ${quoteJs(check.label)}: (result) => ${check.expression}`);
  return `  check(response, {\n${lines.join(',\n')}\n  });`;
}

function assertionToK6Checks(assertion: ResponseAssertionPlan): K6CheckPlan[] {
  if (!assertion.supported) {
    return [];
  }

  return assertion.patterns.map((pattern) => ({
    label: `${assertion.name}: ${formatAssertionLabel(assertion.field, assertion.rule, pattern)}`,
    expression: formatAssertionExpression(assertion.field, assertion.rule, pattern),
    sourcePath: assertion.sourcePath
  }));
}

function formatAssertionLabel(field: string, rule: AssertionRule, pattern: string): string {
  if (field === 'Assertion.response_code') {
    return `status equals ${pattern}`;
  }

  if (field === 'Assertion.response_headers') {
    return `headers ${rule} ${pattern}`;
  }

  return `body ${rule} ${pattern}`;
}

function formatAssertionExpression(field: string, rule: AssertionRule, pattern: string): string {
  if (field === 'Assertion.response_code') {
    return `result.status === ${Number(pattern)}`;
  }

  if (field === 'Assertion.response_headers') {
    const target = 'JSON.stringify(result.headers || {})';
    return rule === 'equals'
      ? `${target} === ${quoteJs(pattern)}`
      : `${target}.includes(${quoteJs(pattern)})`;
  }

  const body = '(result.body || "")';
  return rule === 'equals'
    ? `${body} === ${quoteJs(pattern)}`
    : `${body}.includes(${quoteJs(pattern)})`;
}

function buildK6UrlExpression(request: HttpRequestPlan): string {
  const pathWithQuery = appendQuery(request.path, request.query);

  if (pathWithQuery.startsWith('http://') || pathWithQuery.startsWith('https://')) {
    return quoteJs(pathWithQuery);
  }

  if (request.domain) {
    const protocol = request.protocol || 'https';
    const port = request.port ? `:${request.port}` : '';
    return quoteJs(`${protocol}://${request.domain}${port}${pathWithQuery}`);
  }

  return `\`\${BASE_URL}${escapeTemplate(pathWithQuery)}\``;
}

function appendQuery(path: string, query: Record<string, string>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) {
    return path;
  }

  const params = new URLSearchParams(entries);
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${params.toString()}`;
}

function buildK6Params(headers: Record<string, string>): string {
  if (Object.keys(headers).length === 0) {
    return '{}';
  }

  return JSON.stringify({ headers }, null, 2).replace(/\n/g, '\n  ');
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function quoteJs(value: string): string {
  return JSON.stringify(value);
}

function escapeTemplate(value: string): string {
  return value.replace(/[`\\$]/g, (character) => `\\${character}`);
}
