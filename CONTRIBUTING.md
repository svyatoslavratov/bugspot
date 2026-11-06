# Contributing

Issues and pull requests are welcome.

- `make test` runs the Go tests with the race detector and the widget's typecheck, tests and
  formatting check; `make lint` runs golangci-lint.
- The API is described in `api/openapi.yaml`; a test fails when a route and the spec disagree.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`,
  `fix:`, `docs:`, `test:`, `chore:`, `ci:`.
- Report bugs and propose features with the issue templates; ask questions in
  [Discussions](https://github.com/svyatoslavratov/bugspot/discussions); report vulnerabilities
  privately (see [SECURITY.md](SECURITY.md)).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- By contributing you agree that your contribution is licensed under the AGPL-3.0, like the project.
