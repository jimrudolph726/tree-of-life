# Staging on S3 + CloudFront

No custom domain, backend or database is required. The CloudFront HTTPS hostname is the staging URL. The template uses standard pay-as-you-go resources; it does not enroll the account in a flat-rate/free plan. Confirm the applicable AWS pricing before creating resources. Budget alerts are **not spending caps** and can arrive after costs accrue.

## Architecture

- S3 blocks public access, uses SSE-S3 encryption and bucket versioning, and is retained on stack deletion.
- CloudFront signs S3 requests with Origin Access Control. Only GET/HEAD are allowed; HTTP redirects to HTTPS.
- `/data/<dataset>/<version>/...` and hashed `/assets/...` are shared immutable objects. Unchanged data is reused across app releases.
- HTML, attribution, the three tree manifest pointers and `/data/profiles/manifest.json` live under `/releases/<release-id>/` in S3. CloudFront's `AppOrigin.OriginPath` selects the active release. Content-addressed profile shards are shared immutable objects under `/data/profiles/<version>/`; HTML and manifest pointers disable caching. There is no HTML fallback for missing binary/JSON pages.
- Every file is gzip-compressed before upload, including binary geometry. Content-Type remains the original type and Content-Encoding is gzip. This avoids relying on CloudFront's automatic compression eligibility for `.bin` objects. Browsers transparently decode them.
- The uploader checks uploaded object ETags/sizes, writes a complete release inventory only after verification, then changes the app origin with an ETag concurrency precondition. It never deletes retained releases or overwrites changed immutable content.
- Hashed application assets are shared too, so an already-open older tab can still load its worker and lazy chunks after deployment.

CloudFront propagation is gradual across edge locations. A release contains a consistent app and three manifest pointers; shared immutable data remains accessible throughout propagation. This is not a globally instantaneous transaction. Run one deployment at a time; the GitHub workflow serializes staging runs.

## Local preparation

Use Node 24, Python 3.13 and AWS CLI v2. Do not put access keys in the repository or chat.

```sh
python -m pip install -r pipeline/requirements.txt -r pipeline/requirements-cloud.txt
npm ci
npm run data:life
npm run data:life:validate
npm run data:build
npm test
npm run data:test
npm run lint
npm run build
python pipeline/deploy_cloud.py preflight
```

The preflight is local and read-only. It selects only active dataset versions, app assets and explicitly allowed public files. Missing geometry pages, inconsistent manifests and unexpected dataset file types fail before uploading. Full source/routing validation remains a separate required build check.

To test delivery headers without AWS, run `python pipeline/preview_cloud.py`, then in another terminal:

```sh
node pipeline/cloud-smoke.ts http://127.0.0.1:4175 .deploy/local-smoke.json
```

This tests all three datasets, search, deep ancestry, desktop/narrow scene assembly, compression and cache headers. It is not a browser test or CloudFront emulator.

For a browser test that fetches the deployed files and then shapes downstream delivery to 1.6 Mbps with 150 ms added latency, run:

```sh
node pipeline/preview-network.mjs --port 4176 --upstream https://DISTRIBUTION.cloudfront.net
```

Open `http://127.0.0.1:4176/?bench=1&duration=30`. The proxy fetches CloudFront over HTTPS, recompresses the response and disables browser caching. This is a controlled delivery test on desktop hardware, not a physical phone or mobile-radio test.

## Create staging (one time)

Sign in using `aws login` or your organization's `aws sso login --profile PROFILE`, then verify `aws sts get-caller-identity`. Use the desired profile consistently, via AWS_PROFILE or each command's `--profile` option. The local configured profile must have permission to create the resources in the template.

Deploy the stack in **us-east-1** because the CloudFront CloudWatch alarm uses global metrics in that region. Substitute an actual alert email and chosen monthly USD threshold below:

```sh
aws cloudformation deploy --region us-east-1 --stack-name tree-of-life-staging --template-file infra/staging.yaml --capabilities CAPABILITY_IAM --parameter-overrides AlertEmail=YOUR_EMAIL MonthlyBudgetUSD=YOUR_THRESHOLD
aws cloudformation describe-stacks --region us-east-1 --stack-name tree-of-life-staging --query "Stacks[0].Outputs"
```

Save the returned BucketName, DistributionId and WebsiteUrl. The empty site returns 403 until the first release is published. No domain purchase or separate certificate is needed.

The budget is account-wide, so unrelated AWS spending contributes to its actual/forecast alerts. The stack creates an SNS email subscription for CloudFront 5xx and sampled browser-error alarms; confirm the separate subscription email before expecting alarm messages. Budget notifications go to the supplied email. Data/old releases are retained and continue to incur storage costs until explicitly cleaned up. Do not delete old files while clients might still use them.

## Deploy and verify

For an ordinary frontend change, build only the application and reuse the dataset
versions from the active release:

```sh
npm run build:app
python pipeline/deploy_cloud.py deploy-app --bucket BUCKET --distribution DISTRIBUTION
node pipeline/cloud-smoke.ts https://DISTRIBUTION.cloudfront.net .deploy/staging-smoke.json
```

`deploy-app` reads the three tree manifest pointers from the active release, verifies
that its release inventory contains those immutable dataset versions, and creates
a new rollback-ready release containing the new application, the compact profile
publication and the reused tree pointers. It does not download, rebuild or re-upload the tree.

When the OpenTree source, binary format, search index or layout geometry changes,
prepare and publish a complete dataset release:

```sh
python -m pip install -r pipeline/requirements.txt -r pipeline/requirements-cloud.txt
npm run data:life
npm run data:life:validate
npm run data:build
npm test
npm run data:test
npm run lint
npm run build
python pipeline/deploy_cloud.py preflight
python pipeline/deploy_cloud.py deploy --bucket BUCKET --distribution DISTRIBUTION
node pipeline/cloud-smoke.ts https://DISTRIBUTION.cloudfront.net .deploy/staging-smoke.json
python pipeline/deploy_cloud.py status --distribution DISTRIBUTION
```

The first upload includes the full dataset and can take several minutes. Subsequent deployments reuse matching objects. A failed upload does not change the active release. If promotion succeeds but smoke checks fail, use the printed previous-release ID to roll back. The initial `unpublished` placeholder is not a rollback target.

```sh
python pipeline/deploy_cloud.py activate --bucket BUCKET --distribution DISTRIBUTION --release PREVIOUS_RELEASE_ID
node pipeline/cloud-smoke.ts https://DISTRIBUTION.cloudfront.net .deploy/rollback-smoke.json
```

Activation re-verifies all objects in the retained release inventory, changes only the app origin, waits for CloudFront deployment and invalidates cached responses. **The release script owns AppOrigin.OriginPath**, which produces intentional CloudFormation drift. For later infrastructure updates, pass `ReleaseId=CURRENT_RELEASE_ID` from `status` to CloudFormation, alongside the existing parameters, so an infrastructure update cannot reset the site to `unpublished`.

## GitHub Actions

The workflows deliberately separate application delivery from scientific data publication:

- **Deploy app or roll back staging** runs automatically on pushes to `main`. It tests and builds the React application, reuses the active datasets, publishes the app release, and runs the hosted smoke check. Manual dispatch with an empty release retries the current revision; a retained release ID performs a rollback.
- **Publish complete OpenTree dataset** is manual. It downloads the pinned source, rebuilds and exhaustively validates the complete publication, publishes all immutable dataset objects, activates the matching application release, and runs the hosted smoke check. Use it after changing the OpenTree version, layout geometry, binary format or generated search/routing data.

Both deployment workflows share one concurrency group and use short-lived OIDC credentials rather than saved AWS access keys. Authentication is checked before expensive work begins. The ordinary app workflow remains independently safe to publish; it does not depend on the timing of the separate CI workflow.

`RUM_APP_MONITOR_ID` enables the lazily loaded CloudWatch RUM client only in hosted builds. It samples 5% of sessions, sets no cookies, records no session replay, and does not copy events to CloudWatch Logs. RUM retains its own events for 30 days. The public app-monitor policy can accept unsigned telemetry, so dashboard data should be treated as operational evidence rather than an authenticated audit log. The stack alarms after at least five sampled JavaScript errors in each of two consecutive five-minute periods.

The **Check production browsers** workflow runs daily and can also be dispatched manually. It checks the hosted full tree in Chromium, Firefox, WebKit, and a mobile Chromium viewport. Pull requests and pushes run the Chromium path against the local Aves fixture in a parallel CI job. Failure artifacts include Playwright traces and screenshots and expire after seven days.

1. Commit and push the reviewed project and workflows. The generated full tree stays ignored; CI recreates it from its pinned source.
2. Use/create the account's GitHub OIDC provider (`https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`). Supply its ARN as `GitHubOidcProviderArn` when updating the stack, preserving the current `ReleaseId`. Obtain `sub_claim_prefix` with `gh api repos/OWNER/REPO/actions/oidc/customization/sub` and supply that exact value as `GitHubOidcSubjectPrefix`. This repository uses immutable owner/repository IDs in the prefix; the older name-only subject does not match. The template appends `:environment:staging` and requires an exact match, with no wildcard. The template deliberately does not create another account-wide provider automatically.
3. Create GitHub environment **staging**. Restrict deployments to the intended branch and configure required reviewers if desired; the OIDC trust is restricted to this repository and environment.
4. Set environment variables `STAGING_ROLE_ARN`, `STAGING_BUCKET`, `STAGING_DISTRIBUTION`, `STAGING_URL`, and `RUM_APP_MONITOR_ID` using stack outputs.
5. Push a commit to `main` to deploy the application automatically. Alternatively, dispatch **Deploy app or roll back staging** with an empty release field for retry, or a retained release ID for rollback. Run **Publish complete OpenTree dataset** manually only for a data-generating change. Deployment results preserve the previous ID and HTTP smoke measurements as workflow artifacts.

The deployment role can only read/write this bucket's app/data/release prefixes and update this CloudFront distribution. It cannot delete objects, provision infrastructure or modify IAM. Infrastructure provisioning requires a separately authenticated administrative/setup identity.

## Before calling staging verified

- Check the real HTTPS site, all dataset dropdown choices, search, region clicks, Home and Back/Forward.
- Inspect cache hits and encoded transfer sizes on the hosted domain. The smoke report records CloudFront `X-Cache`; a first request may be a miss.
- Test an actual phone and a slow connection; the automated shared-store smoke test is not a phone/GPU test.
- Exercise a real rollback after two successful deployments.
- Confirm the S3 object URL is denied to anonymous users while CloudFront serves it.
- Confirm budget alerts and inspect the CloudWatch 5xx metric. No production traffic has been measured until these AWS checks run.

Attribution is published as `/DATA_SOURCES.txt` and source manifests. OpenTree's [data-rights statement](https://tree.opentreeoflife.org/opentree/about/licenses) specifies CC0 where not limited by pre-existing terms. This project retains provenance and uses its own rendering code, not Lifemap imagery.

References: [S3 origin access](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [compression](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html), [GitHub OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
