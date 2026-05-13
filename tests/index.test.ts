import { describe, expect, it } from 'vitest';
import { analyzeJmx, generateK6Script, migrateJmxToK6 } from '../src/index.js';

const sampleJmx = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="API migration" enabled="true">
      <stringProp name="TestPlan.comments"></stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Users" enabled="true">
        <stringProp name="ThreadGroup.num_threads">4</stringProp>
        <stringProp name="ThreadGroup.ramp_time">10</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
          <stringProp name="LoopController.loops">3</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="JSON headers" enabled="true">
          <collectionProp name="HeaderManager.headers">
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">Accept</stringProp>
              <stringProp name="Header.value">application/json</stringProp>
            </elementProp>
          </collectionProp>
        </HeaderManager>
        <hashTree/>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Search API" enabled="true">
          <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/v1/search</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="q" elementType="HTTPArgument">
                <stringProp name="Argument.name">q</stringProp>
                <stringProp name="Argument.value">latency budget</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree/>
        <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Status check" enabled="true"/>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

describe('analyzeJmx', () => {
  it('extracts thread profiles, scoped headers and HTTP samplers', () => {
    const analysis = analyzeJmx(sampleJmx, { sourceName: 'sample.jmx' });

    expect(analysis.ok).toBe(true);
    expect(analysis.threadProfiles).toEqual([
      { name: 'Users', vus: 4, loops: 3, rampUpSeconds: 10 }
    ]);
    expect(analysis.httpRequests).toHaveLength(1);
    expect(analysis.httpRequests[0]).toMatchObject({
      name: 'Search API',
      method: 'GET',
      domain: 'api.example.test',
      path: '/v1/search',
      headers: { Accept: 'application/json' },
      query: { q: 'latency budget' }
    });
    expect(analysis.findings.some((finding) => finding.code === 'assertion-partial')).toBe(true);
  });

  it('returns a structured error for invalid XML', () => {
    const analysis = analyzeJmx('<not-closed>');

    expect(analysis.ok).toBe(false);
    expect(analysis.findings[0]?.code).toBe('invalid-xml');
  });

  it('reports unsupported components without hiding supported requests', () => {
    const analysis = analyzeJmx(sampleJmx.replace('<ResponseAssertion', '<JSR223Sampler'));

    expect(analysis.ok).toBe(true);
    expect(analysis.summary.unsupportedComponents).toBe(1);
    expect(analysis.findings.some((finding) => finding.code === 'unsupported-component')).toBe(true);
    expect(analysis.httpRequests).toHaveLength(1);
  });

  it('returns a structured error when the XML is valid but not a JMeter plan', () => {
    const analysis = analyzeJmx('<project><name>not jmeter</name></project>');

    expect(analysis.ok).toBe(false);
    expect(analysis.findings[0]?.code).toBe('missing-jmeter-root');
  });

  it('detects CSV data sets as manual migration work', () => {
    const analysis = analyzeJmx(withThreadChildren(`
      <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="Users CSV" enabled="true">
        <stringProp name="filename">users.csv</stringProp>
        <stringProp name="variableNames">email,password</stringProp>
      </CSVDataSet>
      <hashTree/>
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Login" enabled="true">
        <stringProp name="HTTPSampler.domain">auth.example.test</stringProp>
        <stringProp name="HTTPSampler.path">/login</stringProp>
        <stringProp name="HTTPSampler.method">POST</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
    `));

    expect(analysis.ok).toBe(true);
    expect(analysis.summary.partialComponents).toBeGreaterThanOrEqual(2);
    expect(analysis.findings.some((finding) => finding.code === 'csv-dataset-partial')).toBe(true);
  });

  it('keeps disabled HTTP samplers in the audit but excludes them from conversion', () => {
    const analysis = analyzeJmx(withThreadChildren(`
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Old endpoint" enabled="false">
        <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
        <stringProp name="HTTPSampler.path">/old</stringProp>
        <stringProp name="HTTPSampler.method">GET</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Current endpoint" enabled="true">
        <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
        <stringProp name="HTTPSampler.path">/current</stringProp>
        <stringProp name="HTTPSampler.method">GET</stringProp>
      </HTTPSamplerProxy>
      <hashTree/>
    `));

    expect(analysis.summary.httpRequests).toBe(2);
    expect(analysis.summary.convertibleHttpRequests).toBe(1);
    expect(analysis.findings.some((finding) => finding.code === 'disabled-component')).toBe(true);
  });
});

describe('generateK6Script', () => {
  it('generates a readable k6 scaffold', () => {
    const result = migrateJmxToK6(sampleJmx);

    expect(result.k6.ok).toBe(true);
    expect(result.k6.script).toContain("import http from 'k6/http';");
    expect(result.k6.script).toContain('https://api.example.test/v1/search?q=latency+budget');
    expect(result.k6.script).toContain('"Accept": "application/json"');
    expect(result.k6.script).toContain('"iterations": 12');
  });

  it('uses BASE_URL when the sampler has only a path', () => {
    const analysis = analyzeJmx(sampleJmx.replace('<stringProp name="HTTPSampler.domain">api.example.test</stringProp>', ''));
    const result = generateK6Script(analysis, { baseUrl: 'https://api.internal.test' });

    expect(result.ok).toBe(true);
    expect(result.script).toContain('const BASE_URL = __ENV.BASE_URL || "https://api.internal.test";');
    expect(result.script).toContain('`${BASE_URL}/v1/search?q=latency+budget`');
  });

  it('uses k6 method names that differ from HTTP method names', () => {
    const analysis = analyzeJmx(sampleJmx.replace(
      '<stringProp name="HTTPSampler.method">GET</stringProp>',
      '<stringProp name="HTTPSampler.method">DELETE</stringProp>'
    ));
    const result = generateK6Script(analysis);

    expect(result.script).toContain('http.del(url, null,');
    expect(result.script).not.toContain('http.delete');
  });

  it('generates POST requests with raw bodies', () => {
    const analysis = analyzeJmx(withThreadChildren(`
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Create user" enabled="true">
        <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
        <stringProp name="HTTPSampler.path">/users</stringProp>
        <stringProp name="HTTPSampler.method">POST</stringProp>
        <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
        <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
          <collectionProp name="Arguments.arguments">
            <elementProp name="" elementType="HTTPArgument">
              <boolProp name="HTTPArgument.always_encode">false</boolProp>
              <stringProp name="Argument.value">{"name":"Ada"}</stringProp>
              <stringProp name="Argument.metadata">=</stringProp>
            </elementProp>
          </collectionProp>
        </elementProp>
      </HTTPSamplerProxy>
      <hashTree/>
    `));
    const result = generateK6Script(analysis);

    expect(result.ok).toBe(true);
    expect(result.script).toContain('const body = "{\\"name\\":\\"Ada\\"}";');
    expect(result.script).toContain('http.post(url, body,');
  });

  it('fails generation clearly when no enabled HTTP request exists', () => {
    const analysis = analyzeJmx(withThreadChildren(`
      <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="Think time" enabled="true">
        <stringProp name="ConstantTimer.delay">1000</stringProp>
      </ConstantTimer>
      <hashTree/>
    `));
    const result = generateK6Script(analysis);

    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'no-enabled-http-requests')).toBe(true);
  });
});

function withThreadChildren(children: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Fixture" enabled="true"/>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Users" enabled="true">
        <stringProp name="ThreadGroup.num_threads">2</stringProp>
        <stringProp name="ThreadGroup.ramp_time">5</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
          <stringProp name="LoopController.loops">1</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
        ${children}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}
