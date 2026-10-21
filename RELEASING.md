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

1. Update the Torrus version in `pyproject.toml`, `src/torrus/__init__.py`,
   `uv.lock`, `frontend/package.json`, and the root package entry in
   `frontend/package-lock.json`.
2. Commit the version and any release changes to `main`. The workflow checks that
   all five version values match and that the corresponding `v<version>` tag is
   unused.
3. Run the **release** workflow from `main` with publishing enabled:

   ```sh
   gh workflow run release.yml --repo anudeepd/torrus --ref main -f publish=true
   ```

The workflow creates a GitHub Release tagged `v<version>` and attaches the wheel
and source distribution. It also publishes those exact files to PyPI. Both
publishing jobs wait for the checks and distribution smoke test to pass.

## PyPI Trusted Publishing setup

Configure a PyPI Trusted Publisher for project `torrus` with these values:

- Owner: `anudeepd`
- Repository: `torrus`
- Workflow filename: `release.yml`
- GitHub environment: `pypi`

No PyPI API token is stored in GitHub Actions. The publish job uses GitHub's
OIDC identity through PyPI Trusted Publishing. The repository's `pypi`
environment can also require an approval before the publish job starts.
