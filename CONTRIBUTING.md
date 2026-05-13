# Contributing

Thanks for taking the time to improve this package.

## Local setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

Please keep changes focused and include tests for behavior changes. Small API improvements are welcome when they keep the package predictable, typed, and easy to use in both Node and browser-oriented tooling.

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

## Issues

When reporting a bug, include:

- the package version;
- the input that failed;
- the expected output;
- the actual output or diagnostic code.

Please avoid broad feature requests that would turn the package into a large framework. These utilities are intentionally small and focused.
