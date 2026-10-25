# Releasing Torrus

The release workflow follows the same build-first, publish-on-request flow as
Burrow. Every run executes the backend, frontend, bundle freshness, and package
checks, builds a wheel and source distribution, installs the wheel in a clean
environment, and saves both distribution files as a 30-day workflow artifact.

## Preview a release

Run the workflow with publishing turned off:

```sh
gh workflow run release.yml --repo anudeepd/torrus --ref main -f publish=false
```

It runs all checks and makes the tested distributions available as the
`torrus-dist` artifact, without publishing them.

## Publish a release

1. Ensure the package versions are synchronized in `pyproject.toml`,
   `src/torrus/__init__.py`, `uv.lock`, `frontend/package.json`, and the root
   package entry in `frontend/package-lock.json`.
2. Run the **release** workflow from `main` with publishing enabled and choose
   the `patch`, `minor`, or `major` bump:

   ```sh
   gh workflow run release.yml --repo anudeepd/torrus --ref main \
     -f publish=true -f bump=patch
   ```

The workflow calculates the next version, validates the unused `v<version>` tag,
updates all five version files, builds and smoke-tests the matching wheel and
source distribution, then commits the version change to `main`. It creates a
GitHub Release targeting that commit and publishes the tested distributions to
PyPI through OIDC. The Actions token must be allowed to push the version commit
to `main`; branch protection or repository rulesets can otherwise block the
release before publishing.

## PyPI Trusted Publishing setup

Configure a PyPI Trusted Publisher for project `torrus` with these values:

- Owner: `anudeepd`
- Repository: `torrus`
- Workflow filename: `release.yml`
- GitHub environment: `pypi`

No PyPI API token is stored in GitHub Actions. The publish job uses GitHub's
OIDC identity through PyPI Trusted Publishing. The repository's `pypi`
environment can also require an approval before the publish job starts.
