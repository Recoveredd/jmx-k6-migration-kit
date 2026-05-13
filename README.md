# jmx-k6-migration-kit

Audit JMeter `.jmx` files and generate safe k6 migration scaffolds with explicit diagnostics.

This package is intentionally not a magic "convert everything" tool. It is a migration assistant for teams that need to understand what is inside a JMeter plan, convert straightforward HTTP samplers, and clearly identify the parts that need manual k6 work.

## Demo

[Try the interactive demo](https://packages.wasta-wocket.fr/jmx-k6-migration-kit/)

```ts
import { migrateJmxToK6 } from "jmx-k6-migration-kit";

const result = migrateJmxToK6(jmxXml, {
  sourceName: "checkout-load-test.jmx",
  baseUrl: "https://api.example.com"
});

result.analysis.summary;
// {
//   totalComponents: 14,
//   supportedComponents: 6,
//   partialComponents: 3,
//   unsupportedComponents: 1,
//   disabledComponents: 0,
//   httpRequests: 4,
//   convertibleHttpRequests: 4
// }

result.k6.script;
// k6 scaffold with imports, options, groups, http calls, headers and checks
```

## Install

```bash
npm install jmx-k6-migration-kit
```

## CLI

```bash
npx jmx-k6-migrate ./load-test.jmx \
  --out ./load-test.k6.js \
  --report ./migration-report.md \
  --report-format markdown \
  --base-url https://api.example.com
```

Options:

- `--out <file>` writes the generated k6 scaffold.
- `--report <file>` writes the full migration report.
- `--report-format json|markdown` selects report output. Defaults to `json`.
- `--base-url <url>` provides a fallback when HTTP samplers only contain paths.
- `--strict` exits with code `1` when warnings are present.

Warnings are printed with the component name and JMeter tree path. The generated script also includes a `Migration warnings` comment block and request-level TODO comments so unsupported or partially converted pieces are visible before the script is run.

## API

### `analyzeJmx(input, options?)`

Parses a JMX XML string and returns a structured migration audit.

```ts
const analysis = analyzeJmx(jmxXml, {
  sourceName: "plan.jmx"
});
```

The result includes:

- `summary`: counts for supported, partial, unsupported and disabled components
- `findings`: diagnostics with `info`, `warning` or `error` severity
- `components`: every detected JMeter component with its support level
- `threadProfiles`: detected thread group settings
- `httpRequests`: HTTP samplers that can be turned into k6 calls

### `generateK6Script(analysis, options?)`

Generates a k6 JavaScript scaffold from a previous analysis.

```ts
const k6 = generateK6Script(analysis, {
  baseUrl: "https://api.example.com"
});

if (k6.ok) {
  console.log(k6.script);
}
```

### `migrateJmxToK6(input, options?)`

Convenience helper that runs both steps.

```ts
const { analysis, k6 } = migrateJmxToK6(jmxXml);
```

### `formatMigrationReport({ analysis, k6? })`

Creates a Markdown report meant for pull requests, migration tickets and handoff notes.

```ts
const report = formatMigrationReport({ analysis, k6 });
```

## Supported scope

The goal is reliable partial migration, not full JMeter emulation.

| JMeter element | Support | Notes |
| --- | --- | --- |
| `HTTPSamplerProxy`, `HTTPSampler` | Supported | Generates `http.get/post/put/patch/delete` calls with URL, query params, body and scoped headers. |
| `HTTP Request Defaults` / `ConfigTestElement` | Supported | Applies default protocol, domain, port, path and method within the current JMeter tree scope. |
| `HeaderManager` | Supported | Headers are applied through JMeter tree scope where possible. |
| `Arguments` | Supported | `GET`/`DELETE` parameters become URL query params; `POST`/`PUT`/`PATCH` parameters become form bodies unless JMeter raw body mode is used. |
| User Defined Variables | Supported | Simple `${name}` placeholders are replaced when the value is statically defined in an `Arguments` element in scope. Unresolved variables are reported. |
| `ResponseAssertion` | Partial | Converts simple response-code equality and body/header equals or substring assertions into k6 `check()` calls. Regex, NOT and OR assertions stay manual. |
| `ConstantTimer` | Partial | Converts fixed millisecond delays into `sleep(seconds)` before each sampler in scope. |
| `ThreadGroup` | Partial | `vus`, loops and ramp-up are converted into simple k6 options. Review complex schedules manually. |
| `CSVDataSet` | Partial | Detected and reported, but shared arrays and `open()` loading must be reviewed manually. |
| Other timers | Partial | Detected, but timing behavior should be reviewed manually. |
| Plugins and custom samplers | Unsupported | Reported as migration work items instead of being silently ignored. |

## Professional migration workflow

1. Run the audit and generate both outputs.
2. Review `migration-report.json` before trusting the generated k6 script.
3. Recreate unsupported assertions, extractors, processors, plugins and custom timers manually.
4. Run the generated script against a safe environment.
5. Compare request counts, status codes and business checks with the original JMeter run.

This conservative workflow is deliberate. A partially generated script with accurate warnings is safer than a script that looks complete but changes test semantics.

## Browser compatibility

The core parser and generator do not use Node-only APIs. They can run in browsers, workers, local web tools and build scripts. The CLI is the only Node-specific entry point.

## Error handling

The API does not throw for normal migration problems. Invalid XML, missing JMeter roots and missing convertible requests are returned as structured diagnostics:

```ts
const analysis = analyzeJmx(input);

if (!analysis.ok) {
  console.log(analysis.findings);
}
```

## License

MPL-2.0
